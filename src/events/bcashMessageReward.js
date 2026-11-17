import { Events } from 'discord.js';
import { addMoney } from '../utils/economy.js';
import { logger } from '../utils/logger.js';

const REWARD_CHANNEL_ID = '1563763070915051601';
const REWARD_AMOUNT = 100000;
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

// Prevent two messages from the same member being credited concurrently.
const processingUsers = new Set();

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (!message.guild || message.author.bot || message.webhookId) return;
    // Forum posts are messages inside threads, so match the thread's parent forum too.
    const isRewardChannel = message.channelId === REWARD_CHANNEL_ID ||
      message.channel?.parentId === REWARD_CHANNEL_ID;
    if (!isRewardChannel) return;

    // Count text, attachment, and sticker posts; ignore empty messages.
    // A forum post's title is the thread name; its starter message body can be empty.
    const isForumPost = message.channel?.isThread?.() && message.channel?.parentId === REWARD_CHANNEL_ID;
    const hasContent = Boolean(message.content?.trim()) ||
      (isForumPost && Boolean(message.channel?.name?.trim())) ||
      (message.attachments?.size || 0) > 0 ||
      (message.stickers?.size || 0) > 0;
    if (!hasContent) return;

    const userId = message.author.id;
    const guildId = message.guild.id;
    const cooldownKey = `guild:${guildId}:bcash_message_reward:${userId}`;

    if (processingUsers.has(userId)) return;
    processingUsers.add(userId);

    let claimedAt = null;
    let rewardCredited = false;
    try {
      const now = Date.now();
      const lastRewardAt = Number(await client.db.get(cooldownKey, 0)) || 0;
      const remaining = COOLDOWN_MS - (now - lastRewardAt);

      if (remaining > 0) return;

      // Persist the cooldown before crediting to avoid duplicate rewards on rapid posts.
      claimedAt = now;
      await client.db.set(cooldownKey, claimedAt);

      const reward = await addMoney(client, guildId, userId, REWARD_AMOUNT, 'wallet');
      rewardCredited = true;
      // Persist the source message so its reward can be reversed if it is deleted.
      await client.db.set(`bcash_message_reward:message:${message.id}`, {
        guildId,
        userId,
        amount: REWARD_AMOUNT,
        channelId: message.channelId,
        rewardedAt: now,
      });
      const newBalance = Number(reward?.newBalance);

      await message.reply({
        content: [
          '💰 **Bcash Message Reward**',
          '',
          `🎖️ <@${userId}> earned **₱100,000 Bcash** for posting!`,
          `💳 **Wallet Balance:** ₱${Number.isFinite(newBalance) ? newBalance.toLocaleString('en-US') : 'Updated'}`,
          '⏳ **Next Reward:** Available in **3 hours**.',
          '',
          '🫡 Keep posting, soldier!',
        ].join('\n'),
        allowedMentions: { users: [userId], repliedUser: false },
      });
    } catch (error) {
      // If crediting fails, remove only the cooldown value written by this attempt.
      if (claimedAt !== null && !rewardCredited) {
        const current = Number(await client.db.get(cooldownKey, 0)) || 0;
        if (current === claimedAt) await client.db.delete(cooldownKey).catch(() => {});
      }
      logger.error('Failed to award Bcash message reward:', error);
    } finally {
      processingUsers.delete(userId);
    }
  },
};