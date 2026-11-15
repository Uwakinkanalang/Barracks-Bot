import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const PAGE_SIZE = 11;
const SHOP_KEY = (guildId) => `guild:${guildId}:roleShop`;

async function getItems(client, guildId) {
  const value = await client.db.get(SHOP_KEY(guildId), []);
  return Array.isArray(value) ? value.filter(item =>
    item && typeof item.roleId === 'string' &&
    Number.isSafeInteger(item.price) && item.price > 0
  ) : [];
}

function buildShopPage(items, guildId, page) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageItems = items.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🛒 B-Shop\nWelcome to the **Barracks B-Shop**! Purchase exclusive server roles with your **bCash**.'));

  if (!pageItems.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('The B-Shop is empty. Ask a Barracks administrator to add some roles with `/bshop add`.'));
  } else {
    for (const item of pageItems) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**<@&${item.roleId}>**\n🪙 **${item.price.toLocaleString()} bCash**`)
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`roleShop:buy:${guildId}:${item.roleId}`)
            .setLabel('Buy')
            .setStyle(ButtonStyle.Success)
        );
      container.addSectionComponents(section);
    }
  }

  if (pageCount > 1) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`roleShop:page:${guildId}:${currentPage - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage === 0),
        new ButtonBuilder()
          .setCustomId(`roleShop:page:${guildId}:${currentPage + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= pageCount - 1),
      )
    );
  }
  return container;
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

export default {
  data: new SlashCommandBuilder()
    .setName('bshop')
    .setDescription('Browse and manage the Barracks B-Shop')
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('View roles available for purchase'))
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a role and bCash price to the shop')
      .addRoleOption(option => option.setName('role').setDescription('Role to sell').setRequired(true))
      .addIntegerOption(option => option.setName('price').setDescription('Price in bCash').setMinValue(1).setMaxValue(2147483647).setRequired(true)))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a role from the shop')
      .addRoleOption(option => option.setName('role').setDescription('Role to remove').setRequired(true))),

  async execute(interaction, config, client) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) {
      return InteractionHelper.universalReply(interaction, {
        content: 'The B-Shop can only be used inside a server.',
        ephemeral: true,
      });
    }

    if (subcommand === 'list') {
      const items = await getItems(client, guildId);
      return interaction.reply({
        components: [buildShopPage(items, guildId, 0)],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    if (!isAdmin(interaction)) {
      return InteractionHelper.universalReply(interaction, {
        content: 'Only server administrators can manage the B-Shop.',
        ephemeral: true,
      });
    }

    const role = interaction.options.getRole('role', true);
    const items = await getItems(client, guildId);

    if (subcommand === 'add') {
      const price = interaction.options.getInteger('price', true);
      if (role.id === guildId || role.managed || role.position >= interaction.guild.members.me.roles.highest.position) {
        return InteractionHelper.universalReply(interaction, {
          content: 'That role cannot be sold. Choose a normal role below the bot’s highest role.',
          ephemeral: true,
        });
      }
      const existing = items.find(item => item.roleId === role.id);
      if (existing) {
        existing.price = price;
      } else {
        items.push({ roleId: role.id, price });
      }
      await client.db.set(SHOP_KEY(guildId), items);
      return InteractionHelper.universalReply(interaction, {
        content: `✅ ${role} is now available in the B-Shop for **${price.toLocaleString()} bCash**.${existing ? ' Its price was updated.' : ''}`,
        ephemeral: true,
      });
    }

    if (subcommand === 'remove') {
      const nextItems = items.filter(item => item.roleId !== role.id);
      if (nextItems.length === items.length) {
        return InteractionHelper.universalReply(interaction, {
          content: 'That role is not currently listed in the Role Shop.',
          ephemeral: true,
        });
      }
      await client.db.set(SHOP_KEY(guildId), nextItems);
      return InteractionHelper.universalReply(interaction, {
        content: `✅ Removed ${role} from the B-Shop.`,
        ephemeral: true,
      });
    }
  },
};
