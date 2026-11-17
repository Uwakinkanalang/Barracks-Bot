import { Events, EmbedBuilder, PermissionFlagsBits, AttachmentBuilder } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { setBirthday as dbSetBirthday } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { processInviteReward } from '../utils/inviteRewards.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

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
        
        const welcomeChannelId = welcomeConfig?.channelId;

        if (welcomeConfig?.enabled && welcomeChannelId) {
            const channel = guild.channels.cache.get(welcomeChannelId);
            const me = guild.members.me;
            const permissions = channel?.isTextBased?.() && me ? channel.permissionsFor(me) : null;
            // Skip only the welcome message if permissions are missing; the rest of the
            // join pipeline (auto-role, verification, logging, counters) must still run.
            if (permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                const formatData = { user, guild, member };
                const welcomeMessage = formatWelcomeMessage(
                    welcomeConfig.welcomeMessage || welcomeConfig.welcomeEmbed?.description || botConfig.welcome?.defaultWelcomeMessage || 'Welcome {user} to {server}!',
                    formatData
                );

                const messageContent = welcomeConfig.welcomePing ? user.toString() : null;

                const embedTitle = formatWelcomeMessage(
                    welcomeConfig.welcomeEmbed?.title || '🎉 Welcome!',
                    formatData
                );
                const embedFooter = welcomeConfig.welcomeEmbed?.footer
                    ? formatWelcomeMessage(welcomeConfig.welcomeEmbed.footer, formatData)
                    : `Welcome to ${guild.name}!`;

                const canEmbed = permissions.has(PermissionFlagsBits.EmbedLinks);
                const cardBackground = welcomeConfig.welcomeImage || welcomeConfig.welcomeEmbed?.image?.url;

                // When a welcome background is configured, send a personalized military-style
                // welcome card as a file. The background is uploaded through /greet dashboard.
                if (cardBackground) {
                    try {
                        const card = await buildWelcomeCard(member, cardBackground, guild.memberCount);
                        const cardAttachment = new AttachmentBuilder(card, { name: 'barracks-welcome-card.png' });
                        const welcomeEmbed = new EmbedBuilder()
                            .setColor('#59633B')
                            .setAuthor({ name: 'Welcome to Barracks' })
                            .setThumbnail('https://cdn.discordapp.com/attachments/1563246823018336416/1563262829165936822/barrack-icon-rankup.gif')
                            .setDescription(
                                '• Read rules at <#1137696545890893904>\n' +
                                '• Take your roles at <#1325091032697798727>\n' +
                                '• After that, you can chat with us here <#1137695061501558905>\n\n' +
                                'Remember to always prioritize having an enjoyable experience, Barracks! <a:dancehotdog:1540375739453407284>'
                            )
                            .setImage('attachment://barracks-welcome-card.png')
                            .setFooter({ text: `We already have ${guild.memberCount} members` });
                        await channel.send({
                            content: `Welcome our new member, **${user.toString()}**`,
                            embeds: [welcomeEmbed],
                            files: [cardAttachment],
                            allowedMentions: { users: [user.id] },
                        });
                    } catch (cardError) {
                        logger.warn('Welcome card rendering failed; using the standard welcome embed:', cardError);
                        await sendStandardWelcome(channel, {
                            messageContent, welcomeMessage, canEmbed, embedTitle, embedFooter,
                            welcomeConfig, user, guild
                        });
                    }
                } else if (!canEmbed) {
                    await channel.send({
                        content: messageContent || welcomeMessage
                    });
                } else {
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
                    
                    if (welcomeConfig.welcomeImage) {
                        embed.setImage(welcomeConfig.welcomeImage);
                    } else if (welcomeConfig.welcomeEmbed?.image?.url) {
                        embed.setImage(welcomeConfig.welcomeEmbed.image.url);
                    }
                    
                    await channel.send({ 
                        content: messageContent,
                        embeds: [embed] 
                    });
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

async function buildWelcomeCard(member, backgroundUrl, memberCount) {
    const [backgroundResponse, avatarResponse] = await Promise.all([
        fetch(backgroundUrl),
        fetch(member.user.displayAvatarURL({ extension: 'png', size: 256 })),
    ]);
    if (!backgroundResponse.ok || !avatarResponse.ok) {
        throw new Error('Could not download the welcome background or member avatar.');
    }

    const backgroundType = backgroundResponse.headers.get('content-type') || 'image/jpeg';
    const avatarType = avatarResponse.headers.get('content-type') || 'image/png';
    if (!backgroundType.startsWith('image/') || !avatarType.startsWith('image/')) {
        throw new Error('Welcome background and avatar must be image files.');
    }

    const background = Buffer.from(await backgroundResponse.arrayBuffer()).toString('base64');
    const avatar = Buffer.from(await avatarResponse.arrayBuffer()).toString('base64');
    const rawDisplayName = member.displayName || member.user.username;
    const displayName = escapeSvgText(rawDisplayName);
    const nameFontSize = Math.max(30, Math.min(52, Math.floor(1000 / Math.max(rawDisplayName.length, 1))));
    const memberNumber = Number(memberCount).toLocaleString('en-US');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="670" viewBox="0 0 1200 670">
      <defs>
        <clipPath id="avatarClip"><circle cx="600" cy="292" r="112"/></clipPath>
        <linearGradient id="shade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#10150c" stop-opacity=".38"/><stop offset="1" stop-color="#10150c" stop-opacity=".76"/></linearGradient>
        <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter>
      </defs>
      <image x="0" y="0" width="1200" height="670" preserveAspectRatio="xMidYMid slice" xlink:href="data:${backgroundType};base64,${background}"/>
      <rect width="1200" height="670" fill="#17200f" opacity=".18"/>
      <path d="M0 0H1200V670H0Z" fill="url(#shade)"/>
      <rect x="34" y="34" width="1132" height="602" rx="26" fill="none" stroke="#d0c79e" stroke-width="5" opacity=".86"/>
      <path d="M75 88H1125M75 582H1125" stroke="#d0c79e" stroke-width="4" opacity=".75"/>
      <g fill="#d8d0ad" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700">
        <text x="600" y="126" font-size="25" letter-spacing="12">BARRACKS • NEW RECRUIT</text>
      </g>
      <circle cx="600" cy="292" r="128" fill="#1c2815" opacity=".75" filter="url(#shadow)"/>
      <circle cx="600" cy="292" r="120" fill="#d0c79e" stroke="#26351d" stroke-width="9"/>
      <image x="488" y="180" width="224" height="224" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)" xlink:href="data:${avatarType};base64,${avatar}"/>
      <circle cx="600" cy="292" r="116" fill="none" stroke="#e3dcc0" stroke-width="5"/>
      <g font-family="Arial, Helvetica, sans-serif" fill="#fff" text-anchor="start">
        <text x="600" y="468" text-anchor="middle" font-size="78" font-weight="900" letter-spacing="2" fill="#fff7dc" stroke="#18210f" stroke-width="9" paint-order="stroke">Welcome</text>
        <text x="600" y="535" text-anchor="middle" font-size="${nameFontSize}" font-weight="900" fill="#ffffff" stroke="#18210f" stroke-width="8" paint-order="stroke">${displayName}</text>
        <text x="600" y="595" text-anchor="middle" font-size="28" font-weight="700" fill="#e3dcc0" stroke="#18210f" stroke-width="4" paint-order="stroke">MEMBER #${memberNumber}</text>
      </g>
      <g fill="#d0c79e"><path d="M1015 510l18 38 42 6-30 29 7 41-37-20-37 20 7-41-30-29 42-6z" opacity=".9"/></g>
      <text x="600" y="610" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="#e8e1c5" letter-spacing="5">HONOR • COURAGE • COMMITMENT</text>
    </svg>`;
    const image = await loadImage(Buffer.from(svg, 'utf8'));
    const canvas = createCanvas(1200, 670);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 1200, 670);
    return canvas.toBuffer('image/png');
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
