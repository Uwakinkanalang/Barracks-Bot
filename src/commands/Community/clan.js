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
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Remove the clan you lead')
    ),

  category: 'Community',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'delete') {
      const clans = await interaction.client.db.get(`guild:${interaction.guildId}:clans`, []);
      const clanList = Array.isArray(clans) ? clans : [];
      const clan = clanList.find(entry => entry.leaderId === interaction.user.id);

      if (!clan) {
        return interaction.reply({
          content: 'You do not currently lead a registered clan.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('⚠️ Confirm Clan Removal')
        .setDescription(
          `Are you sure you want to permanently remove **${clan.name} [${clan.tag}]**?\n\n` +
          'This will remove its registration from the Barracks clan registry. This action cannot be undone.'
        )
        .setFooter({ text: 'Only the Clan Leader can remove this clan.' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`clan:delete:confirm:${interaction.user.id}`)
          .setLabel('Yes, Remove My Clan')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`clan:delete:cancel:${interaction.user.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      return interaction.reply({
        embeds: [confirmEmbed],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

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
