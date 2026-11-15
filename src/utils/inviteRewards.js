import { PermissionFlagsBits } from 'discord.js';
import { getEconomyData, setEconomyData } from './economy.js';
import { getEconomyKey } from './database.js';
import { logger } from './logger.js';

export const INVITE_REWARD_GUILD_ID = '1137695060096471160';
export const INVITE_REWARD_AMOUNT = 100000;

const snapshotKey = guildId => `guild:${guildId}:invite_rewards:snapshot`;
const claimKey = (guildId, memberId) => `guild:${guildId}:invite_rewards:claims:${memberId}`;

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
    const key = claimKey(guild.id, invitedMember.id);
    const existing = await client.db.get(key, null);
    if (existing) {
      // A processing claim is deliberately not retried automatically: the prior
      // process may have written the wallet before crashing. Retrying could double-pay.
      if (existing.status === 'processing') {
        logger.error(`Invite reward claim for ${invitedMember.id} is pending manual reconciliation; refusing a possible duplicate credit.`);
      }
      return false;
    }

    const claim = {
      status: 'processing',
      guildId: guild.id,
      invitedUserId: invitedMember.id,
      inviterId: inviter.id,
      amount: INVITE_REWARD_AMOUNT,
      createdAt: new Date().toISOString(),
    };
    await client.db.set(key, claim);
    const persisted = await client.db.get(key, null);
    if (!persisted || persisted.inviterId !== inviter.id) {
      throw new Error('Could not verify the durable one-time invite claim; reward was not credited.');
    }

    // Serialize credits to the same inviter so simultaneous invite rewards do not
    // overwrite one another's global wallet balance.
    const economy = await getEconomyData(client, guild.id, inviter.id);
    const currentWallet = Number(economy.wallet) || 0;
    const nextWallet = currentWallet + INVITE_REWARD_AMOUNT;
    if (!Number.isSafeInteger(nextWallet)) {
      throw new Error('Inviter wallet would exceed the safe integer limit.');
    }

    economy.wallet = nextWallet;
    const saved = await setEconomyData(client, guild.id, inviter.id, economy);
    if (!saved) {
      // Keep the processing claim for review rather than risking duplicate payment
      // if the storage layer returned an ambiguous result.
      throw new Error('Wallet save failed or returned an ambiguous result; claim retained for manual reconciliation.');
    }

    const storedEconomy = await client.db.get(getEconomyKey(guild.id, inviter.id), null);
    if (!storedEconomy || Number(storedEconomy.wallet) !== nextWallet) {
      throw new Error('Wallet balance read-back did not match the expected reward; claim retained for manual reconciliation.');
    }

    await client.db.set(key, {
      ...claim,
      status: 'paid',
      newWalletBalance: nextWallet,
      awardedAt: new Date().toISOString(),
    });

    const amountText = INVITE_REWARD_AMOUNT.toLocaleString('en-US');
    const balanceText = nextWallet.toLocaleString('en-US');
    await inviter.send(
      `🎉 **Invite reward received!** You earned **${amountText} bCash** for inviting **${invitedMember.user.tag}** to Barracks. Your new wallet balance is **${balanceText} bCash**.`
    ).catch(error => logger.info(`Could not DM invite reward confirmation to ${inviter.id}: ${error.message}`));

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
