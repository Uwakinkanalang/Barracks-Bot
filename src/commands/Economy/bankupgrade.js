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
    .setAuthor({ name: 'BARRACKS • BANKING DIVISION' })
    .setTitle('🏦 Barracks Bank Expansion V2')
    .setDescription(
      'Need more room for your hard-earned Bcash?\n' +
      'Expand your storage with a **permanent bank capacity upgrade.**'
    )
    .addFields(
      {
        name: '📈 CAPACITY INCREASE',
        value: `**+${formatMoney(UPGRADE.capacity)}**`,
        inline: true,
      },
      {
        name: '💰 PURCHASE PRICE',
        value: `**${formatMoney(UPGRADE.price)}**`,
        inline: true,
      },
      {
        name: '🛡️ PERMANENT UPGRADE',
        value: 'Your purchased capacity is added on top of your **rank-based bank limit**.',
        inline: false,
      },
    )
    .setFooter({ text: 'Barracks • Bank Upgrade Depot  |  Secure your funds, expand your limits.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bankUpgrade:buy:${guildId}:single`)
      .setLabel('Click here to Purchase')
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
  // Required by the command loader; this command is prefix-only and is not registered as a slash command.
  async execute(interaction) {
    return interaction.reply({ content: 'Use `b!bankpanel upgrade` to post the Bank Upgrade Panel.', flags: MessageFlags.Ephemeral });
  },
  async prefixExecute(interaction, config, client) {
    const hasBankPanelAccess = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild) || interaction.member?.roles?.cache?.has('1557784202844446750');
    if (!hasBankPanelAccess) {
      return interaction.reply({ content: '❌ You need the authorized Bank Panel role or **Manage Server** permission to post the panel.' });
    }
    await interaction.channel.send(buildPanel(interaction.guildId));
    return interaction.reply({ content: '✅ Bank Upgrade Panel posted.' });
  },
};
