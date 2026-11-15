import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getEconomyData, setEconomyData } from './economy.js';
import { getEconomyKey } from './database.js';
import { logger } from './logger.js';

export const INVITE_REWARD_GUILD_ID = '1137695060096471160';
export const INVITE_REWARD_AMOUNT = 100000;

// Explicit cache: keys route to PostgreSQL cache_data with no expiry (unlike temp: keys).
const snapshotKey = guildId => `cache:invite_rewards:${guildId}:snapshot`;
const claimKey = (guildId, memberId) => `cache:invite_rewards:${guildId}:claims:${memberId}`;

const guildLocks = new Map();
const inviterLocks = new Map();

async function withLock(locks, key, callback) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function toSnapshot(invites) {
  return Object.fromEntries([...invites.values()].map(invite => [invite.code, {
    uses: Number(invite.uses || 0),
    inviterId: invite.inviter?.id || null,
  }]));
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.invites || typeof raw.invites !== 'object') {
    return null;
  }
  return {
    invites: raw.invites,
    pendingInviters: Array.isArray(raw.pendingInviters) ? raw.pendingInviters.filter(Boolean) : [],
  };
}

async function canTrack(guild) {
  const me = guild.members.me;
  return Boolean(me?.permissions.has(PermissionFlagsBits.ManageGuild));
}

export async function initializeInviteTracking(client) {
  const guild = client.guilds.cache.get(INVITE_REWARD_GUILD_ID);
  if (!guild) return;
  if (client.db?.getStatus?.().isDegraded) {
    logger.error('Invite rewards disabled: persistent database is unavailable; durable one-time claims cannot be guaranteed.');
    return;
  }

  try {
    if (!(await canTrack(guild))) {
      logger.warn('Invite rewards disabled: Barracks-Bot needs Manage Server permission to inspect invites.');
      return;
    }
    const invites = await guild.invites.fetch();
    const existing = normalizeState(await client.db.get(snapshotKey(guild.id), null));
    // Startup establishes a fresh baseline. Preserve queued increments gathered
    // before a restart, but do not infer joins that happened while the bot was offline.
    const state = {
      invites: toSnapshot(invites),
      pendingInviters: existing?.pendingInviters || [],
    };
    await client.db.set(snapshotKey(guild.id), state);
    logger.info(`Barracks invite tracking initialized (${invites.size} invite codes).`);
  } catch (error) {
    logger.warn('Could not initialize Barracks invite tracking:', error.message);
  }
}

export async function processInviteReward(member) {
  const { guild, user, client } = member;
  if (guild.id !== INVITE_REWARD_GUILD_ID || user.bot) return;

  try {
    if (client.db?.isDegraded?.()) {
      logger.error('Invite reward skipped because the database is in non-persistent degraded mode.');
      return;
    }
    if (!(await canTrack(guild))) return;

    await withLock(guildLocks, guild.id, async () => {
      const key = snapshotKey(guild.id);
      const previous = normalizeState(await client.db.get(key, null));
      const fetched = await guild.invites.fetch();
      const current = toSnapshot(fetched);

      // Never guess an inviter on first run or after tracking state is unavailable.
      if (!previous) {
        await client.db.set(key, { invites: current, pendingInviters: [] });
        return;
      }

      const pendingInviters = [...previous.pendingInviters];
      const increases = [];
      for (const [code, invite] of Object.entries(current)) {
        const old = previous.invites[code];
        const increase = Math.max(0, invite.uses - Number(old?.uses || 0));
        const inviterId = invite.inviterId || old?.inviterId;
        if (increase > 0 && inviterId) increases.push({ inviterId, increase });
      }

      // Discord exposes aggregate invite-use counts, not a member-to-invite
      // mapping. If several inviters' codes increased between fetches, attribution
      // is ambiguous; skip that batch instead of paying the wrong person.
      const changedInviters = [...new Set(increases.map(item => item.inviterId))];
      if (changedInviters.length === 1) {
        const inviterId = changedInviters[0];
        const totalUses = increases.reduce((sum, item) => sum + item.increase, 0);
        for (let i = 0; i < totalUses; i += 1) pendingInviters.push(inviterId);
      } else if (changedInviters.length > 1) {
        logger.warn(`Skipped ambiguous invite batch in Barracks: multiple inviter codes increased for join event ${user.id}.`);
      }

      // Persist the new counts and any unassigned invite-use increments before
      // consuming one. This serializes concurrent GuildMemberAdd events in-process.
      await client.db.set(key, { invites: current, pendingInviters });
      const inviterId = pendingInviters.shift();
      await client.db.set(key, { invites: current, pendingInviters });
      if (!inviterId || inviterId === user.id) return;

      const inviter = await guild.members.fetch(inviterId).catch(() => null);
      if (!inviter || inviter.user.bot) return;
      await awardOnce(client, guild, member, inviter);
    });
  } catch (error) {
    logger.warn(`Barracks invite reward processing failed for ${user.id}:`, error.message);
  }
}

