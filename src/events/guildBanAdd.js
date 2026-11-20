import { Events, AuditLogEvent } from 'discord.js';
import { captureModerationAudit } from '../services/moderationAuditMirror.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanAdd,
  once: false,
  async execute(ban) {
    try {
      await captureModerationAudit(ban.guild, {
        type: AuditLogEvent.MemberBanAdd,
        action: 'ban',
        targetId: ban.user.id,
        targetName: ban.user.tag,
        details: 'User banned from server',
      });
    } catch (error) {
      logger.warn('Could not capture Discord ban event:', error?.message || error);
    }
  },
};
