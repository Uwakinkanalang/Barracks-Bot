import { Events } from 'discord.js';
import { getEconomyData, updateBalance } from '../utils/economy.js';
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
      const before = await getEconomyData(client, record.guildId, record.userId);
      const amountToReverse = Math.min(
        Math.max(0, Number(record.amount) || 0),
        Math.max(0, Number(before.wallet) || 0),
      );
      const balance = amountToReverse > 0
        ? await updateBalance(client, record.guildId, record.userId, { wallet: -amountToReverse })
        : before;

      await client.db.delete(recordKey);

      logger.info(
        `Reversed ${amountToReverse} of ${record.amount} Bcash for deleted message owner ${record.userId}. Wallet balance: ${balance.wallet}.`,
      );

      try {
        const channel = await client.channels.fetch(record.channelId);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `↩️ The ${amountToReverse.toLocaleString('en-US')} Bcash message reward for <@${record.userId}> was reversed because the rewarded post was deleted.`,
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
