import { Events } from 'discord.js';
import { updateBalance } from '../utils/economy.js';
import { logger } from '../utils/logger.js';

const REWARD_RECORD_PREFIX = 'bcash_message_reward:message:';

export default {
  name: Events.MessageDelete,
  async execute(message, client) {
    if (!message.guildId || !message.id || !client.db) return;

    const recordKey = `${REWARD_RECORD_PREFIX}${message.id}`;

    try {
      const record = await client.db.get(recordKey, null);
      if (!record || record.guildId !== message.guildId) return;

      // Reverse up to the original reward from the wallet only; the bank is untouched.
      const balance = await updateBalance(
        client,
        record.guildId,
        record.userId,
        { wallet: -Number(record.amount || 0) },
      );

      await client.db.delete(recordKey);

      const reversed = Math.min(Number(record.amount) || 0, Number(record.amount) || 0);
      logger.info(
        `Reversed deleted-message Bcash reward for user ${record.userId}: ${reversed}. Wallet balance: ${balance.wallet}.`,
      );

      try {
        const channel = await client.channels.fetch(record.channelId);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `↩️ The **100,000 Bcash** message reward for <@${record.userId}> was reversed because the rewarded post was deleted.`,
            allowedMentions: { users: [record.userId] },
          });
        }
      } catch (notifyError) {
        logger.warn('Could not post deleted-message Bcash reversal notice:', notifyError);
      }
    } catch (error) {
      logger.error(`Failed to reverse Bcash reward for deleted message ${message.id}:`, error);
    }
  },
};
