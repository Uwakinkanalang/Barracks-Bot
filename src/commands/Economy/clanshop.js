import {
  SlashCommandBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
} from 'discord.js';

const PAGE_SIZE = 11;
const SHOP_KEY = guildId => `guild:${guildId}:clanShop`;

export async function getClanShopItems(client, guildId) {
  const value = await client.db.get(SHOP_KEY(guildId), []);
  return Array.isArray(value)
    ? value.filter(item => item && typeof item.roleId === 'string' && Number.isSafeInteger(item.price) && item.price > 0)
    : [];
}

export function buildClanShopPage(items, guildId, page = 0) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageItems = items.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '# 🛒 BARRACKS CLAN SHOP\n' +
      'Spend your **bCash** on available clan perks and upgrades. Check the price before purchasing!'
    ))
    .addSeparatorComponents(new SeparatorBuilder());

  if (pageItems.length) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## 🎖️ Available Items\nBrowse the items below and press **Buy** to purchase. • ${items.length} item(s) available`
    ));
    for (const item of pageItems) {
      container.addSectionComponents(new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `**<@&${item.roleId}>**\n<:barracks_coin:0> **${item.price.toLocaleString()} bCash**`
        ))
        .setButtonAccessory(new ButtonBuilder()
          .setCustomId(`clanShop:buy:${guildId}:${item.roleId}`)
          .setLabel('Buy')
          .setStyle(ButtonStyle.Success)));
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '## 👥 Clan Member Expansion\n' +
      'Upgrade your clan roster by **10 additional slots** with each purchase.\n\n' +
      '**Expansion prices**\n' +
      '• First upgrade: **10 → 20 members — 1,000,000 bCash**\n' +
      '• Every upgrade after: **+10 slots — 500,000 bCash**\n' +
      '• Maximum clan capacity: **200 members**\n\n' +
      '_Only Clan Leaders and Vice Leaders can purchase expansions._'
    ))
    .addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '**Ready to expand your roster?**\nPress the button to purchase your next +10 slots.'
      ))
      .setButtonAccessory(new ButtonBuilder()
        .setCustomId(`clanShop:buy:${guildId}:member-expansion`)
        .setLabel('Expand Clan')
        .setStyle(ButtonStyle.Success)));

  if (pageCount > 1) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`clanShop:page:${guildId}:${currentPage - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`clanShop:page:${guildId}:${currentPage + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= pageCount - 1),
    ));
  }

  return container;
}

