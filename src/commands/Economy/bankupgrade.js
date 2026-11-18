import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import botConfig from '../../config/bot.js';
import { getEconomyData, getMaxBankCapacity } from '../../utils/economy.js';

const UPGRADE = botConfig.economy?.bankUpgradePackages?.single || {
  capacity: 1000000,
  price: 500000,
};

function formatMoney(value) {
  return `₱${Number(value).toLocaleString()}`;
}

function buildPanel(guildId) {
  const embed = new EmbedBuilder()
    .setColor(0xD4A017)
    .setTitle('🏦 Barracks Bank Expansion')
    .setDescription(
      'Need more room for your hard-earned Bcash? Purchase a permanent bank capacity upgrade.\n\n' +
      '**Bank Upgrade**\n' +
      `Increase your bank limit by **+${formatMoney(UPGRADE.capacity)}**\n` +
      `Price: **${formatMoney(UPGRADE.price)}**\n\n` +
      'Your upgrade stacks on top of your rank-based bank limit.'
    )
    .setFooter({ text: 'Barracks • Bank Upgrade Depot' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bankUpgrade:buy:${guildId}:single`)
      .setLabel(`+₱1,000,000 for ₱500,000`)
      .setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

export default {
  prefixOnly: true,
  data: new SlashCommandBuilder()
    .setName('bankupgrade')
    .setDescription('Post the Barracks bank expansion purchase panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  category: 'Economy',
  async prefixExecute(interaction, config, client) {
    const hasBankPanelAccess = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild) || interaction.member?.roles?.cache?.has('1557784202844446750');
    if (!hasBankPanelAccess) {
      return interaction.reply({ content: '❌ You need **Manage Server** permission to post the Bank Upgrade Panel.' });
    }
    await interaction.channel.send(buildPanel(interaction.guildId));
    return interaction.reply({ content: '✅ Bank Upgrade Panel posted.' });
  },
};
