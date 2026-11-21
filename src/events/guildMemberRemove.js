import { Events, PermissionFlagsBits } from 'discord.js';
import { buildMemberAnnouncementEmbed } from '../utils/announcementEmbeds.js';
import { getWelcomeConfig, getUserApplications, deleteApplication } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { getGuildBirthdays, deleteBirthday } from '../utils/database.js';
import { deleteUserLevelData } from '../services/leveling/leveling.js';
import { logger } from '../utils/logger.js';
import { captureModerationAudit } from '../services/moderationAuditMirror.js';

export default {
  name: Events.GuildMemberRemove,
  once: false,
  
  async execute(member) {
    try {
        const { guild, user } = member;

        // A kick is a moderation action; ordinary voluntary departures are not.
        await captureModerationAudit(guild, {
            type: 20,
            action: 'kick',
            targetId: user.id,
            targetName: user.tag,
            details: 'Member removed from server',
        });

        // Remove departed users from any clan roster so the registry stays accurate.
        try {
            const clanKey = `guild:${guild.id}:clans`;
            const clans = await member.client.db.get(clanKey, []);
            if (Array.isArray(clans)) {
                let changed = false;
                for (const clan of clans) {
                    if (Array.isArray(clan.memberIds) && clan.memberIds.includes(user.id)) {
                        clan.memberIds = clan.memberIds.filter(userId => userId !== user.id);
                        changed = true;
                    }
                    if (clan.viceLeaderId === user.id) {
                        clan.viceLeaderId = null;
                        changed = true;
                    }
                }
                if (changed) await member.client.db.set(clanKey, clans);
            }
        } catch (error) {
            logger.warn(`Could not remove departed member ${user.id} from clan rosters: ${error.message}`);
        }

        const welcomeConfig = await getWelcomeConfig(member.client, guild.id);
        
        const goodbyeChannelId = welcomeConfig?.goodbyeChannelId;

        if (welcomeConfig?.goodbyeEnabled && goodbyeChannelId) {
            const channel = guild.channels.cache.get(goodbyeChannelId);
            if (channel?.isTextBased?.()) {
                const me = guild.members.me;
                const permissions = me ? channel.permissionsFor(me) : null;
                if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                    return;
                }

                const formatData = { user, guild, member };
                const goodbyeMessage = formatWelcomeMessage(welcomeConfig.leaveMessage || '', formatData);
                const content = [welcomeConfig.goodbyePing ? user.toString() : '', goodbyeMessage].filter(Boolean).join('\n');
                if (permissions.has(PermissionFlagsBits.EmbedLinks)) {
                    const embed = buildMemberAnnouncementEmbed(welcomeConfig.leaveEmbed || {}, formatData, {
                        color: '#D9534F',
                        title: '👋 Goodbye',
                        thumbnailUrl: user.displayAvatarURL({ extension: 'png', size: 256 })
                    });
                    await channel.send({ content: content || undefined, allowedMentions: welcomeConfig.goodbyePing ? { users: [user.id] } : { parse: [] }, embeds: [embed] });
                } else if (content) {
                    await channel.send({ content, allowedMentions: welcomeConfig.goodbyePing ? { users: [user.id] } : { parse: [] } });
                }
            }
        }

        try {
            await logEvent({
                client: member.client,
                guildId: guild.id,
                eventType: EVENT_TYPES.MEMBER_LEAVE,
                data: {
                    title: 'User left',
                    lines: [
                        `**User:** ${user.toString()} (${user.tag})`,
                        `**ID:** \`${user.id}\``,
                        `**Joined:** <t:${Math.floor((member.joinedTimestamp || Date.now()) / 1000)}:R>`,
                        `**Members:** ${guild.memberCount}`,
                    ],
                    quoted: false,
                    thumbnail: user.displayAvatarURL({ dynamic: true }),
                    userId: user.id,
                }
            });
        } catch (error) {
            logger.debug('Error logging member leave:', error);
        }

        try {
            const counters = await getServerCounters(member.client, guild.id);
            for (const counter of counters) {
                if (counter && counter.type && counter.channelId && counter.enabled !== false) {
                    await updateCounter(member.client, guild, counter);
                }
            }
        } catch (error) {
            logger.debug('Error updating counters on member leave:', error);
        }

        try {
            const birthdays = await getGuildBirthdays(member.client, guild.id);
            if (birthdays[user.id]) {
                const backupKey = `guild:${guild.id}:birthdays:left`;
                const backup = (await member.client.db.get(backupKey)) || {};
                backup[user.id] = birthdays[user.id];
                await member.client.db.set(backupKey, backup);
                await deleteBirthday(member.client, guild.id, user.id);
                logger.debug(`Birthday backed up and removed for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error handling birthday on member leave:', error);
        }

        try {
            const userApplications = await getUserApplications(member.client, guild.id, user.id);
            if (userApplications && userApplications.length > 0) {
                for (const app of userApplications) {
                    await deleteApplication(member.client, guild.id, app.id, user.id);
                }
                logger.debug(`Removed ${userApplications.length} applications for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error handling applications on member leave:', error);
        }

        try {
            await deleteUserLevelData(member.client, guild.id, user.id);
            logger.debug(`Removed leveling data for user ${user.id} in guild ${guild.id}`);
        } catch (error) {
            logger.debug('Error handling leveling data on member leave:', error);
        }
        
    } catch (error) {
        logger.error('Error in guildMemberRemove event:', error);
    }
  }
};