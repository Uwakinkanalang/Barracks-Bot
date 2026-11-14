import {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lfg-channel')
    .setDescription('Configure where Looking for Group posts are sent')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the channel for LFG posts')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('The text channel where LFG posts should appear')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand.setName('view').setDescription('Show the currently configured LFG channel')
    )
    .addSubcommand(subcommand =>
      subcommand.setName('disable').setDescription('Disable the dedicated LFG channel')
    ),

  async execute(interaction, guildConfig, client) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();
    const key = `guild:${interaction.guildId}:lfg_channel`;

    if (subcommand === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      const botMember = interaction.guild.members.me;
      const permissions = channel.permissionsFor(botMember);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel) ||
          !permissions?.has(PermissionFlagsBits.SendMessages) ||
          !permissions?.has(PermissionFlagsBits.EmbedLinks)) {
        return interaction.reply({
          content: 'I need **View Channel**, **Send Messages**, and **Embed Links** permissions in that channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await client.db.set(key, channel.id);
      return interaction.reply({
        content: `✅ LFG posts will now be sent to <#${channel.id}>. Use **/lfg** to create a party post.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'view') {
      const channelId = await client.db.get(key, null);
      if (!channelId) {
        return interaction.reply({
          content: 'No dedicated LFG channel is configured. LFG posts will be sent wherever **/lfg** is used.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        return interaction.reply({
          content: 'The saved LFG channel no longer exists. Use **/lfg-channel set** to choose another one.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({ content: `📍 Current LFG channel: <#${channel.id}>`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'disable') {
      await client.db.delete(key);
      return interaction.reply({
        content: '✅ Dedicated LFG channel disabled. New LFG posts will appear in the channel where **/lfg** is used.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
