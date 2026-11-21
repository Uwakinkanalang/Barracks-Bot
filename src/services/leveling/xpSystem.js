// xpSystem.js

import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData } from './leveling.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { Mutex } from '../../utils/mutex.js';
import { wrapServiceBoundary } from '../../utils/errorHandler.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';

const BCASH_ROLE_REWARDS = Object.freeze({
  10: 50000, 20: 100000, 30: 300000, 40: 500000,
  50: 1000000, 60: 3000000, 80: 5000000, 100: 10000000,
});

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

    // Use only the highest configured role multiplier held by this member.
    const roleMultipliers = Object.entries(config.roleXpMultipliers || {});
    const highestRoleMultiplier = roleMultipliers.reduce((highest, [roleId, multiplier]) => {
      if (!member.roles?.cache?.has(roleId)) return highest;
      const value = Number(multiplier);
      return Number.isFinite(value) && value > highest ? value : highest;
    }, 1);
    // Server boosters keep their existing double-XP bonus.
    const awardedXp = xpToAdd * highestRoleMultiplier * (member.premiumSince ? 2 : 1);
    const levelData = await getUserLevelData(client, guild.id, member.user.id);

    levelData.xp += awardedXp;
    levelData.totalXp += awardedXp;
    if (options.source === 'voice') {
      levelData.lastVoiceXp = Date.now();
    } else {
      levelData.lastMessage = Date.now();
    }

    let xpNeededForNextLevel = getXpForLevel(levelData.level);
    let didLevelUp = false;
    const initialLevel = levelData.level;
    const bcashRewards = [];

    while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
      levelData.xp -= xpNeededForNextLevel;
      levelData.level += 1;
      didLevelUp = true;
      xpNeededForNextLevel = getXpForLevel(levelData.level);

      logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

      if (config.roleRewards && config.roleRewards[levelData.level]) {
        await awardRoleReward(guild, member, config.roleRewards[levelData.level], levelData.level, config.roleRewards);
      }

      const bcashAmount = BCASH_ROLE_REWARDS[levelData.level];
      if (bcashAmount) {
        const reward = await awardBcashReward(client, guild.id, member.user.id, levelData.level, bcashAmount);
        if (reward) {
          bcashRewards.push(reward);
          await sendBcashRewardDm(member, guild, levelData.level, reward, config.roleRewards?.[levelData.level]);
        }
      }
    }

    if (didLevelUp) {
      const reachedRoleRewardLevel = Object.keys(config.roleRewards || {}).some((rewardLevel) => {
        const level = Number(rewardLevel);
        return Number.isInteger(level) && level > initialLevel && level <= levelData.level;
      });

      if (config.announceLevelUp && reachedRoleRewardLevel) {
        await sendLevelUpAnnouncement(guild, member, levelData, config, initialLevel, bcashRewards);
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

async function awardBcashReward(client, guildId, userId, level, amount) {
  try {
    const economyData = await getEconomyData(client, guildId, userId);
    economyData.inventory = economyData.inventory || {};
    const claims = economyData.inventory.roleRewardClaims || {};
    const claimKey = String(level);
    if (claims[claimKey]) return null;

    economyData.wallet = (Number(economyData.wallet) || 0) + amount;
    economyData.inventory.roleRewardClaims = { ...claims, [claimKey]: true };
    const saved = await setEconomyData(client, guildId, userId, economyData);
    if (!saved) {
      logger.error(`Could not save level ${level} Bcash reward for user ${userId}`);
      return null;
    }
    logger.info(`Awarded ₱${amount.toLocaleString('en-US')} Bcash to ${userId} for reaching level ${level}`);
    return { level, amount, walletBalance: Number(economyData.wallet) || 0 };
  } catch (error) {
    logger.error(`Failed to award Bcash reward to ${userId} for level ${level}:`, error);
    return null;
  }
}

async function sendBcashRewardDm(member, guild, level, reward, roleId) {
  try {
    const role = roleId ? guild.roles.cache.get(roleId) : null;
    const rankName = role?.name || `Level ${level}`;
    const message = [
      `• 🎉 You received **₱${reward.amount.toLocaleString('en-US')}** in Barracks cash for earning **🔫 ${rankName}**!`,
      `• 💰 Your new Bcash balance is **₱${reward.walletBalance.toLocaleString('en-US')}**.`
    ].join('\n');
    await member.send({ content: message });
    logger.info(`Sent level ${level} Bcash reward DM to ${member.user.id}`);
  } catch (error) {
    // A closed DM or blocked bot must never interrupt XP or reward processing.
    logger.debug(`Could not DM Bcash reward to ${member.user.id}: ${error.message}`);
  }
}

async function awardRoleReward(guild, member, roleId, level, roleRewards = {}) {
  try {
    const role = guild.roles.cache.get(roleId);

    if (!role) {
      logger.warn(`Role ${roleId} not found for level ${level} reward in guild ${guild.id}`);
      return;
    }

    // A member may hold only their highest configured leveling rank.
    // Remove lower/other leveling rewards without touching unrelated server roles.
    const previousRankRoleIds = [...new Set(Object.values(roleRewards))]
      .filter((id) => id !== roleId && member.roles.cache.has(id));

    if (previousRankRoleIds.length) {
      await member.roles.remove(previousRankRoleIds, `Promoted to level ${level} rank`);
    }

    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(role, `Level ${level} reward`);
      logger.info(`✅ Awarded role ${role.name} to ${member.user.tag} for reaching level ${level}`);
    }
  } catch (error) {
    logger.error(`Failed to award role reward to ${member.user.id}:`, error);
  }
}

function stylizePlainEmbedAuthor(value) {
  const map = (text, style) => Array.from(text).map((character) => {
    const code = character.codePointAt(0);
    if (style === 'bold' && code >= 48 && code <= 57) return String.fromCodePoint(0x1D7CE + code - 48);
    if (code >= 65 && code <= 90) return String.fromCodePoint((style === 'bold' ? 0x1D400 : style === 'italic' ? 0x1D434 : 0x1D468) + code - 65);
    if (code >= 97 && code <= 122) return String.fromCodePoint((style === 'bold' ? 0x1D41A : style === 'italic' ? 0x1D44E : 0x1D482) + code - 97);
    return character;
  }).join('');
  return String(value || '')
    .replace(/\*\*\*(.+?)\*\*\*/g, (_, text) => map(text, 'bolditalic'))
    .replace(/\*\*(.+?)\*\*/g, (_, text) => map(text, 'bold'))
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, text) => map(text, 'italic'))
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, text) => map(text, 'italic'));
}

