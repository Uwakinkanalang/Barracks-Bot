import { Events, AuditLogEvent } from 'discord.js';
import { captureModerationAudit } from '../services/moderationAuditMirror.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanAdd,
  once: false,
  async execute(ban) {
    try {
      const config = await getWelcomeConfig(ban.guild.client, ban.guild.id);
      if (config.banEnabled && config.banChannelId) {
        const channel = await ban.guild.channels.fetch(config.banChannelId).catch(() => null);
        if (channel?.isTextBased?.() && channel.send) {
          const message = formatWelcomeMessage(
            config.banMessage || '{user.tag} has been banned from {server}.',
            { user: ban.user, guild: ban.guild }
          );
          await channel.send({ content: message, allowedMentions: { parse: [] } });
        }
      }
      await captureModerationAudit(ban.guild, {
        type: AuditLogEvent.MemberBanAdd,
        action: 'ban',
        targetId: ban.user.id,
        targetName: ban.user.tag,
        details: 'User banned from server',
      });
    } catch (error) {
      logger.warn('Could not process Discord ban event:', error?.message || error);
    }
  },
};
