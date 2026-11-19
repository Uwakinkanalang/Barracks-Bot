import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getTikTokConfigKey } from '../../services/tiktokAutoPostService.js';

const data = new SlashCommandBuilder()
  .setName('tiktok')
  .setDescription('Manage automatic TikTok video posts')
  .addSubcommand(s => s.setName('add').setDescription('Monitor a TikTok account')
    .addStringOption(o => o.setName('username').setDescription('TikTok username or profile URL').setRequired(true).setMaxLength(100))
    .addChannelOption(o => o.setName('channel').setDescription('Where new videos should be posted').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('remove').setDescription('Stop monitoring a TikTok account')
    .addStringOption(o => o.setName('username').setDescription('TikTok username').setRequired(true).setMaxLength(100)))
  .addSubcommand(s => s.setName('list').setDescription('List monitored TikTok accounts'))
  .addSubcommand(s => s.setName('channel').setDescription('Set the channel for TikTok notifications')
    .addChannelOption(o => o.setName('channel').setDescription('Notification channel').addChannelTypes(ChannelType.GuildText).setRequired(true)));

function normalizeUsername(input) {
  const value = input.trim();
  const match = value.match(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]+)/i);
  const username = (match?.[1] || value.replace(/^@/, '')).trim();
  return /^[A-Za-z0-9._]{2,24}$/.test(username) ? username.toLowerCase() : null;
}
function canManage(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.guild?.ownerId === interaction.user.id;
}

export default {
  data,
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    if (!canManage(interaction)) return interaction.reply({ content: '⛔ You need **Manage Server** permission to manage TikTok auto-posting.', flags: MessageFlags.Ephemeral });

    const key = getTikTokConfigKey(interaction.guildId);
    const config = await interaction.client.db.get(key, { channelId: null, accounts: [] });
    const sub = interaction.options.getSubcommand();

    if (sub === 'channel') {
      const channel = interaction.options.getChannel('channel');
      config.channelId = channel.id;
      await interaction.client.db.set(key, config);
      return interaction.reply({ content: `✅ TikTok notifications will be posted in ${channel}.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'add') {
      const username = normalizeUsername(interaction.options.getString('username'));
      if (!username) return interaction.reply({ content: '❌ Enter a valid TikTok username or profile URL.', flags: MessageFlags.Ephemeral });
      const channel = interaction.options.getChannel('channel');
      if (channel) config.channelId = channel.id;
      if (!config.channelId) return interaction.reply({ content: 'Set a notification channel first with **/tiktok channel** or choose a channel in this command.', flags: MessageFlags.Ephemeral });
      if (!Array.isArray(config.accounts)) config.accounts = [];
      if (config.accounts.some(account => account.username.toLowerCase() === username)) return interaction.reply({ content: `ℹ️ **@${username}** is already being monitored.`, flags: MessageFlags.Ephemeral });
      config.accounts.push({ username, lastVideoId: null, addedAt: new Date().toISOString() });
      await interaction.client.db.set(key, config);
      return interaction.reply({ content: `✅ Added **@${username}** to TikTok monitoring. New uploads will be posted in <#${config.channelId}>. The latest existing video is used as the starting point, so old videos won't flood the channel.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'remove') {
      const username = normalizeUsername(interaction.options.getString('username'));
      if (!username) return interaction.reply({ content: '❌ Enter a valid TikTok username.', flags: MessageFlags.Ephemeral });
      const before = config.accounts?.length || 0;
      config.accounts = (config.accounts || []).filter(account => account.username.toLowerCase() !== username);
      if (config.accounts.length === before) return interaction.reply({ content: `@${username} is not on the monitoring list.`, flags: MessageFlags.Ephemeral });
      await interaction.client.db.set(key, config);
      return interaction.reply({ content: `🗑️ Removed **@${username}** from TikTok monitoring.`, flags: MessageFlags.Ephemeral });
    }

    const accounts = config.accounts || [];
    const list = accounts.length ? accounts.map((account, index) => `${index + 1}. [@${account.username}](https://www.tiktok.com/@${account.username})`).join('\n') : 'No TikTok accounts are being monitored.';
    return interaction.reply({ content: `**TikTok Auto-Post**\n**Channel:** ${config.channelId ? `<#${config.channelId}>` : 'Not set'}\n**Accounts:**\n${list}`, flags: MessageFlags.Ephemeral });
  },
};
