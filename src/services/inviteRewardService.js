import { PermissionFlagsBits } from 'discord.js';
import { getEconomyData, setEconomyData } from '../utils/economy.js';
import { logger } from '../utils/logger.js';

export const INVITE_REWARD_AMOUNT = 100000;

const inviteLocks = new Map();
const rewardLocks = new Map();

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

function makeInviteSnapshot(invites) {
    const snapshot = {};
    for (const invite of invites.values()) {
        snapshot[invite.code] = {
            uses: Number(invite.uses) || 0,
            inviterId: invite.inviter?.id || null,
        };
    }
    return snapshot;
}

export async function initializeInviteTracking(client) {
    let initialized = 0;
    let skipped = 0;

    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            await client.db.set(`guild:${guild.id}:invites`, makeInviteSnapshot(invites));
            initialized += 1;
        } catch (error) {
            skipped += 1;
            logger.warn(`Could not initialize invite tracking for guild ${guild.id}: ${error.message}`);
        }
    }

    logger.info(`Invite reward tracking initialized for ${initialized} guild(s); skipped ${skipped}.`);
    return { initialized, skipped };
}

export async function processInviteJoin(member) {
    if (!member?.guild || member.user?.bot) return;

    const { guild, client } = member;
    await withLock(inviteLocks, guild.id, async () => {
        try {
            const key = `guild:${guild.id}:invites`;
            const previous = await client.db.get(key, null);
            const currentInvites = await guild.invites.fetch();
            const snapshot = makeInviteSnapshot(currentInvites);

            // The first snapshot is only a baseline; never guess an inviter.
            if (!previous || typeof previous !== 'object') {
                await client.db.set(key, snapshot);
                return;
            }

            const usedInvite = [...currentInvites.values()]
                .filter(invite => (Number(invite.uses) || 0) > (Number(previous[invite.code]?.uses) || 0))
                .sort((a, b) => (Number(b.uses) || 0) - (Number(a.uses) || 0))[0];

            // Persist the latest counts before awarding, so repeated join events
            // cannot interpret the same invite-use increase as a second join.
            await client.db.set(key, snapshot);

            const inviterId = usedInvite?.inviter?.id || previous[usedInvite?.code]?.inviterId;
            if (!usedInvite || !inviterId || inviterId === member.id) return;

            const inviter = await client.users.fetch(inviterId).catch(() => null);
            if (!inviter || inviter.bot) return;

            await awardInviteReward(client, guild, member, inviter);
        } catch (error) {
            logger.warn(`Invite reward processing failed for new member ${member.id} in guild ${guild.id}: ${error.message}`);
        }
    });
}

async function awardInviteReward(client, guild, invitedMember, inviter) {
    return withLock(rewardLocks, invitedMember.id, async () => {
        const claimKey = `global:invite_reward_claim:${invitedMember.id}`;
        const existingClaim = await client.db.get(claimKey, null);
        if (existingClaim) return false;

        const pendingClaim = {
            status: 'processing',
            invitedUserId: invitedMember.id,
            inviterId: inviter.id,
            guildId: guild.id,
            amount: INVITE_REWARD_AMOUNT,
            createdAt: new Date().toISOString(),
        };

        // Claim the invited member ID before touching the wallet. This permanent
        // marker prevents a leave/rejoin or duplicate gateway event from paying twice.
        await client.db.set(claimKey, pendingClaim);
        const savedClaim = await client.db.get(claimKey, null);
        if (!savedClaim) {
            logger.error(`Could not persist invite reward claim for invited member ${invitedMember.id}; reward skipped.`);
            return false;
        }

        let credited = false;
        try {
            const economy = await getEconomyData(client, guild.id, inviter.id);
            const nextWallet = (Number(economy.wallet) || 0) + INVITE_REWARD_AMOUNT;
            if (!Number.isSafeInteger(nextWallet)) {
                throw new Error('Inviter wallet would exceed the safe integer limit.');
            }

            economy.wallet = nextWallet;
            const saved = await setEconomyData(client, guild.id, inviter.id, economy);
            if (!saved) throw new Error('Could not save inviter wallet balance.');
            credited = true;

            await client.db.set(claimKey, {
                ...pendingClaim,
                status: 'awarded',
                newWalletBalance: nextWallet,
                awardedAt: new Date().toISOString(),
            });

            const amountText = INVITE_REWARD_AMOUNT.toLocaleString('en-US');
            const balanceText = nextWallet.toLocaleString('en-US');

            try {
                await inviter.send(
                    `🎉 You earned **${amountText} bCash** for inviting <@${invitedMember.id}> to **${guild.name}**! Your new wallet balance is **${balanceText} bCash**.`
                );
            } catch (error) {
                logger.info(`Could not DM invite reward confirmation to inviter ${inviter.id}: ${error.message}`);
            }

            const channelId = await client.db.get(`guild:${guild.id}:invite_reward_channel`, null);
            if (channelId) {
                try {
                    const channel = await guild.channels.fetch(channelId);
                    const botMember = guild.members.me;
                    const permissions = channel?.isTextBased?.() && botMember ? channel.permissionsFor(botMember) : null;
                    if (permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                        await channel.send({
                            content: `🎉 <@${inviter.id}> earned **${amountText} bCash** for inviting <@${invitedMember.id}>!`,
                            allowedMentions: { users: [inviter.id, invitedMember.id] },
                        });
                    }
                } catch (error) {
                    logger.warn(`Could not post invite reward announcement in guild ${guild.id}: ${error.message}`);
                }
            }

            logger.info(`Invite reward awarded: ${amountText} bCash to ${inviter.id} for invited member ${invitedMember.id} in guild ${guild.id}.`);
            return true;
        } catch (error) {
            // If the wallet write did not complete, release the claim so a later
            // legitimate retry can process it. Keep it if credit already happened.
            if (!credited) {
                await client.db.delete(claimKey).catch(() => null);
            }
            throw error;
        }
    });
}