export async function sendLevelUpAnnouncement(guild, member, levelData, config, previousLevel = levelData.level - 1, bcashRewards = null) {
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

    // Show only the highest rank earned at the member's final level.
    const highestRewardLevel = Object.keys(config.roleRewards || {})
      .map(Number)
      .filter((level) => Number.isInteger(level) && level <= levelData.level)
      .sort((a, b) => b - a)[0];
    const highestRoleId = highestRewardLevel ? config.roleRewards[highestRewardLevel] : null;
    const rewardRoles = highestRoleId
      ? [guild.roles.cache.get(highestRoleId)].filter(Boolean)
      : [];
    const rankDisplay = rewardRoles.length
      ? rewardRoles.map((role) => `<@&${role.id}>`).join(', ')
      : 'Unranked';
    const announcedBcashRewards = bcashRewards ?? Object.entries(BCASH_ROLE_REWARDS)
      .filter(([level]) => Number(level) > previousLevel && Number(level) <= levelData.level)
      .map(([level, amount]) => ({ level: Number(level), amount }));
    const replaceAnnouncementTokens = (value, extra = {}) => String(value || '')
      .replaceAll('{user}', member.toString())
      .replaceAll('{username}', member.displayName || member.user.username)
      .replaceAll('{rank}', rankDisplay)
      .replaceAll('{level}', String(levelData.level))
      .replaceAll('{totalXp}', levelData.totalXp.toLocaleString('en-US'))
      .replaceAll('{bcash}', String(extra.bcash ?? ''))
      .replaceAll('{rewardLevel}', String(extra.rewardLevel ?? levelData.level));
    const autoMessages = config.levelUpMessages || {};
    const defaultMessageTemplate = [
      '**{user}**, you just reached level **{level}**!',
      '🎉 Your current highest rank is **{rank}**!',
      '💰 You received **₱{bcash} Bcash** for reaching level **{rewardLevel}**!'
    ].join('\n');
    const legacyTemplate = [autoMessages.level, autoMessages.rank, autoMessages.bcash].filter(Boolean).join('\n');
    const messageTemplate = String(autoMessages.template ?? (legacyTemplate || defaultMessageTemplate));
    const messageLines = [];
    for (const line of messageTemplate.replace(/\\\\n/g, '\n').split(/\r?\n/)) {
      if (line.includes('{rank}') && !rewardRoles.length) continue;
      if ((line.includes('{bcash}') || line.includes('{rewardLevel}')) && !announcedBcashRewards.length) continue;
      if (line.includes('{bcash}') && announcedBcashRewards.length) {
        for (const reward of announcedBcashRewards) {
          const rendered = replaceAnnouncementTokens(line, { bcash: reward.amount.toLocaleString('en-US'), rewardLevel: reward.level });
          if (rendered) messageLines.push(rendered);
        }
      } else {
        const rendered = replaceAnnouncementTokens(line);
        if (rendered) messageLines.push(rendered);
      }
    }
    const embedSettings = config.levelUpEmbed || {};
    const embedDescription = replaceAnnouncementTokens(
      embedSettings.description || [
        'Well, well, well! Akala namin ordinary recruit ka lang sa Barracks, pero mukhang nag-grind ka nang todo!',
        '',
        '⚔️ **SOLDIER PROFILE:**',
        '',
        '• **Rank:** {rank}',
        '• **Rank Level:** {level}',
        '• **Total Battle Experience:** {totalXp} XP',
        '',
        '🎖️ Keep grinding, soldier! We still have more missions, promotions, and questionable military decisions waiting for you.'
      ].join('\n')
    );
    const levelUpEmbed = new EmbedBuilder()
      .setColor(/^#[0-9a-fA-F]{6}$/.test(embedSettings.color || '') ? embedSettings.color : '#36393f')
      .setDescription(embedDescription.slice(0, 4096));
    const authorName = stylizePlainEmbedAuthor(replaceAnnouncementTokens(embedSettings.authorName));
    const title = replaceAnnouncementTokens(embedSettings.title || '⚔️ LEVEL UP ALERT!');
    const footerText = replaceAnnouncementTokens(embedSettings.footerText);
    if (authorName) levelUpEmbed.setAuthor({ name: authorName });
    if (title) levelUpEmbed.setTitle(title);
    if (embedSettings.thumbnailUrl) levelUpEmbed.setThumbnail(embedSettings.thumbnailUrl);
    if (footerText) {
      const footer = { text: footerText };
      if (embedSettings.footerIconUrl) footer.iconURL = embedSettings.footerIconUrl;
      levelUpEmbed.setFooter(footer);
    }
    if (!embedSettings.thumbnailUrl) levelUpEmbed.setThumbnail(member.displayAvatarURL({ extension: 'png', size: 256 }));
    if (embedSettings.imageUrl) levelUpEmbed.setImage(embedSettings.imageUrl);
    const customAnnouncementContent = String(config.levelUpContent || '').trim();
    const announcementContent = customAnnouncementContent && customAnnouncementContent !== '{user}'
      ? replaceAnnouncementTokens(customAnnouncementContent)
      : '';
    const announcementMessage = [announcementContent, ...messageLines].filter(Boolean).join('\n');

    await levelUpChannel.send({
      content: announcementMessage,
      embeds: [levelUpEmbed]
    });
    return true;
  } catch (error) {
    logger.error('Error sending level up announcement:', error);
    return false;
  }
}
