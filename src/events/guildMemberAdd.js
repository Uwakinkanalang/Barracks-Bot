import { Events, PermissionFlagsBits } from 'discord.js';
import { buildMemberAnnouncementEmbed } from '../utils/announcementEmbeds.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { setBirthday as dbSetBirthday } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { processInviteReward } from '../utils/inviteRewards.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,
  
  async execute(member) {
    try {
        const { guild, user } = member;

        // Keep invite reward failures isolated from the normal onboarding flow.
        await processInviteReward(member);
        
        const config = await getGuildConfig(member.client, guild.id);
        
        const welcomeConfig = await getWelcomeConfig(member.client, guild.id);
        
        const welcomeChannelId = welcomeConfig.channelId || '1137703586730618961';

        if (welcomeConfig.enabled && welcomeChannelId) {
            const channel = guild.channels.cache.get(welcomeChannelId);
            const me = guild.members.me;
            const permissions = channel?.isTextBased?.() && me ? channel.permissionsFor(me) : null;
            if (permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                const formatData = { user, guild, member };
                const message = formatWelcomeMessage(welcomeConfig.welcomeMessage || '', formatData);
                const content = [welcomeConfig.welcomePing ? user.toString() : '', message].filter(Boolean).join('\n');
                if (permissions.has(PermissionFlagsBits.EmbedLinks)) {
                    const embed = buildMemberAnnouncementEmbed(welcomeConfig.welcomeEmbed || {}, formatData, {
                        color: '#556B2F',
                        title: '🎉 Welcome!',
                        thumbnailUrl: user.displayAvatarURL({ extension: 'png', size: 256 }),
                        imageUrl: welcomeConfig.welcomeImage || ''
                    });
                    await channel.send({ content: content || undefined, embeds: [embed], allowedMentions: welcomeConfig.welcomePing ? { users: [user.id] } : { parse: [] } });
                } else if (content) {
                    await channel.send({ content, allowedMentions: welcomeConfig.welcomePing ? { users: [user.id] } : { parse: [] } });
                }
            }
        }
        
        if (welcomeConfig?.roleIds && welcomeConfig.roleIds.length > 0) {
            const delay = welcomeConfig.autoRoleDelay || 0;
            const singleRoleId = welcomeConfig.roleIds[0];
            
            if (delay > 0) {
                const timeout = setTimeout(async () => {
                    const role = guild.roles.cache.get(singleRoleId);
                    if (role) {
                        await assignRoleSafely(member, role);
                    }
                }, delay * 1000);
                if (typeof timeout.unref === 'function') {
                    timeout.unref();
                }
            } else {
                const role = guild.roles.cache.get(singleRoleId);
                if (role) {
                    await assignRoleSafely(member, role);
                }
            }
        }
        
        if (config?.verification?.enabled || config?.verification?.autoVerify?.enabled) {
            await handleVerification(member, guild, config.verification, member.client);
        }

        try {
            await logEvent({
                client: member.client,
                guildId: guild.id,
                eventType: EVENT_TYPES.MEMBER_JOIN,
                data: {
                    title: 'User joined',
                    lines: [
                        `**User:** ${user.toString()} (${user.displayName !== user.username ? `@${user.displayName}` : user.tag})`,
                        `**ID:** \`${user.id}\``,
                        `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
                        `**Members:** ${guild.memberCount}`,
                    ],
                    quoted: false,
                    thumbnail: user.displayAvatarURL({ dynamic: true }),
                    userId: user.id,
                }
            });
        } catch (error) {
            logger.debug('Error logging member join:', error);
        }

        try {
            const counters = await getServerCounters(member.client, guild.id);
            for (const counter of counters) {
                if (counter && counter.type && counter.channelId && counter.enabled !== false) {
                    await updateCounter(member.client, guild, counter);
                }
            }
        } catch (error) {
            logger.debug('Error updating counters on member join:', error);
        }

        try {
            const backupKey = `guild:${guild.id}:birthdays:left`;
            const backup = (await member.client.db.get(backupKey)) || {};
            if (backup[user.id]) {
                const { month, day } = backup[user.id];
                await dbSetBirthday(member.client, guild.id, user.id, month, day);
                delete backup[user.id];
                await member.client.db.set(backupKey, backup);
                logger.debug(`Birthday restored for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error restoring birthday on member join:', error);
        }
        
    } catch (error) {
        logger.error('Error in guildMemberAdd event:', error);
    }
  }
};

async function handleVerification(member, guild, verificationConfig, client) {
    const { autoVerifyOnJoin } = await import('../services/verificationService.js');
    
    try {
        const result = await autoVerifyOnJoin(client, guild, member, verificationConfig);
        
        if (result.autoVerified) {
            logger.info('User auto-verified on join', {
                guildId: guild.id,
                userId: member.id,
                userTag: member.user.tag,
                roleName: result.roleName,
                criteria: result.criteria
            });
        } else {
            logger.debug('User not auto-verified on join', {
                guildId: guild.id,
                userId: member.id,
                reason: result.reason
            });
        }

    } catch (error) {
        logger.error('Error in auto-verification for member', {
            guildId: guild.id,
            userId: member.id,
            userTag: member.user.tag,
            error: error.message
        });
    }
}

async function assignRoleSafely(member, role) {
    try {
        await member.roles.add(role);
    } catch (error) {
        logger.warn(`Failed to assign role ${role.id} to member ${member.id}:`, error);
    }
}

export async function buildWelcomeCard(member, backgroundUrl, memberCount) {
    if (typeof backgroundUrl !== 'string' || (!backgroundUrl.startsWith('https://') && !backgroundUrl.startsWith('http://'))) {
        throw new Error('Welcome Image must be a publicly accessible HTTP or HTTPS image URL. Re-upload the image in the welcome dashboard.');
    }

    const imageHeaders = {
        'User-Agent': 'Barracks-Bot/2.1',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
    const [backgroundResponse, avatarResponse] = await Promise.all([
        fetch(backgroundUrl, { headers: imageHeaders, redirect: 'follow' }),
        fetch(avatarUrl, { headers: imageHeaders, redirect: 'follow' }),
    ]);
    if (!backgroundResponse.ok) {
        throw new Error(`Welcome background download failed (HTTP ${backgroundResponse.status}). Re-upload the camouflage image in /greet dashboard.`);
    }
    if (!avatarResponse.ok) {
        throw new Error(`Member avatar download failed (HTTP ${avatarResponse.status}).`);
    }

    const backgroundType = backgroundResponse.headers.get('content-type') || 'image/jpeg';
    const avatarType = avatarResponse.headers.get('content-type') || 'image/png';
    if (!backgroundType.startsWith('image/') || !avatarType.startsWith('image/')) {
        throw new Error('Welcome background and member avatar must be image files.');
    }

    const background = Buffer.from(await backgroundResponse.arrayBuffer()).toString('base64');
    const avatar = Buffer.from(await avatarResponse.arrayBuffer()).toString('base64');
    const displayName = escapeSvgText(member.displayName || member.user.username);
    const memberNumber = Number(memberCount).toLocaleString('en-US');
    const nameFontSize = Math.max(30, Math.min(52, Math.floor(850 / Math.max(displayName.length, 1))));

    // Wide, centered neon welcome banner inspired by the supplied reference.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="580" viewBox="0 0 1200 580">
      <defs>
        <clipPath id="avatarClip"><circle cx="600" cy="184" r="108"/></clipPath>
        <linearGradient id="overlay" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#08051d" stop-opacity=".28"/>
          <stop offset=".58" stop-color="#10051f" stop-opacity=".20"/>
          <stop offset="1" stop-color="#080515" stop-opacity=".86"/>
        </linearGradient>
        <radialGradient id="pinkGlow">
          <stop offset=".58" stop-color="#ff31c8" stop-opacity=".04"/>
          <stop offset=".78" stop-color="#ff31c8" stop-opacity=".48"/>
          <stop offset="1" stop-color="#ff31c8" stop-opacity="0"/>
        </radialGradient>
        <filter id="neon" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="15"/>
        </filter>
        <filter id="textShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="blur"/>
          <feOffset dy="3" result="offset"/>
          <feComponentTransfer><feFuncA type="linear" slope=".8"/></feComponentTransfer>
          <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <image x="0" y="0" width="1200" height="580" preserveAspectRatio="xMidYMid slice" xlink:href="data:${backgroundType};base64,${background}"/>
      <rect width="1200" height="580" fill="url(#overlay)"/>
      <ellipse cx="600" cy="184" rx="190" ry="190" fill="url(#pinkGlow)"/>
      <circle cx="600" cy="184" r="125" fill="none" stroke="#ff36d2" stroke-width="18" opacity=".85" filter="url(#neon)"/>
      <circle cx="600" cy="184" r="116" fill="#130a24" stroke="#ff8ae9" stroke-width="8"/>
      <image x="492" y="76" width="216" height="216" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)" xlink:href="data:${avatarType};base64,${avatar}"/>
      <circle cx="600" cy="184" r="110" fill="none" stroke="#fff0ff" stroke-width="5"/>
      <text x="600" y="405" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="116" font-weight="900" letter-spacing="1" fill="#ffffff" stroke="#180c2a" stroke-width="8" paint-order="stroke" filter="url(#textShadow)">WELCOME</text>
      <text x="600" y="463" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${nameFontSize}" font-weight="900" letter-spacing="2" fill="#fff4ff" stroke="#180c2a" stroke-width="6" paint-order="stroke" filter="url(#textShadow)">${displayName}</text>
      <text x="600" y="510" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="27" font-weight="800" letter-spacing="4" fill="#ffd8fa" stroke="#180c2a" stroke-width="4" paint-order="stroke">MEMBER #${memberNumber}</text>
    </svg>`;
    return Buffer.from(svg, 'utf8');
}

function escapeSvgText(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[character]);
}

async function sendStandardWelcome(channel, data) {
    const { messageContent, welcomeMessage, canEmbed, embedTitle, embedFooter, welcomeConfig, user, guild } = data;
    if (!canEmbed) {
        await channel.send({ content: messageContent || welcomeMessage });
        return;
    }
    const embed = new EmbedBuilder()
        .setColor(welcomeConfig.welcomeEmbed?.color || getColor('success'))
        .setTitle(embedTitle)
        .setDescription(welcomeMessage)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
            { name: 'Member Count', value: guild.memberCount.toString(), inline: true }
        )
        .setTimestamp()
        .setFooter({ text: embedFooter });
    await channel.send({ content: messageContent, embeds: [embed] });
}
