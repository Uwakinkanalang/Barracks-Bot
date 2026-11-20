import { Events, AuditLogEvent } from 'discord.js';
import { captureModerationAudit } from '../services/moderationAuditMirror.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanRemove,
  once: false,
  async execute(ban) {
    try {
      await captureModerationAudit(ban.guild, {
        type: AuditLogEvent.MemberBanRemove,
        action: 'unban',
        targetId: ban.user.id,
        targetName: ban.user.tag,
        details: 'Ban removed from user',
      });
    } catch (error) {
      logger.warn('Could not capture Discord unban event:', error?.message || error);
    }
  },
};
