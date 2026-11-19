import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const BOOST_CHANNEL_ID = '1572841358270402673';
const BOOST_BANNER_URL = 'https://cdn.discordapp.com/attachments/1572883657440366673/1572920805241790545/Salamat_Sundalo_Barracks_Boost_Banner.png?ex=6b002027&is=6afecea7&hm=398065df88e897f01aa44b531da036e5d9816656112d2baa5350fa5c07c05f75';

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('booster')
        .setDescription('Barracks server boost announcement tools')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('test')
                .setDescription('Send a test of the Barracks boost thank-you announcement')
        ),

    async execute(interaction) {
        if (interaction.options.getSubcommand() !== 'test') return;

        const guild = interaction.guild;
        if (!guild) {
            await interaction.reply({ content: 'This command can only be used inside a server.' });
            return;
        }

        const channel = await guild.channels.fetch(BOOST_CHANNEL_ID).catch(() => null);
        if (!channel?.isTextBased() || !channel.send) {
            await interaction.reply({
                content: `I couldn't find the boost announcement channel (<#${BOOST_CHANNEL_ID}>). Please check the channel ID.`,
            });
            return;
        }

        const member = interaction.member;
        const avatarURL = member?.displayAvatarURL
            ? member.displayAvatarURL({ size: 256 })
            : interaction.user.displayAvatarURL({ size: 256 });

        const embed = new EmbedBuilder()
            .setColor(0xD6A632)
            .setTitle('🫡 THANK YOU FOR BOOSTING!')
            .setDescription(
                `Thank you ${interaction.user} for boosting **${guild.name}**!\\n\\n` +
                'Your support helps our Barracks grow stronger. We appreciate your contribution, soldier!'
            )
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
