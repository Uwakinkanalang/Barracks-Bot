import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const KEY = guildId => 'dashboard:moderation:' + guildId + ':logs';

/**
 * Correlates a Discord gateway event with its audit-log entry and mirrors it
 * into the dashboard's moderation history. Requires View Audit Log permission.
 */
export async function captureModerationAudit(guild, { type, action, targetId, targetName, details = '' }) {
  try {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return false;
    const audit = await guild.fetchAuditLogs({ type, limit: 8 });
    const now = Date.now();
    const entry = audit.entries.find(item =>
      item.target?.id === targetId &&
      item.createdTimestamp <= now + 3000 &&
      now - item.createdTimestamp <= 20000
    );
    if (!entry) return false;

    const key = KEY(guild.id);
    const existing = await getFromDb(key, []);
    const logs = Array.isArray(existing) ? existing : [];
    if (logs.some(item => item.discordAuditId === entry.id)) return false;

    logs.unshift({
      id: entry.id,
      discordAuditId: entry.id,
      timestamp: entry.createdAt?.toISOString?.() || new Date().toISOString(),
      source: 'discord',
      action,
      moderator: entry.executor?.tag || entry.executor?.username || 'Unknown moderator',
      moderatorId: entry.executor?.id || null,
      targetId,
      targetName: targetName || entry.target?.tag || entry.target?.username || targetId,
      reason: entry.reason || 'No reason provided',
      details,
    });
    await setInDb(key, logs.slice(0, 500));
    return true;
  } catch (error) {
    logger.warn('Could not mirror Discord moderation audit event:', error?.message || error);
    return false;
  }
}
