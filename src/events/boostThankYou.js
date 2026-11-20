import { Events } from 'discord.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';

const BOOST_CHANNEL_ID = '1572841358270402673';

export default {
  name: Events.GuildMemberUpdate,
  once: false,
  async execute(oldMember, newMember) {
    try {
      if (oldMember.premiumSince || !newMember.premiumSince) return;
      const config = await getWelcomeConfig(newMember.client, newMember.guild.id);
      if (config.boostEnabled === false) return;
      const channelId = config.boostChannelId || BOOST_CHANNEL_ID;
      const channel = await newMember.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || !channel.send) return;
      const message = formatWelcomeMessage(
        config.boostMessage || 'Thank you {user} for boosting {server}! Your support means a lot to us.',
        { user: newMember.user, guild: newMember.guild, member: newMember }
      );
      await channel.send({ content: message, allowedMentions: { users: [newMember.id] } });
    } catch (error) {
      console.error('[BOOST THANK YOU] Failed to send boost announcement:', error);
    }
  },
};
