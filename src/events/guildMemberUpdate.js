import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { getEconomyData, setEconomyData } from '../utils/economy.js';
import { getLevelingConfig } from '../services/leveling/leveling.js';
import { getNicknamePrefix } from '../commands/Economy/nickname.js';
import { getAFKKey } from '../utils/database.js';
import { captureModerationAudit } from '../services/moderationAuditMirror.js';
import { applyDashboardAutoNick } from '../services/autoNickDashboardService.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      if (!newMember.guild) return;

      // Record Nitro boost starts and stops for the Barracks dashboard activity feed.
      try {
        const oldBoostStartedAt = oldMember.premiumSince?.toISOString?.() || null;
        const newBoostStartedAt = newMember.premiumSince?.toISOString?.() || null;
        if (oldBoostStartedAt !== newBoostStartedAt) {
          const activityKey = `guild:${newMember.guild.id}:boost_activity`;
          const activity = await newMember.client.db.get(activityKey, []);
          const entries = Array.isArray(activity) ? activity : [];
          // Count each newly observed boost start. This is not a simultaneous boost quantity.
          if (newBoostStartedAt) {
            const countsKey = 'guild:' + newMember.guild.id + ':boost_start_counts';
            const countsRaw = await newMember.client.db.get(countsKey, {});
            const counts = countsRaw && typeof countsRaw === 'object' && !Array.isArray(countsRaw) ? countsRaw : {};
            counts[newMember.id] = Number(counts[newMember.id] || 0) + 1;
            await newMember.client.db.set(countsKey, counts);
          }
          entries.unshift({
            action: newBoostStartedAt ? 'started' : 'ended',
            displayName: newMember.displayName || newMember.user.globalName || newMember.user.username,
            userId: newMember.id,
            boostStartedAt: newBoostStartedAt,
            occurredAt: new Date().toISOString()
          });
          await newMember.client.db.set(activityKey, entries.slice(0, 50));
        }
      } catch (error) {
        logger.warn(`Could not record boost activity for member ${newMember.id}: ${error.message}`);
      }

      const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
      const newTimeout = newMember.communicationDisabledUntilTimestamp || null;
      if (oldTimeout !== newTimeout) {
        await captureModerationAudit(newMember.guild, {
          type: 24,
          action: newTimeout ? 'timeout' : 'untimeout',
          targetId: newMember.id,
          targetName: newMember.user.tag,
          details: newTimeout ? 'Until ' + new Date(newTimeout).toLocaleString() : 'Timeout removed',
        });
      }

      // Automatic Barracks nickname formatting must never run in other servers.
      const isBarracksGuild = Boolean(process.env.GUILD_ID) && newMember.guild.id === process.env.GUILD_ID;

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

      // Legacy department prefixes are only stripped when applying an explicitly configured AutoNick prefix.
      const legacyDepartmentPrefixes = ['🍋|', '☕|', '💼|', '🍎|', '🥒|', '⚖|', '🥥|', '👮‍♂️|'];

      const oldRoleIds = new Set(oldMember.roles.cache.keys());
      const newRoleIds = new Set(newMember.roles.cache.keys());
      const changedRoleIds = new Set([
        ...[...oldRoleIds].filter((roleId) => !newRoleIds.has(roleId)),
        ...[...newRoleIds].filter((roleId) => !oldRoleIds.has(roleId)),
      ]);
      const roleSetChanged = changedRoleIds.size > 0;

      // These are Barracks rank roles. They may also be configured in /autonick.
      const rankRoleIds = [
        '1467461731998761096',
        '1467461918792089784',
        '1467461953340444677',
        '1540715496637333564',
        '1467462639759396865',
        '1467462740024098983',
        '1467462823457063067',
        '1467462861822627912',
      ];

      // AutoNick is available in every server; Barracks rank/clan nickname rules remain server-specific.
      const autoNickConfigsRaw = await newMember.client.db.get(`guild:${newMember.guild.id}:autonick_roles`, []);
      const autoNickConfigs = (Array.isArray(autoNickConfigsRaw) ? autoNickConfigsRaw : [])
        .filter((entry) => entry && typeof entry.roleId === 'string' && typeof entry.prefix === 'string')
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
      const autoNickRoleIds = new Set(autoNickConfigs.map((entry) => entry.roleId));
      const changedAutoNickRole = [...changedRoleIds].some((roleId) => autoNickRoleIds.has(roleId));

      // Keep the stored base nickname synchronized with manual edits.
      if (
        oldMember.nickname !== newMember.nickname &&
        !roleSetChanged &&
        !newMember.user.bot &&
        autoNickConfigs.length > 0
      ) {
        const activeAutoNick = autoNickConfigs.find((entry) => newMember.roles.cache.has(entry.roleId));
        if (activeAutoNick) {
          const stateKey = `guild:${newMember.guild.id}:autonick_member:${newMember.id}`;
          const currentNickname = String(newMember.nickname ?? newMember.user.globalName ?? newMember.user.username);
          const hadAfkMarker = /^\[AFK\]\s*/u.test(currentNickname);
          let baseName = currentNickname.replace(/^\[AFK\]\s*/u, '').trimStart();
          const configuredPrefixes = autoNickConfigs
            .map((entry) => String(entry.prefix).trim())
            .filter(Boolean)
            .sort((x, y) => y.length - x.length);
          let matchedPrefix;
          do {
            matchedPrefix = configuredPrefixes.find((prefix) => baseName.startsWith(prefix));
            if (matchedPrefix) baseName = baseName.slice(matchedPrefix.length).trimStart();
          } while (matchedPrefix);

          if (!baseName.trim()) baseName = newMember.user.globalName || newMember.user.username;
          await newMember.client.db.set(stateKey, {
            originalNickname: baseName,
            savedAt: Date.now(),
          });

          const autoNickTemplate = typeof activeAutoNick.format === 'string' && activeAutoNick.format.includes('{username}')
            ? activeAutoNick.format
            : `${String(activeAutoNick.prefix || '').trim()} {username}`;
          const desiredBase = autoNickTemplate
            .replace(/\bTAG\b/gi, String(activeAutoNick.tag || ''))
            .replace(/\{username\}/gi, baseName)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 32);
          let desiredNickname = desiredBase;
          const afkKey = getAFKKey(newMember.guild.id, newMember.id);
          const afkStatus = await newMember.client.db.get(afkKey, null);
          if (afkStatus || hadAfkMarker) {
            const status = afkStatus || {};
            status.originalNickname = desiredBase;
            status.afkNickname = `[AFK] ${desiredBase}`.slice(0, 32);
            await newMember.client.db.set(afkKey, status);
            desiredNickname = status.afkNickname;
          }

          if (newMember.nickname !== desiredNickname) {
            await newMember.setNickname(desiredNickname, 'Save manual nickname and reapply AutoNick prefix');
          }
        }
      }

      const isRankRoleMember = rankRoleIds.some((roleId) =>
        oldMember.roles.cache.has(roleId) || newMember.roles.cache.has(roleId) || changedRoleIds.has(roleId)
      );

      if ((isBarracksGuild || changedAutoNickRole || isRankRoleMember) && roleSetChanged && !newMember.user.bot) {
        try {
          // Load the authoritative role-reward map whenever a Barracks rank role
          // changes, even if GUILD_ID is missing or misconfigured in Railway.
          const levelingConfig = (isBarracksGuild || isRankRoleMember)
            ? await getLevelingConfig(newMember.client, newMember.guild.id)
            : { roleRewards: {} };
          const rankRewards = Object.entries(levelingConfig.roleRewards || {})
            .map(([level, roleId]) => ({ level: Number(level), roleId }))
            .filter((entry) => Number.isInteger(entry.level) && entry.level >= 1 && entry.level <= 100 &&
              typeof entry.roleId === 'string' && entry.roleId.length > 0)
            .sort((a, b) => b.level - a.level);

          const highestRank = rankRewards.find(({ roleId }) => newMember.roles.cache.has(roleId));

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

          const clans = isBarracksGuild
            ? await newMember.client.db.get(`guild:${newMember.guild.id}:clans`, [])
            : [];
          const clanList = Array.isArray(clans) ? clans : [];
          const memberClan = clanList.find((clan) =>
            clan.status === 'approved' &&
            clan.roleId &&
            newMember.roles.cache.has(clan.roleId)
          );

          const joinedClan = Boolean(memberClan && !oldMember.roles.cache.has(memberClan.roleId));

          const changedRankRole = [...changedRoleIds].some((roleId) =>
            rankRoleIds.includes(roleId) || rankRewards.some((entry) => entry.roleId === roleId)
          );
          // Configured AutoNick roles, including rank roles, use the same priority system.
          const activeAutoNick = changedAutoNickRole
            ? autoNickConfigs.find((entry) => newMember.roles.cache.has(entry.roleId))
            : null;
          // Recalculate whenever a configured AutoNick role is added OR removed.
          const shouldUpdateForConfiguredAutoNick = changedAutoNickRole;
          const shouldUpdateForOtherNicknameRules = isBarracksGuild && !changedRankRole &&
            (!memberClan || joinedClan);
          if (shouldUpdateForConfiguredAutoNick || shouldUpdateForOtherNicknameRules) {
            const autoNickStateKey = `guild:${newMember.guild.id}:autonick_member:${newMember.id}`;
            let autoNickState = changedAutoNickRole
              ? await newMember.client.db.get(autoNickStateKey, null)
              : null;
            // Capture the exact server nickname before the first AutoNick role is applied.
            // Keep null when the member had no server nickname so removal restores that state too.
            if (changedAutoNickRole && activeAutoNick && !autoNickState) {
              autoNickState = {
                originalNickname: oldMember.nickname ?? null,
                hadNickname: oldMember.nickname != null,
                savedAt: Date.now(),
              };
              await newMember.client.db.set(autoNickStateKey, autoNickState);
            }
            let baseName = autoNickState && typeof autoNickState.originalNickname === 'string'
              ? autoNickState.originalNickname
              : (newMember.nickname ?? newMember.user.globalName ?? newMember.user.username);
            baseName = baseName.replace(/^\[AFK\]\s*/u, '');
            const knownDepartmentPrefixes = legacyDepartmentPrefixes
              .slice()
              .sort((a, b) => b.length - a.length);
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
                const departmentPrefix = knownDepartmentPrefixes.find((item) => result.startsWith(item));
                if (departmentPrefix) {
                  result = result.slice(departmentPrefix.length).trimStart();
                  changed = true;
                  continue;
                }
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

            baseName = stripRankDecorations(baseName);
            // If this member predates saved AutoNick state, remove repeated configured
            // prefixes from the front so an old duplicate such as "🛡️| 🛡️| Uwak"
            // is repaired instead of being saved as their permanent base nickname.
            if (!autoNickState && changedAutoNickRole) {
              const configuredPrefixes = autoNickConfigs
                .map((entry) => String(entry.prefix).trim())
                .filter(Boolean)
                .sort((a, b) => b.length - a.length);
              let previousPrefix;
              do {
                previousPrefix = configuredPrefixes.find((prefix) => baseName.startsWith(prefix));
                if (previousPrefix) baseName = baseName.slice(previousPrefix.length).trimStart();
              } while (previousPrefix);
            }
            if (!baseName.trim()) {
              baseName = newMember.user.globalName || newMember.user.username;
            }

            const rankRoleName = highestRank
              ? newMember.guild.roles.cache.get(highestRank.roleId)?.name || ''
              : '';
            const rankDisplayName = highestRank
              ? (rankPrefixes[highestRank.level] || rankRoleName)
              : '';
            const nicknameBody = rankDisplayName
              ? `${rankDisplayName} ${baseName.trimStart()}`
              : baseName.trimStart();

            const clanTag = memberClan ? String(memberClan.tag || '').trim() : '';
            const autoNickTemplate = activeAutoNick
              ? (typeof activeAutoNick.format === 'string' && activeAutoNick.format.includes('{username}')
                  ? activeAutoNick.format
                  : `${String(activeAutoNick.prefix || '').trim()} {username}`)
              : '';
            const formattedAutoNick = activeAutoNick
              ? autoNickTemplate
                  .replace(/\bTAG\b/gi, String(activeAutoNick.tag || ''))
                  .replace(/\{username\}/gi, baseName.trimStart())
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 32)
              : null;
            let desiredNickname = activeAutoNick
              ? formattedAutoNick
              : changedAutoNickRole && autoNickState
                ? (autoNickState.hadNickname === false ? null : autoNickState.originalNickname)
                : memberClan
                  ? `${clanTag}| ${baseName.trimStart()}`.slice(0, 32)
                  : rankDisplayName
                    ? `🔫${nicknameBody}`.slice(0, 32)
                    : baseName.trimStart().slice(0, 32);

            // Clear saved AutoNick state after the last configured role is removed.
            if (changedAutoNickRole && !activeAutoNick && autoNickState) {
              await newMember.client.db.delete(autoNickStateKey).catch(() => {});
            }

            // Keep the AFK marker while refreshing the underlying nickname format.
            const afkKey = getAFKKey(newMember.guild.id, newMember.id);
            const afkStatus = await newMember.client.db.get(afkKey, null);
            if (afkStatus) {
              afkStatus.originalNickname = desiredNickname;
              afkStatus.afkNickname = `[AFK] ${desiredNickname}`.slice(0, 32);
              await newMember.client.db.set(afkKey, afkStatus);
              desiredNickname = afkStatus.afkNickname;
            }

            if (newMember.nickname !== desiredNickname) {
              await newMember.setNickname(
                desiredNickname,
                activeAutoNick
                  ? `Apply configured AutoNick prefix for role ${activeAutoNick.roleId}`
                  : memberClan
                      ? 'Apply clan tag when member joins an approved clan'
                      : 'Apply automatic rank nickname for a non-clan member',
              );
              logger.info(
                `[AUTO_NICKNAME] Updated ${newMember.user.tag} to ${desiredNickname}`,
              );
            }
          }
        } catch (nicknameError) {
          logger.warn(
            `[RANK_NICKNAME] Could not update nickname for ${newMember.user.tag}: ${nicknameError.message}`,
          );
        }
      }

      if (roleSetChanged && !newMember.user.bot) {
        try { await applyDashboardAutoNick(newMember, 'role'); }
        catch (error) { logger.warn(`[AUTO_NICKNAME] Role rule failed for ${newMember.user.tag}: ${error.message}`); }
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