import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import botConfig from '../../config/bot.js';
import { getEconomyData, getMaxBankCapacity } from '../../utils/economy.js';

const UPGRADE = botConfig.economy?.bankUpgradePackages?.single || {
  capacity: 1000000,
  priceTiers: [
    { through: 5, price: 300000 },
    { through: 10, price: 500000 },
    { through: 15, price: 750000 },
    { through: 20, price: 1000000 },
    { through: 30, price: 1500000 },
    { through: 40, price: 2000000 },
    { through: 50, price: 2500000 },
  ],
};

function getUpgradePrice(purchaseNumber) {
  const tiers = UPGRADE.priceTiers || [];
  return tiers.find((tier) => purchaseNumber <= tier.through)?.price ?? null;
}

function formatMoney(value) {
  return `₱${Number(value).toLocaleString()}`;
}

function buildPanel(guildId) {
  const purchaseButton = new ButtonBuilder()
    .setCustomId(`bankUpgrade:buy:${guildId}:single`)
    .setLabel('Purchase')
    .setStyle(ButtonStyle.Success);

  const panel = new ContainerBuilder()
    .setAccentColor(0xD4A017)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 🏦 Barracks Bank Expansion\n' +
        'Need more room for your hard-earned Bcash?\n' +
        'Expand your storage with a **permanent bank capacity upgrade.**'
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true),
    )
.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### 📈 CAPACITY INCREASE\n' +
        `**+${formatMoney(UPGRADE.capacity)}**\n\n` +
        '### 💰 PURCHASE PRICE\n' +
        `**${formatMoney(getUpgradePrice(1))}** (1st–5th purchase)\n` +
        `**${formatMoney(getUpgradePrice(6))}** (6th–10th)\n` +
        `**${formatMoney(getUpgradePrice(11))}** (11th–15th)\n` +
        `**${formatMoney(getUpgradePrice(16))}** (16th–20th)\n` +
        `**${formatMoney(getUpgradePrice(21))}** (21st–30th)\n` +
        `**${formatMoney(getUpgradePrice(31))}** (31st–40th)\n` +
        `**${formatMoney(getUpgradePrice(41))}** (41st–50th)`
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '-# Barracks • Bank Upgrade Depot  |  Secure your funds, expand your limits.'
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(purchaseButton),
    );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [panel],
  };
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
