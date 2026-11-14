import { Events } from 'discord.js';
import { getAFKKey } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (!message.guild || message.author.bot) return;

    try {
      const replies = [];
      const ownKey = getAFKKey(message.guild.id, message.author.id);
      const ownStatus = await client.db.get(ownKey, null);

      if (ownStatus) {
        await client.db.delete(ownKey);

        // Restore only if the nickname still matches the AFK nickname we set.
        // This avoids overwriting a nickname changed manually while the member was away.
        if (ownStatus.afkNickname && message.member?.nickname === ownStatus.afkNickname) {
          try {
            await message.member.setNickname(
              ownStatus.originalNickname ?? null,
              'Member returned from AFK'
            );
          } catch (error) {
            logger.warn(`Could not restore nickname for returning AFK member ${message.author.id}:`, error);
          }
        }

        replies.push(`👋 Welcome back, <@${message.author.id}>! Your AFK status has been cleared.`);
      }

      const mentioned = [...message.mentions.users.values()]
        .filter(user => !user.bot && user.id !== message.author.id);

      for (const user of mentioned) {
        const status = await client.db.get(getAFKKey(message.guild.id, user.id), null);
        if (!status) continue;

        const reason = String(status.reason || 'AFK').slice(0, 200);
        const since = status.since || status.timestamp || Date.now();
        const seconds = Math.max(0, Math.floor((Date.now() - Number(since)) / 1000));
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const duration = [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`]
          .filter(Boolean).join(' ') || `${seconds % 60}s`;

        replies.push(`🌙 <@${user.id}> is currently AFK: **${reason}** · Away for **${duration}**.`);
      }

      if (replies.length) {
        await message.reply({
          content: replies.join('\\n'),
          allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      logger.error('Error handling AFK message:', error);
    }
  },
};
