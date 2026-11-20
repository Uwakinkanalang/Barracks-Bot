import { Events } from 'discord.js';
import { removeStarboardPost } from '../services/starboardService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageDelete,
  async execute(message, client) {
    try {
      if (message.partial) message = await message.fetch();
      if (message.guild && message.channelId !== '1540687292719439944') {
        await removeStarboardPost(message.id, client);
      }
    } catch (error) {
      logger.error('Error cleaning up deleted message from starboard:', error);
    }
  },
};
