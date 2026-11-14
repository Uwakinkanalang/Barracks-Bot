import { logger } from '../../utils/logger.js';
import { getLevelingConfig, saveLevelingConfig } from './leveling.js';

/**
 * Validate configured rank reward roles on startup.
 *
 * Important: do not add or remove member roles here. Startup reconciliation
 * used to remove every rank below the member's calculated highest rank. That
 * could unexpectedly strip roles after a restart or after leveling data was
 * migrated/changed. Rank promotion cleanup is handled only when a new reward
 * is actually earned in xpSystem.js.
 */
export async function reconcileLevelRoles(client, guildId = null) {
    const summary = {
        scannedGuilds: 0,
        prunedRewardEntries: 0,
        rolesReAwarded: 0,
        errors: 0,
    };

    const guilds = guildId
        ? [client.guilds.cache.get(guildId)].filter(Boolean)
        : [...client.guilds.cache.values()];

    for (const guild of guilds) {
        summary.scannedGuilds += 1;

        try {
            const cfg = await getLevelingConfig(client, guild.id);
            if (cfg.enabled === false) continue;

            const rewards = { ...(cfg.roleRewards || {}) };
            let configChanged = false;

            for (const [level, roleId] of Object.entries(rewards)) {
                const role =
                    guild.roles.cache.get(roleId) ||
                    (await guild.roles.fetch(roleId).catch(() => null));

                if (!role) {
                    delete rewards[level];
                    configChanged = true;
                    summary.prunedRewardEntries += 1;
                    logger.warn(
                        `Removed missing level ${level} reward role ${roleId} from config in guild ${guild.id}`,
                    );
                }
            }

            if (configChanged) {
                cfg.roleRewards = rewards;
                await saveLevelingConfig(client, guild.id, cfg);
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Level role validation failed for guild ${guild.id}:`, error.message);
        }
    }

    return summary;
}
