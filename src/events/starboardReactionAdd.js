import { Events } from 'discord.js';
import { getHumanStarCount, STARBOARD_EMOJI, syncStarboardPost } from '../services/starboardService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageReactionAdd,
  async execute(reaction, user, client) {
    try {
      if (user.bot) return;
      if (reaction.partial) reaction = await reaction.fetch();
      if (reaction.message?.partial) await reaction.message.fetch();
      if (reaction.emoji.name !== STARBOARD_EMOJI || reaction.emoji.id) return;
      if (!reaction.message?.guild || reaction.message.author?.bot) return;

      const starCount = await getHumanStarCount(reaction);
      if (starCount === null) return;
      await syncStarboardPost(reaction.message, starCount, client);
    } catch (error) {
      logger.error('Error handling starboard reaction add:', error);
    }
  },
};
