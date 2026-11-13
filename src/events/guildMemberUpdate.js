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
          const rankRole = highestRank
            ? (newMember.guild.roles.cache.get(highestRank.roleId) ||
              await newMember.guild.roles.fetch(highestRank.roleId).catch(() => null))
            : null;

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

          // Format clan members as TAG|Rank Name; non-clan members use 🔫Rank Name.
          const currentName = newMember.displayName;
          let baseName = currentName;

          // Strip any previously applied clan tag, including the legacy [TAG]| format.
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

          baseName = baseName.replace(/^🔫\\s*/u, '').trimStart();
          const previousRankPrefix = Object.values(rankPrefixes).find((prefix) => baseName.startsWith(prefix));
          if (previousRankPrefix) baseName = baseName.slice(previousRankPrefix.length).trimStart();
          const knownRankNames = rankRewards
            .map(({ roleId }) => newMember.guild.roles.cache.get(roleId)?.name)
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);
          const previousRankName = knownRankNames.find((roleName) =>
            baseName.toLowerCase().startsWith(roleName.toLowerCase())
          );
          if (previousRankName) baseName = baseName.slice(previousRankName.length).trimStart();

          const clanTag = memberClan ? String(memberClan.tag || '').trim() : '';
          const rankDisplayName = rankRole
            ? (rankPrefixes[highestRank.level] || rankRole.name)
            : '';
          const nicknameBody = rankRole
            ? `${rankDisplayName} ${baseName.trimStart()}`
            : baseName.trimStart();
          const desiredNickname = `${clanTag ? `${clanTag}| ` : (rankRole ? '🔫' : '')}${nicknameBody}`.slice(0, 32);

          if (newMember.nickname !== desiredNickname) {
            await newMember.setNickname(
              desiredNickname,
              rankRole
                ? `Automatic Barracks rank nickname for Level ${highestRank.level}`
                : 'Preserved clan tag and removed Barracks rank because no level rank role remains',
            );
            logger.info(
              `[RANK_NICKNAME] Updated ${newMember.user.tag} to ${desiredNickname}`,
            );
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