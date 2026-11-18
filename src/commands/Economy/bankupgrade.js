import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { BotConfig } from '../../config/bot.js';
import { getEconomyData, getMaxBankCapacity } from '../../utils/economy.js';

const PACKAGES = BotConfig.economy?.bankUpgradePackages || {};
const PACKAGE_ORDER = ['small', 'medium', 'large', 'elite'];
const LABELS = {
  small: 'Starter',
  medium: 'Standard',
  large: 'Premium',
  elite: 'Elite',
};

function formatMoney(value) {
  return `₱${Number(value).toLocaleString()}`;
}

function buildPanel(guildId) {
  const embed = new EmbedBuilder()
    .setColor(0xD4A017)
    .setTitle('🏦 Barracks Bank Expansion')
    .setDescription(
      'Need more room for your hard-earned Bcash? Expand your bank with a permanent capacity upgrade.\n\n' +
      '**How it works**\n' +
      '• Purchases permanently add capacity on top of your rank limit.\n' +
      '• You can buy multiple packages.\n' +
      '• Your total bank limit cannot exceed **₱100,000,000**.\n' +
      '• Payment is deducted from your **wallet**.'
    )
    .addFields(PACKAGE_ORDER.filter(key => PACKAGES[key]).map(key => ({
      name: `${LABELS[key]} — +${formatMoney(PACKAGES[key].capacity)}`,
      value: `Price: **${formatMoney(PACKAGES[key].price)}**`,
      inline: true,
    })))
    .setFooter({ text: 'Barracks • Bank Upgrade Depot' });

  const row = new ActionRowBuilder().addComponents(
    ...PACKAGE_ORDER.filter(key => PACKAGES[key]).map(key =>
      new ButtonBuilder()
        .setCustomId(`bankUpgrade:buy:${guildId}:${key}`)
        .setLabel(`Buy ${LABELS[key]}`)
        .setStyle(ButtonStyle.Success)
    )
  );
  return { embeds: [embed], components: [row] };
}

export default {
  data: new SlashCommandBuilder()
    .setName('bankupgrade')
    .setDescription('Post the Barracks bank expansion purchase panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  category: 'Economy',
  async execute(interaction, config, client) {
    const data = await getEconomyData(client, interaction.guildId, interaction.user.id);
    const currentLimit = getMaxBankCapacity(data);
    const panel = buildPanel(interaction.guildId);
    await interaction.channel.send(panel);
    return interaction.reply({
      content: `✅ Bank Upgrade Panel posted. Your current bank limit is **${formatMoney(currentLimit)}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