async function manageClanShop(interaction, client) {
  if (!interaction.guildId) {
    return interaction.reply({ content: 'The Clan Shop can only be used inside a server.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.user.id !== interaction.guild.ownerId) {
    return interaction.reply({ content: '❌ Only the **server owner** can manage the Clan Shop.', flags: MessageFlags.Ephemeral });
  }

  const action = interaction.options.getSubcommand();
  const items = await getClanShopItems(client, interaction.guildId);
  if (action === 'list') {
    const description = items.length
      ? items.map(item => `<@&${item.roleId}> — **${item.price.toLocaleString()} bCash**`).join('\\n')
      : 'The Clan Shop is currently empty.';
    return interaction.reply({ content: `**Clan Shop items**\\n${description}`, flags: MessageFlags.Ephemeral });
  }

  const role = interaction.options.getRole('item', true);
  if (action === 'add') {
    const price = interaction.options.getInteger('price', true);
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id);
    if (role.id === interaction.guildId || role.managed || role.position >= botMember.roles.highest.position) {
      return interaction.reply({ content: 'That role cannot be sold. Choose a normal role below the bot’s highest role.', flags: MessageFlags.Ephemeral });
    }
    const existing = items.find(item => item.roleId === role.id);
    if (existing) existing.price = price;
    else items.push({ roleId: role.id, price });
    await client.db.set(SHOP_KEY(interaction.guildId), items);
    return interaction.reply({ content: `✅ ${role} is now available in the **Clan Shop** for **${price.toLocaleString()} bCash**.${existing ? ' Its price was updated.' : ''}`, flags: MessageFlags.Ephemeral });
  }

  const nextItems = items.filter(item => item.roleId !== role.id);
  if (nextItems.length === items.length) {
    return interaction.reply({ content: 'That role is not currently listed in the **Clan Shop**.', flags: MessageFlags.Ephemeral });
  }
  await client.db.set(SHOP_KEY(interaction.guildId), nextItems);
  return interaction.reply({ content: `✅ Removed ${role} from the **Clan Shop**.`, flags: MessageFlags.Ephemeral });
}

export async function handleClanShopPrefixCommand(message, client) {
  const content = message.content.trim();
  if (!/^clanshop(?:\s|$)/i.test(content)) return false;

  const panelMatch = content.match(/^clanshop\s+panel$/i);
  if (panelMatch) {
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const canPostPanel = message.author.id === message.guild.ownerId
      || member?.roles.cache.has('1466364437622423694');

    if (!canPostPanel) {
      await message.reply('❌ You need the **Black Knights** role to post the Clan Shop panel.');
      return true;
    }

    const items = await getClanShopItems(client, message.guild.id);
    await message.channel.send({
      components: [buildClanShopPage(items, message.guild.id, 0)],
      flags: MessageFlags.IsComponentsV2,
    });
    return true;
  }

  if (message.author.id !== message.guild.ownerId) {
    await message.reply('❌ Only the **server owner** can manage Clan Shop items.');
    return true;
  }

  const addMatch = content.match(/^clanshop\s+add\s+(?:<@&)?(\d{17,20})>?\s+(\d+)$/i);
  if (addMatch) {
    const [, roleId, priceText] = addMatch;
    const price = Number(priceText);
    if (!Number.isSafeInteger(price) || price < 1 || price > 2147483647) {
      await message.reply('❌ Enter a valid price between 1 and 2,147,483,647 bCash.');
      return true;
    }

    const role = await message.guild.roles.fetch(roleId).catch(() => null);
    const botMember = message.guild.members.me || await message.guild.members.fetch(client.user.id);
    if (!role || role.id === message.guild.id || role.managed || role.position >= botMember.roles.highest.position) {
      await message.reply('❌ That role cannot be sold. Choose a normal role below the bot’s highest role.');
      return true;
    }

    const items = await getClanShopItems(client, message.guild.id);
    const existing = items.find(item => item.roleId === role.id);
    if (existing) existing.price = price;
    else items.push({ roleId: role.id, price });

    await client.db.set(SHOP_KEY(message.guild.id), items);
    await message.reply(`✅ ${role} is now available in the **Clan Shop** for **${price.toLocaleString()} bCash**.${existing ? ' Its price was updated.' : ''}`);
    return true;
  }

  const removeMatch = content.match(/^clanshop\s+remove\s+(?:<@&)?(\d{17,20})>?$/i);
  if (removeMatch) {
    const roleId = removeMatch[1];
    const items = await getClanShopItems(client, message.guild.id);
    const nextItems = items.filter(item => item.roleId !== roleId);
    if (nextItems.length === items.length) {
      await message.reply('That role is not currently listed in the **Clan Shop**.');
      return true;
    }

    await client.db.set(SHOP_KEY(message.guild.id), nextItems);
    await message.reply(`✅ Removed <@&${roleId}> from the **Clan Shop**.`);
    return true;
  }

  await message.reply(
    '**Clan Shop commands**\n`clanshop add @role price` — Add a role or update its price\n`clanshop remove @role` — Remove a role\n`clanshop panel` — Post the public shop panel'
  );
  return true;
}

export default {
  data: new SlashCommandBuilder()
    .setName('clanshop')
    .setDescription('Manage the Clan Shop')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a role item or update its bCash price')
      .addRoleOption(option => option.setName('item').setDescription('Role item to sell').setRequired(true))
      .addIntegerOption(option => option.setName('price').setDescription('Price in bCash').setMinValue(1).setMaxValue(2147483647).setRequired(true)))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a role from the Clan Shop')
      .addRoleOption(option => option.setName('item').setDescription('Role item to remove').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('View all Clan Shop items')),

  async execute(interaction, config, client) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'The Clan Shop can only be used inside a server.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: '❌ Only the **server owner** can manage the Clan Shop.', flags: MessageFlags.Ephemeral });
    }

    const action = interaction.options.getSubcommand();
    const items = await getClanShopItems(client, interaction.guildId);
    if (action === 'list') {
      const description = items.length
        ? items.map(item => `<@&${item.roleId}> — **${item.price.toLocaleString()} bCash**`).join('\\n')
        : 'The Clan Shop is currently empty.';
      return interaction.reply({ content: `**Clan Shop items**\\n${description}`, flags: MessageFlags.Ephemeral });
    }

    const role = interaction.options.getRole('item', true);
    if (action === 'add') {
      const price = interaction.options.getInteger('price', true);
      const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id);
      if (role.id === interaction.guildId || role.managed || role.position >= botMember.roles.highest.position) {
        return interaction.reply({ content: 'That role cannot be sold. Choose a normal role below the bot’s highest role.', flags: MessageFlags.Ephemeral });
      }
      const existing = items.find(item => item.roleId === role.id);
      if (existing) existing.price = price;
      else items.push({ roleId: role.id, price });
      await client.db.set(SHOP_KEY(interaction.guildId), items);
      return interaction.reply({ content: `✅ ${role} is now available in the **Clan Shop** for **${price.toLocaleString()} bCash**.${existing ? ' Its price was updated.' : ''}`, flags: MessageFlags.Ephemeral });
    }

    const nextItems = items.filter(item => item.roleId !== role.id);
    if (nextItems.length === items.length) {
      return interaction.reply({ content: 'That role is not currently listed in the **Clan Shop**.', flags: MessageFlags.Ephemeral });
    }
    await client.db.set(SHOP_KEY(interaction.guildId), nextItems);
    return interaction.reply({ content: `✅ Removed ${role} from the **Clan Shop**.`, flags: MessageFlags.Ephemeral });
  },
};
