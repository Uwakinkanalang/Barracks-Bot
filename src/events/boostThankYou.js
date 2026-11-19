import { EmbedBuilder, Events } from 'discord.js';

const BOOST_CHANNEL_ID = '1572841358270402673';
const BOOST_BANNER_URL = 'https://cdn.discordapp.com/attachments/1572883657440366673/1572920805241790545/Salamat_Sundalo_Barracks_Boost_Banner.png?ex=6b002027&is=6afecea7&hm=398065df88e897f01aa44b531da036e5d9816656112d2baa5350fa5c07c05f75';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      // Announce only when a member starts boosting, not on unrelated member updates.
      if (oldMember.premiumSince || !newMember.premiumSince) return;

      const channel = await newMember.guild.channels.fetch(BOOST_CHANNEL_ID).catch(() => null);
      if (!channel?.isTextBased() || !channel.send) return;

      const embed = new EmbedBuilder()
        .setColor(0xD6A632)
        .setTitle(`${newMember} boosted the server!`)
        .setDescription(`Your support helps our Barracks grow stronger.\nWe appreciate your contribution, soldier!`)
        .setThumbnail(newMember.displayAvatarURL({ size: 256 }))
        .setImage(BOOST_BANNER_URL)
        .setFooter({ text: 'BARRACKS • THANK YOU FOR YOUR SUPPORT!' })
        .setTimestamp();

      await channel.send({
        embeds: [embed],
        allowedMentions: { users: [newMember.id] },
      });
    } catch (error) {
      console.error('[BOOST THANK YOU] Failed to send boost announcement:', error);
    }
  },
};
