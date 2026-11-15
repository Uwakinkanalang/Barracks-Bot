import {
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';

const PAGE_SIZE = 18;
const SHOP_KEY = guildId => `guild:${guildId}:roleShop`;

async function getItems(client, guildId) {
  const value = await client.db.get(SHOP_KEY(guildId), []);
  return Array.isArray(value) ? value.filter(item =>
    item && typeof item.roleId === 'string' &&
    Number.isSafeInteger(item.price) && item.price > 0
  ) : [];
}

function buildPage(items, guildId, page) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageItems = items.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🛒 Role Shop\nPurchase server roles with your **bCash**!'));

  if (!pageItems.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('The Role Shop is empty. Ask an administrator to add roles with `/roleshop add`.'));
  } else {
    for (const item of pageItems) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**<@&${item.roleId}>**\n🪙 **${item.price.toLocaleString()} bCash**`))
          .setButtonAccessory(new ButtonBuilder()
            .setCustomId(`roleShop:buy:${guildId}:${item.roleId}`)
            .setLabel('Buy')
            .setStyle(ButtonStyle.Success))
      );
    }
  }

  if (pageCount > 1) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`roleShop:page:${guildId}:${currentPage - 1}`)
        .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
      new ButtonBuilder().setCustomId(`roleShop:page:${guildId}:${currentPage + 1}`)
        .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
    ));
  }
  return container;
}

export default {
  name: 'roleShop',
  async execute(interaction, client, args) {
    const [action, guildId, value] = args;
    if (!interaction.guild || interaction.guildId !== guildId) {
      return interaction.reply({ content: 'This Role Shop button is not valid in this server.', flags: MessageFlags.Ephemeral });
    }

    if (action === 'page') {
      const page = Number(value);
      if (!Number.isInteger(page)) {
        return interaction.reply({ content: 'Invalid shop page.', flags: MessageFlags.Ephemeral });
      }
      const items = await getItems(client, guildId);
      return interaction.update({ components: [buildPage(items, guildId, page)] });
    }

    if (action !== 'buy') return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roleId = value;
    const items = await getItems(client, guildId);
    const item = items.find(entry => entry.roleId === roleId);
    if (!item) {
      return interaction.editReply({ content: 'That role is no longer available in the shop.' });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.id === guildId || role.managed || role.position >= interaction.guild.members.me.roles.highest.position) {
      return interaction.editReply({ content: 'This role is unavailable. Please contact a server administrator.' });
    }
    if (member.roles.cache.has(roleId)) {
      return interaction.editReply({ content: `You already have the **${role.name}** role.` });
    }

    const economy = await getEconomyData(client, guildId, interaction.user.id);
    const balance = Number(economy?.wallet) || 0;
    if (balance < item.price) {
      return interaction.editReply({
        content: `You do not have enough bCash to buy **${role.name}**.\nPrice: **${item.price.toLocaleString()} bCash**\nYour balance: **${balance.toLocaleString()} bCash**`,
      });
    }

    try {
      await member.roles.add(role, `Purchased Role Shop role for ${item.price} bCash`);
    } catch (error) {
      return interaction.editReply({ content: 'I could not assign that role. Your bCash was not deducted. Check my Manage Roles permission and role hierarchy.' });
    }

    economy.wallet = balance - item.price;
    const saved = await setEconomyData(client, guildId, interaction.user.id, economy);
    if (!saved) {
      await member.roles.remove(role, 'Role Shop purchase rolled back because wallet save failed').catch(() => {});
      return interaction.editReply({ content: 'The purchase could not be saved, so the role assignment was rolled back. No bCash was deducted.' });
    }

    return interaction.editReply({
      content: `✅ Purchase successful! You received **${role.name}**.\nPaid: **${item.price.toLocaleString()} bCash**\nRemaining balance: **${economy.wallet.toLocaleString()} bCash**`,
    });
  },
};