async function awardOnce(client, guild, invitedMember, inviter) {
  return withLock(inviterLocks, inviter.id, async () => {
    const claimKeyValue = claimKey(guild.id, invitedMember.id);
    const pool = client.db?.db?.pool;
    if (!pool || typeof pool.connect !== 'function' || client.db?.isDegraded?.()) {
      throw new Error('Persistent PostgreSQL transaction support is required for invite rewards.');
    }

    // Prime defaults through the existing economy normalizer. The transaction
    // then locks the wallet row and applies both the claim and credit atomically.
    const economyDefaults = await getEconomyData(client, guild.id, inviter.id);
    const walletKey = getEconomyKey(guild.id, inviter.id);
    const { pgConfig } = await import('../config/database/postgres.js');
    const connection = await pool.connect();
    let newWalletBalance = null;

    try {
      await connection.query('BEGIN');

      const claim = {
        status: 'paid',
        guildId: guild.id,
        invitedUserId: invitedMember.id,
        inviterId: inviter.id,
        amount: INVITE_REWARD_AMOUNT,
        createdAt: new Date().toISOString(),
      };
      const claimInsert = await connection.query(
        `INSERT INTO ${pgConfig.tables.cache_data} (key, value, expires_at)
         VALUES ($1, $2::jsonb, NULL)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [claimKeyValue, JSON.stringify({ ...claim, status: 'processing' })],
      );

      if (claimInsert.rowCount === 0) {
        await connection.query('ROLLBACK');
        return false;
      }

      // global:economy keys are stored in temp_data by the existing key router.
      // Advisory locking also covers the first-credit case where no row exists.
      await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [walletKey]);
      await connection.query(
        `INSERT INTO ${pgConfig.tables.temp_data} (key, value, expires_at)
         VALUES ($1, $2::jsonb, NULL)
         ON CONFLICT (key) DO NOTHING`,
        [walletKey, JSON.stringify(economyDefaults)],
      );

      const walletResult = await connection.query(
        `SELECT value FROM ${pgConfig.tables.temp_data} WHERE key = $1 FOR UPDATE`,
        [walletKey],
      );
      if (!walletResult.rows[0]) {
        throw new Error('Could not lock the inviter wallet row.');
      }

      const economy = { ...economyDefaults, ...walletResult.rows[0].value };
      const currentWallet = Number(economy.wallet) || 0;
      newWalletBalance = currentWallet + INVITE_REWARD_AMOUNT;
      if (!Number.isSafeInteger(newWalletBalance)) {
        throw new Error('Inviter wallet would exceed the safe integer limit.');
      }

      economy.wallet = newWalletBalance;
      await connection.query(
        `UPDATE ${pgConfig.tables.temp_data}
         SET value = $2::jsonb, expires_at = NULL
         WHERE key = $1`,
        [walletKey, JSON.stringify(economy)],
      );
      await connection.query(
        `UPDATE ${pgConfig.tables.cache_data}
         SET value = $2::jsonb
         WHERE key = $1`,
        [claimKeyValue, JSON.stringify({
          ...claim,
          status: 'paid',
          newWalletBalance,
          awardedAt: new Date().toISOString(),
        })],
      );

      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      connection.release();
    }

    const amountText = INVITE_REWARD_AMOUNT.toLocaleString('en-US');
    const balanceText = newWalletBalance.toLocaleString('en-US');
    const rewardEmbed = new EmbedBuilder()
      .setColor(0xD4AF37)
      .setTitle('🎉 Invite Reward Received!')
      .setDescription('Thanks for helping grow the **Barracks** community! Your reward has been added to your wallet.')
      .addFields(
        { name: '💰 Reward Earned', value: `**+${amountText} bCash**`, inline: true },
        { name: '🪖 New Recruit', value: `<@${invitedMember.id}>`, inline: true },
        { name: '💳 New Wallet Balance', value: `**${balanceText} bCash**`, inline: false },
      )
      .setFooter({ text: 'Barracks • Invite Rewards' })
      .setTimestamp();

    await inviter.send({
      embeds: [rewardEmbed],
    })
      .catch(error => logger.info(`Could not DM invite reward confirmation to ${inviter.id}: ${error.message}`));

    const channelId = await client.db.get(`guild:${guild.id}:invite_reward_channel`, null);
    if (channelId) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      const permissions = channel?.isTextBased?.() && guild.members.me
        ? channel.permissionsFor(guild.members.me)
        : null;
      if (permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        await channel.send({
          content: `🎉 <@${inviter.id}> earned **${amountText} bCash** for inviting <@${invitedMember.id}>!`,
          allowedMentions: { users: [inviter.id, invitedMember.id] },
        }).catch(error => logger.warn(`Could not post invite reward announcement: ${error.message}`));
      }
    }

    logger.info(`Paid ${amountText} bCash invite reward to ${inviter.id} for invited member ${invitedMember.id}.`);
    return true;
  });
}
