import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const BOOST_CHANNEL_ID = '1572841358270402673';
const BOOST_BANNER_URL = 'https://cdn.discordapp.com/attachments/1572883657440366673/1572920805241790545/Salamat_Sundalo_Barracks_Boost_Banner.png?ex=6b002027&is=6afecea7&hm=398065df88e897f01aa44b531da036e5d9816656112d2baa5350fa5c07c05f75';

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('booster')
        .setDescription(`Thank you **${interaction.user}** for boosting **Barracks**!`)
            .setThumbnail(avatarURL)
            .setImage(BOOST_BANNER_URL)
            .setFooter({ text: 'BARRACKS • THANK YOU FOR YOUR SUPPORT!' })
            .setTimestamp();

        await channel.send({
            embeds: [embed],
            allowedMentions: { users: [interaction.user.id] },
        });

        await interaction.reply({
            content: `✅ Test boost announcement sent to <#${BOOST_CHANNEL_ID}>.`,
        });
    },
};
