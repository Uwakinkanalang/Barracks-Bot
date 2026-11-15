import {
    SlashCommandBuilder,
    ChannelType,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('invite-rewards')
        .setDescription('Configure the public bCash invite reward announcement channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('set-channel')
                .setDescription('Set where invite reward announcements are posted')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Text channel for invite reward announcements')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('view').setDescription('View the invite reward announcement channel')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('disable').setDescription('Disable public invite reward announcements')
        ),

    async execute(interaction, _config, client) {
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: 'This command can only be used inside a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const key = `guild:${interaction.guildId}:invite_reward_channel`;
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'set-channel') {
            const channel = interaction.options.getChannel('channel', true);
            const permissions = channel.permissionsFor(interaction.guild.members.me);
            if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                return interaction.reply({
                    content: 'I need **View Channel** and **Send Messages** permissions in that channel.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            await client.db.set(key, channel.id);
            return interaction.reply({
                content: `✅ Invite reward announcements will be posted in <#${channel.id}>. Inviter DMs will still be sent when possible.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (subcommand === 'view') {
            const channelId = await client.db.get(key, null);
            if (!channelId) {
                return interaction.reply({
                    content: 'No public invite reward channel is configured. Inviter DMs will still be sent when possible.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                return interaction.reply({
                    content: 'The saved channel no longer exists. Use **/invite-rewards set-channel** to choose another one.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            return interaction.reply({
                content: `📍 Invite reward announcements: <#${channel.id}>`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (subcommand === 'disable') {
            await client.db.delete(key);
            return interaction.reply({
                content: '✅ Public invite reward announcements are disabled. Inviter DMs will still be sent when possible.',
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
