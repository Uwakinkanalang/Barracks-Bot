import { Events } from 'discord.js';
import { getAFKKey } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (!message.guild || message.author.bot) return;

    // AFK nickname restoration is Barracks-only; AFK status/replies still work elsewhere.
    const isBarracksGuild = Boolean(process.env.GUILD_ID) && message.guild.id === process.env.GUILD_ID;

    try {
      const replies = [];
      const ownKey = getAFKKey(message.guild.id, message.author.id);
      const ownStatus = await client.db.get(ownKey, null);

      if (ownStatus) {
        await client.db.delete(ownKey);

        // Fetch a fresh member record so a stale message-member cache cannot leave [AFK] behind.
        if (isBarracksGuild) try {
          const member = await message.guild.members.fetch(message.author.id);
          const currentNickname = member.nickname;

          if (ownStatus.afkNickname && currentNickname === ownStatus.afkNickname) {
            await member.setNickname(
              ownStatus.originalNickname ?? null,
              'Member returned from AFK'
            );
          } else if (currentNickname?.startsWith('[AFK] ')) {
            // If the member changed their nickname while away, preserve that new name
            // and remove only the AFK marker.
            await member.setNickname(
              currentNickname.slice('[AFK] '.length) || null,
              'Remove AFK marker when member returns'
            );
          }
        } catch (error) {
          logger.warn(`Could not restore nickname for returning AFK member ${message.author.id}:`, error);
        }

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
