import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('clan')
    .setDescription('Create and manage your clan')
    .addSubcommand(subcommand =>
      subcommand
        .setName('panel')
        .setDescription('Post the clan creation panel')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('setlogchannel')
        .setDescription('Set the channel where new clan registrations are sent')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Staff channel for clan registration notifications')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    ),

  category: 'Community',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setlogchannel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need the **Manage Server** permission to configure the clan log channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.options.getChannel('channel', true);
      await interaction.client.db.set(`guild:${interaction.guildId}:clan_log_channel`, channel.id);
      return interaction.reply({
        content: `New clan registrations will now be sent to ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🏰 BARRACKS CLAN REGISTRATION')
      .setDescription(
        'Ready to lead your own squad? Create a clan and bring your soldiers together!\n\n' +
        '**Information required**\n' +
        '• Clan Name\n' +
        '• Clan Tag + Role Hex (example: ABC | #5865F2)\n' +
        '• Clan Description\n' +
        '• Vice Clan Leader\n' +
        '• Clan Logo Upload (optional image attachment)\n\n' +
        'Your account will automatically be registered as the **Clan Leader**.'
      )
      .setFooter({ text: 'Barracks • Clan Registry' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('clan:create')
        .setLabel('Create a Clan')
        .setEmoji('🏰')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  },
};
