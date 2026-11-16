import {
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} from 'discord.js';

const PAGE_SIZE = 11;
const SHOP_KEY = (guildId) => `guild:${guildId}:roleShop`;

export async function getItems(client, guildId) {
  const value = await client.db.get(SHOP_KEY(guildId), []);
  return Array.isArray(value) ? value.filter(item =>
    item && typeof item.roleId === 'string' &&
    Number.isSafeInteger(item.price) && item.price > 0
  ) : [];
}

export function buildShopPage(items, guildId, page) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageItems = items.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🛒 B-Shop\nWelcome to the **Barracks B-Shop**! Purchase exclusive server roles with your **bCash**.'));

  if (!pageItems.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('The B-Shop is empty. The server owner can add roles with `/bshop add`.'));
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

export function buildColorShopPage(items, guild, page) {
  const colorItems = items.filter(item => {
    const role = guild.roles.cache.get(item.roleId);
    return role && role.color !== 0;
  });
  const pageCount = Math.max(1, Math.ceil(colorItems.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageItems = colorItems.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🎨 B-Shop • Color Roles\\nChoose a color for your name and purchase it with **bCash**.'));

  if (!pageItems.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('No color roles are currently available. Ask the server owner to add colored roles with `/bshop add`.'));
  } else {
    for (const item of pageItems) {
      const role = guild.roles.cache.get(item.roleId);
      const hex = `#${role.color.toString(16).padStart(6, '0').toUpperCase()}`;
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**<@&${item.roleId}>** • ${hex}\\n🪙 **${item.price.toLocaleString()} bCash**`))
        .setButtonAccessory(new ButtonBuilder()
          .setCustomId(`roleShop:buy:${guild.id}:${item.roleId}`)
          .setLabel('Buy')
          .setStyle(ButtonStyle.Success));
      container.addSectionComponents(section);
    }
  }

  if (pageCount > 1) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`roleShopColor:page:${guild.id}:${currentPage - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
      new ButtonBuilder().setCustomId(`roleShopColor:page:${guild.id}:${currentPage + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
    ));
  }
  return container;
}

export default {
  data: new SlashCommandBuilder()
    .setName('bshop')
    .setDescription('Manage the Barracks B-Shop')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a role and bCash price to the shop')
      .addRoleOption(option => option.setName('item').setDescription('Role item to sell').setRequired(true))
      .addIntegerOption(option => option.setName('price').setDescription('Price in bCash').setMinValue(1).setMaxValue(2147483647).setRequired(true)))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a role from the shop')
      .addRoleOption(option => option.setName('item').setDescription('Role item to remove').setRequired(true))),

  async execute(interaction, config, client) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.reply({
        content: 'The B-Shop can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: '❌ Only the **server owner** can manage the B-Shop.', flags: MessageFlags.Ephemeral });
    }

    const role = interaction.options.getRole('item', true);
    const items = await getItems(client, guildId);

    if (subcommand === 'add') {
      const price = interaction.options.getInteger('price', true);
      if (role.id === guildId || role.managed || role.position >= interaction.guild.members.me.roles.highest.position) {
        return interaction.reply({ content: 'That role cannot be sold. Choose a normal role below the bot’s highest role.', flags: MessageFlags.Ephemeral });
      }
      const existing = items.find(item => item.roleId === role.id);
      if (existing) {
        existing.price = price;
      } else {
        items.push({ roleId: role.id, price });
      }
      await client.db.set(SHOP_KEY(guildId), items);
      return interaction.reply({ content: `✅ ${role} is now available in the B-Shop for **${price.toLocaleString()} bCash**.${existing ? ' Its price was updated.' : ''}`, flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'remove') {
      const nextItems = items.filter(item => item.roleId !== role.id);
      if (nextItems.length === items.length) {
        return interaction.reply({ content: 'That role is not currently listed in the B-Shop.', flags: MessageFlags.Ephemeral });
      }
      await client.db.set(SHOP_KEY(guildId), nextItems);
      return interaction.reply({ content: `✅ Removed ${role} from the B-Shop.`, flags: MessageFlags.Ephemeral });
    }
  },
};
