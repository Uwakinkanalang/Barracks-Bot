import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('clan')
    .setDescription('Create and manage your clan')
    .addSubcommand(subcommand =>
      subcommand
        .setName('panel')
        .setDescription('Post the clan creation panel')
    ),

  category: 'Community',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🏰 BARRACKS CLAN REGISTRATION')
      .setDescription(
        'Ready to lead your own squad? Create a clan and bring your soldiers together!\n\n' +
        '**Information required**\n' +
        '• Clan Name\n' +
        '• Clan Tag (2–6 letters or numbers)\n' +
        '• Clan Description\n' +
        '• Clan Logo URL (optional)\n\n' +
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
