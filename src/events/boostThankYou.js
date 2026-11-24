import { Events } from 'discord.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { buildMemberAnnouncementEmbed } from '../utils/announcementEmbeds.js';

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
      const embedSettings = config.boostEmbed || { color: '#C3F36B', title: '🚀 Thank You for Boosting!' };
      const hasEmbedContent = [embedSettings.authorName, embedSettings.title, embedSettings.description, embedSettings.thumbnailUrl, embedSettings.imageUrl, embedSettings.footerIconUrl, embedSettings.footerText].some(value => String(value || '').trim());
      const embed = hasEmbedContent ? buildMemberAnnouncementEmbed(embedSettings, { user: newMember.user, guild: newMember.guild, member: newMember }, { color: '#C3F36B' }) : null;
      await channel.send({ content: message || undefined, embeds: embed ? [embed] : [], allowedMentions: { users: [newMember.id] } });
    } catch (error) {
      console.error('[BOOST THANK YOU] Failed to send boost announcement:', error);
    }
  },
};
