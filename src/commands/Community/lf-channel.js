import {
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lf-channel')
    .setDescription('Configure where Looking for posts are sent')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the channel for LF posts')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('The text channel where LF posts should appear')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand.setName('view').setDescription('Show the currently configured LF channel')
    )
    .addSubcommand(subcommand =>
      subcommand.setName('disable').setDescription('Disable the dedicated LF channel')
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
        content: `✅ LF posts will now be sent to <#${channel.id}>. Use **/lf** to create a party post.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'view') {
      const channelId = await client.db.get(key, null);
      if (!channelId) {
        return interaction.reply({
          content: 'No dedicated LF channel is configured. LF posts will be sent wherever **/lf** is used.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        return interaction.reply({
          content: 'The saved LF channel no longer exists. Use **/lf-channel set** to choose another one.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({ content: `📍 Current LF channel: <#${channel.id}>`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'disable') {
      await client.db.delete(key);
      return interaction.reply({
        content: '✅ Dedicated LF channel disabled. New LF posts will appear in the channel where **/lf** is used.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
