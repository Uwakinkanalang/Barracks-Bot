// xpSystem.js

import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData } from './leveling.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { Mutex } from '../../utils/mutex.js';
import { wrapServiceBoundary } from '../../utils/errorHandler.js';

/**
 * Award XP to a member. Returns null when XP is skipped (disabled/invalid amount).
 * Throws on storage or unexpected failures.
 */
export const addXp = wrapServiceBoundary(async function addXp(client, guild, member, xpToAdd, options = {}) {
  const lockKey = `leveling:${guild.id}:${member.user.id}`;
  return await Mutex.runExclusive(lockKey, async () => {
    if (!xpToAdd || xpToAdd <= 0) {
      return null;
    }

    const config = await getLevelingConfig(client, guild.id);

    if (!config.enabled) {
      return null;
    }

    const levelData = await getUserLevelData(client, guild.id, member.user.id);

    levelData.xp += xpToAdd;
    levelData.totalXp += xpToAdd;
    if (options.source === 'voice') {
      levelData.lastVoiceXp = Date.now();
    } else {
      levelData.lastMessage = Date.now();
    }

    let xpNeededForNextLevel = getXpForLevel(levelData.level);
    let didLevelUp = false;
    const initialLevel = levelData.level;

    while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
      levelData.xp -= xpNeededForNextLevel;
      levelData.level += 1;
      didLevelUp = true;
      xpNeededForNextLevel = getXpForLevel(levelData.level);

      logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

      if (config.roleRewards && config.roleRewards[levelData.level]) {
        await awardRoleReward(guild, member, config.roleRewards[levelData.level], levelData.level);
      }
    }

    if (didLevelUp) {
      if (config.announceLevelUp) {
        await sendLevelUpAnnouncement(guild, member, levelData, config);
      }

      try {
        await logEvent({
          client,
          guildId: guild.id,
          eventType: EVENT_TYPES.LEVELING_LEVELUP,
          data: {
            title: 'Level Up',
            lines: [
              formatLogLine('Member', `${member.user.tag} (\`${member.user.id}\`)`),
              formatLogLine('New Level', levelData.level.toString()),
              formatLogLine('Levels Gained', (levelData.level - initialLevel).toString()),
              formatLogLine('Total XP', levelData.totalXp.toString()),
            ],
            userId: member.user.id,
          },
        });
      } catch (logError) {
        logger.debug('Failed to log leveling event:', logError.message);
      }
    }

    await saveUserLevelData(client, guild.id, member.user.id, levelData);

    return {
      level: levelData.level,
      xp: levelData.xp,
      totalXp: levelData.totalXp,
      xpNeeded: getXpForLevel(levelData.level + 1),
      leveledUp: didLevelUp,
    };
  });
}, {
  service: 'xpSystem',
  operation: 'addXp',
  userMessage: 'Failed to award XP. Please try again.',
});

async function awardRoleReward(guild, member, roleId, level) {
  try {
    const role = guild.roles.cache.get(roleId);

    if (!role) {
      logger.warn(`Role ${roleId} not found for level ${level} reward in guild ${guild.id}`);
      return;
    }

    if (member.roles.cache.has(roleId)) {
      return;
    }

    await member.roles.add(role, `Level ${level} reward`);
    logger.info(`✅ Awarded role ${role.name} to ${member.user.tag} for reaching level ${level}`);
  } catch (error) {
    logger.error(`Failed to award role reward to ${member.user.id}:`, error);
  }
}

export async function sendLevelUpAnnouncement(guild, member, levelData, config) {
  try {
    const levelUpChannel = config.levelUpChannel
      ? guild.channels.cache.get(config.levelUpChannel)
      : guild.systemChannel;

    if (!levelUpChannel || !levelUpChannel.isTextBased()) {
      return false;
    }

    const permissions = levelUpChannel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions to send levelup message in ${levelUpChannel.id}`);
      return false;
    }

    // Announce the level reached and every configured role reward earned
    // across all levels gained in this XP award.
    const messageLines = [
      `**${member.toString()}**, you just reached level **${levelData.level}**!`
    ];
    const rewardRoleIds = new Set();
    for (let reachedLevel = (levelData.previousLevel ?? levelData.level - 1) + 1; reachedLevel <= levelData.level; reachedLevel += 1) {
      const roleId = config.roleRewards?.[reachedLevel];
      if (roleId) rewardRoleIds.add(roleId);
    }

    for (const roleId of rewardRoleIds) {
      const rewardRole = guild.roles.cache.get(roleId);
      if (rewardRole) {
        messageLines.push(`🎉 You received the **<@&${rewardRole.id}>** role!`);
      }
    }
    const message = messageLines.join('\\n');

    const levelUpEmbed = new EmbedBuilder()
      .setColor(0x36393F)
      .setDescription([
        '⚔️ **LEVEL UP ALERT!**',
        '',
        'Well, well, well! Akala namin ordinary recruit ka lang sa Barracks, pero mukhang nag-grind ka nang todo!',
        '',
        '⚔️ **SOLDIER PROFILE:**',
        '',
        `• **Rank Level:** ${levelData.level}`,
        `• **Total Battle Experience:** ${levelData.totalXp.toLocaleString('en-US')} XP`,
        '',
        '🎖️ Keep grinding, soldier! We still have more missions, promotions, and questionable military decisions waiting for you.'
      ].join('\n'))
      .setThumbnail(member.displayAvatarURL({ extension: 'png', size: 256 }))
      .setImage('https://media.discordapp.net/attachments/1563246823018336416/1563262831334391959/barracks-red-lightning-banner.gif?ex=6af6b2b7&is=6af56137&hm=6c175623588c4efc954b84cb34d624cb7ad5808e00447f79d999e505abe5df22&=');

    await levelUpChannel.send({
      content: message,
      embeds: [levelUpEmbed]
    });
    return true;
  } catch (error) {
    logger.error('Error sending level up announcement:', error);
    return false;
  }
}
