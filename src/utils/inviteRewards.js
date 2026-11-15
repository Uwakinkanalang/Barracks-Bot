import { PermissionFlagsBits } from 'discord.js';
import { addMoney } from './economy.js';
import { logger } from './logger.js';

export const INVITE_REWARD_GUILD_ID = '1137695060096471160';
export const INVITE_REWARD_AMOUNT = 100000;

const snapshotKey = guildId => `temp:invite_snapshot:${guildId}`;
const claimKey = (guildId, memberId) => `temp:invite_reward_claim:${guildId}:${memberId}`;

function toSnapshot(invites) {
  return Object.fromEntries(invites.map(invite => [invite.code, {
    uses: Number(invite.uses || 0),
    inviterId: invite.inviterId || invite.inviter?.id || null,
  }]));
}

export async function initializeInviteTracking(client) {
  const guild = client.guilds.cache.get(INVITE_REWARD_GUILD_ID);
  if (!guild) return;
  try {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      logger.warn('Invite rewards disabled: Barracks-Bot needs Manage Server permission to inspect invites.');
      return;
    }
    const invites = await guild.invites.fetch();
    const snapshot = toSnapshot([...invites.values()]);
    await client.db.set(snapshotKey(guild.id), snapshot);
    client.inviteSnapshots ??= new Map();
    client.inviteSnapshots.set(guild.id, snapshot);
    logger.info(`Invite tracking initialized for Barracks Server (${invites.size} invite codes).`);
  } catch (error) {
    logger.warn('Could not initialize Barracks invite tracking:', error.message);
  }
}

export async function processInviteReward(member) {
  const { guild, user, client } = member;
  if (guild.id !== INVITE_REWARD_GUILD_ID || user.bot) return;
  try {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    client.inviteSnapshots ??= new Map();
    const previous = client.inviteSnapshots.get(guild.id)
      || await client.db.get(snapshotKey(guild.id), {});
    const fetched = await guild.invites.fetch();
    const current = toSnapshot([...fetched.values()]);
    const increases = Object.entries(current)
      .map(([code, invite]) => ({
        code,
        inviterId: invite.inviterId,
        increase: invite.uses - Number(previous?.[code]?.uses || 0),
      }))
      .filter(invite => invite.increase > 0 && invite.inviterId)
      .sort((a, b) => b.increase - a.increase);
    client.inviteSnapshots.set(guild.id, current);
    await client.db.set(snapshotKey(guild.id), current);

    // Vanity URL joins and joins without an attributable invite do not earn rewards.
    if (!increases.length) return;
    const inviterId = increases[0].inviterId;
    if (!inviterId || inviterId === user.id) return;
    const claim = claimKey(guild.id, user.id);
    if (await client.db.get(claim, false)) return;
    const inviter = await guild.members.fetch(inviterId).catch(() => null);
    if (!inviter || inviter.user.bot) return;

    // Claim each joining member once, even if they leave and rejoin.
    await client.db.set(claim, { inviterId, claimedAt: new Date().toISOString(), status: 'pending' });
    try {
      const result = await addMoney(client, guild.id, inviterId, INVITE_REWARD_AMOUNT, 'wallet');
      await client.db.set(claim, {
        inviterId,
        claimedAt: new Date().toISOString(),
        status: 'paid',
        amount: INVITE_REWARD_AMOUNT,
      });
      await inviter.send(
        `🎉 **Invite reward received!**\n\nYou earned **${INVITE_REWARD_AMOUNT.toLocaleString()} bCash** for inviting **${user.tag}** to Barracks.\nYour new wallet balance is **${Number(result.newBalance || 0).toLocaleString()} bCash**.`
      ).catch(() => null);
      logger.info(`Paid ${INVITE_REWARD_AMOUNT} bCash invite reward to ${inviterId} for member ${user.id}.`);
    } catch (error) {
      await client.db.delete(claim).catch(() => null);
      throw error;
    }
  } catch (error) {
    logger.warn(`Barracks invite reward processing failed for ${user.id}:`, error.message);
  }
}
