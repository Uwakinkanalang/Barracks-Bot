import { AuditLogEvent } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';

const GUILD_ID = process.env.BARRACKS_GUILD_ID || '1137695060096471160';
const LOG_KEY = guildId => 'dashboard:moderation:' + guildId + ':logs';

const ACTIONS = new Map([
  [AuditLogEvent.MemberKick, 'kick'],
  [AuditLogEvent.MemberBanAdd, 'ban'],
  [AuditLogEvent.MemberBanRemove, 'unban'],
]);

export default {
  name: 'guildAuditLogEntryCreate',
  async execute(entry, guild, client) {
    if (!guild || guild.id !== GUILD_ID || !entry?.executorId) return;

    let action = ACTIONS.get(entry.action);
    let targetName = entry.target?.tag || entry.target?.username || entry.target?.name || entry.targetId || 'Unknown';
    let details;

    if (entry.action === AuditLogEvent.MemberUpdate) {
      const timeoutChange = entry.changes?.find(change =>
        change.key === 'communication_disabled_until'
      );
      if (!timeoutChange) return;
      action = timeoutChange.new ? 'timeout' : 'untimeout';
      details = timeoutChange.new ? 'Timeout applied' : 'Timeout removed';
    }

    if (!action) return;

    const executor = entry.executor;
      const log = {
      id: 'discord-' + entry.id,
      timestamp: entry.createdAt?.toISOString?.() || new Date().toISOString(),
      action,
      targetId: entry.targetId || null,
      targetName,
      moderator: executor?.tag || executor?.username || entry.executorId,
      moderatorId: entry.executorId,
      reason: entry.reason || 'No reason provided',
      details: details || null,
      source: 'discord'
    };

    try {
      const key = LOG_KEY(guild.id);
      const existing = await getFromDb(key, []);
      const logs = Array.isArray(existing) ? existing : [];
      if (logs.some(item => item.id === log.id)) return;
      logs.unshift(log);
      await setInDb(key, logs.slice(0, 500));
    } catch (error) {
      client?.logger?.error?.('Could not save Discord moderation audit log:', error);
    }
  }
};
