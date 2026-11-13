import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { getEconomyData, setEconomyData } from '../utils/economy.js';
import { getLevelingConfig } from '../services/leveling/leveling.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      if (!newMember.guild) return;

      if (oldMember.nickname !== newMember.nickname) {
        await logEvent({
          client: newMember.client,
          guildId: newMember.guild.id,
          eventType: EVENT_TYPES.MEMBER_NAME_CHANGE,
          data: {
            title: 'Nickname changed',
            lines: [
              `**User:** ${newMember.user.toString()} (${newMember.user.tag})`,
              `**ID:** \`${newMember.user.id}\``,
              `**Before:** ${oldMember.nickname || '*(no nickname)*'}`,
              `**After:** ${newMember.nickname || '*(no nickname)*'}`,
            ],
            thumbnail: newMember.user.displayAvatarURL({ dynamic: true }),
            userId: newMember.user.id,
          }
        });

      }

      // Automatically apply the highest configured Barracks rank while preserving a leading [CLAN] tag.
      const oldRoleIds = new Set(oldMember.roles.cache.keys());
      const newRoleIds = new Set(newMember.roles.cache.keys());
      const roleSetChanged = oldRoleIds.size !== newRoleIds.size ||
        [...oldRoleIds].some((roleId) => !newRoleIds.has(roleId));

      if (roleSetChanged && !newMember.user.bot) {
        try {
          const levelingConfig = await getLevelingConfig(newMember.client, newMember.guild.id);
          const rankRewards = Object.entries(levelingConfig.roleRewards || {})
            .map(([level, roleId]) => ({ level: Number(level), roleId }))
            .filter((entry) => Number.isInteger(entry.level) && entry.level >= 1 && entry.level <= 100 &&
              typeof entry.roleId === 'string' && entry.roleId.length > 0)
            .sort((a, b) => b.level - a.level);

          const highestRank = rankRewards.find(({ roleId }) => newMember.roles.cache.has(roleId));

          // Remove any lower configured rank roles before changing the member's nickname.
          if (highestRank) {
            const previousRankRoleIds = rankRewards
              .filter(({ roleId }) => roleId !== highestRank.roleId && newMember.roles.cache.has(roleId))
              .map(({ roleId }) => roleId);

            if (previousRankRoleIds.length > 0) {
              await newMember.roles.remove(
                previousRankRoleIds,
                'Keep only the highest earned Barracks rank before updating nickname',
              );
            }
          }

          const rankPrefixes = {
            10: 'ᴾʳᶦᵛᵃᵗᵉ',
            20: 'ᶜᵒʳᵖᵒʳᵃˡ',
            30: 'ˢᵉʳᵍᵉᵃⁿᵗ',
            40: 'ᶜᵃᵖᵗᵃᶦⁿ',
            50: 'ᴸᶦᵉᵘᵗᵉⁿᵃⁿᵗ',
            60: 'ᴹᵃʲᵒʳ',
            80: 'ᶜᵒˡᵒⁿᵉˡ',
            100: 'ᴳᵉⁿᵉʳᵃˡ',
          };

          // Resolve the member's approved clan from their assigned clan role.
          const clans = await newMember.client.db.get(`guild:${newMember.guild.id}:clans`, []);
          const clanList = Array.isArray(clans) ? clans : [];
          const memberClan = clanList.find((clan) =>
            clan.status === 'approved' &&
            clan.roleId && newMember.roles.cache.has(clan.roleId) &&
            [clan.leaderId, clan.viceLeaderId, ...(clan.memberIds || [])].includes(newMember.id)
          );

          // Update nickname for non-clan rank changes, or once when a member joins a clan.
          const joinedClan = Boolean(memberClan && !oldMember.roles.cache.has(memberClan.roleId));
          if (!memberClan || joinedClan) {
          // Remove previous clan/rank decorations, then rebuild as TAG| DisplayName only.
          let baseName = newMember.displayName;
          const knownRankPrefixes = Object.values(rankPrefixes).sort((a, b) => b.length - a.length);
          const knownRankNames = rankRewards
            .map(({ roleId }) => newMember.guild.roles.cache.get(roleId)?.name)
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);

          const stripRankDecorations = (value) => {
            let result = value.trimStart();
            let changed = true;
            while (changed) {
              changed = false;
              result = result.replace(/^🔫\s*/u, '');
              const prefix = knownRankPrefixes.find((item) => result.startsWith(item));
              if (prefix) {
                result = result.slice(prefix.length).trimStart();
                changed = true;
                continue;
              }
              const rankName = knownRankNames.find((item) =>
                result.toLowerCase().startsWith(item.toLowerCase())
              );
              if (rankName) {
                result = result.slice(rankName.length).trimStart();
                changed = true;
              }
            }
            return result.trimStart();
          };

          // Strip rank text before checking the old tag (handles previously malformed nicknames too).
          baseName = stripRankDecorations(baseName);

          const knownClanTags = clanList
            .map((clan) => String(clan.tag || '').trim())
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);
          const previousClanTag = knownClanTags.find((tag) =>
            baseName.startsWith(`[${tag}]|`) || baseName.startsWith(`${tag}|`)
          );
          if (previousClanTag) {
            baseName = baseName.startsWith(`[${previousClanTag}]|`)
              ? baseName.slice(previousClanTag.length + 3)
              : baseName.slice(previousClanTag.length + 1);
          }

          // Also clean decorations that may have appeared immediately after an old clan tag.
          baseName = stripRankDecorations(baseName);
          if (!baseName.trim()) {
            baseName = newMember.user.globalName || newMember.user.username;
          }

          const rankRoleName = highestRank
            ? newMember.guild.roles.cache.get(highestRank.roleId)?.name || ''
            : '';
          // Keep the superscript rank labels, selected by the member's configured rank role.
          const rankDisplayName = highestRank
            ? (rankPrefixes[highestRank.level] || rankRoleName)
            : '';
          const nicknameBody = rankDisplayName
            ? `${rankDisplayName} ${baseName.trimStart()}`
            : baseName.trimStart();

          // Clan members get TAG| Name when they join; non-clan members get 🔫Rank Name.
          const clanTag = memberClan ? String(memberClan.tag || '').trim() : '';
          const desiredNickname = memberClan
            ? `${clanTag}| ${baseName.trimStart()}`.slice(0, 32)
            : `🔫${nicknameBody}`.slice(0, 32);

          if (newMember.nickname !== desiredNickname) {
            await newMember.setNickname(
              memberClan
                ? 'Apply clan tag when member joins an approved clan'
                : 'Apply automatic rank nickname for a non-clan member',
            );
            logger.info(
              `[RANK_NICKNAME] Updated ${newMember.user.tag} to ${desiredNickname}`,
            );
          }
          }
        } catch (nicknameError) {
          logger.warn(
            `[RANK_NICKNAME] Could not update nickname for ${newMember.user.tag}: ${nicknameError.message}`,
          );
        }
      }

      // One-time wallet rewards for configured role grants.
      const roleRewards = {
        '1467461731998761096': 50000,
        '1467461918792089784': 100000,
        '1467461953340444677': 150000,
        '1540715496637333564': 200000,
        '1467462639759396865': 250000,
        '1467462740024098983': 300000,
        '1467462823457063067': 500000,
        '1467462861822627912': 1000000,
      };
      const newlyAddedRoleIds = Object.keys(roleRewards).filter(
        (roleId) => !oldMember.roles.cache.has(roleId) && newMember.roles.cache.has(roleId),
      );

      if (newlyAddedRoleIds.length > 0 && !newMember.user.bot) {
        // Keep only the newly assigned reward role(s); never remove unrelated server roles.
        const previousRewardRoleIds = Object.keys(roleRewards).filter(
          (roleId) => !newlyAddedRoleIds.includes(roleId) && newMember.roles.cache.has(roleId),
        );

        if (previousRewardRoleIds.length > 0) {
          try {
            await newMember.roles.remove(
              previousRewardRoleIds,
              'Replaced by a newly assigned Barracks role reward role',
            );
          } catch (error) {
            logger.warn(
              `[ROLE_REWARD] Could not remove previous reward role(s) from ${newMember.user.tag}: ${error.message}`,
            );
          }
        }

        const economyData = await getEconomyData(newMember.client, newMember.guild.id, newMember.id);
        economyData.inventory = economyData.inventory || {};
        economyData.inventory.roleRewardClaims = economyData.inventory.roleRewardClaims || {};

        let totalReward = 0;
        const claimedRoleIds = [];

        for (const roleId of newlyAddedRoleIds) {
          if (economyData.inventory.roleRewardClaims[roleId]) continue;
          const amount = roleRewards[roleId];
          if (!Number.isSafeInteger((economyData.wallet || 0) + totalReward + amount)) continue;

          totalReward += amount;
          claimedRoleIds.push(roleId);
          economyData.inventory.roleRewardClaims[roleId] = Date.now();
        }

        if (claimedRoleIds.length > 0) {
          economyData.wallet = (economyData.wallet || 0) + totalReward;
          const saved = await setEconomyData(newMember.client, newMember.guild.id, newMember.id, economyData);

          if (saved) {
            logger.info(
              `[ROLE_REWARD] Awarded ₱${totalReward.toLocaleString()} to ${newMember.user.tag} for role(s): ${claimedRoleIds.join(', ')}`,
            );
            const rewardedRoleNames = claimedRoleIds
              .map((roleId) => newMember.guild.roles.cache.get(roleId)?.name || 'Special Role')
              .join(', ');
            await newMember.send(
              `🎉 You received **₱${totalReward.toLocaleString()}** in Barracks cash for earning **${rewardedRoleNames}**!`,
            ).catch(() => {});
          }
        }
      }

    } catch (error) {
      logger.error('Error in guildMemberUpdate event:', error);
    }
  }
};