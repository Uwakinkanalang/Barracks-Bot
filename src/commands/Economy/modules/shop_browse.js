import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ComponentType,
    EmbedBuilder,
} from 'discord.js';
import { shopItems } from '../../../config/shop/items.js';
import { getColor } from '../../../config/bot.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError } from '../../../utils/errorHandler.js';

const CATEGORIES = [
    { label: 'All Items', value: 'all', emoji: '🛒' },
    { label: 'Consumables', value: 'consumable', emoji: '🧪' },
    { label: 'Tools', value: 'tool', emoji: '🛠️' },
    { label: 'Upgrades', value: 'upgrade', emoji: '✨' },
    { label: 'Roles', value: 'role', emoji: '👑' },
];

export default {
    async execute(interaction, config, client) {
        try {
            let category = 'all';
            let currentPage = 0;
            let selectedItem = null;

            const getFilteredItems = () => category === 'all'
                ? shopItems
                : shopItems.filter(item => item.type === category);

            const createEmbed = () => {
                const items = getFilteredItems();
                const ITEMS_PER_PAGE = 4;
                const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
                currentPage = Math.min(currentPage, totalPages - 1);
                const pageItems = items.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);

                const embed = new EmbedBuilder()
                    .setTitle('🛒 BARRACKS • bCASH SHOP')
                    .setColor(getColor('primary'))
                    .setDescription(
                        'Welcome to the Barracks Shop!\n' +
                        'Browse the categories below and spend your **bCash (₱)** on items.'
                    );

                if (pageItems.length) {
                    for (const item of pageItems) {
                        embed.addFields({
                            name: `${item.name}  •  ₱${item.price.toLocaleString()}`,
                            value: `ID: \`${item.id}\`  |  ${item.type.toUpperCase()}\n${item.description}`,
                            inline: false,
                        });
                    }
                } else {
                    embed.setDescription('There are no items in this category yet.');
                }

                if (selectedItem) {
                    const item = shopItems.find(entry => entry.id === selectedItem);
                    if (item) {
                        embed.addFields({
                            name: 'Selected Item',
                            value: `**${item.name}** — ₱${item.price.toLocaleString()}\nUse \`b!buy ${item.id}\` to purchase.`,
                            inline: false,
                        });
                    }
                }

                embed.setFooter({
                    text: `Category: ${category === 'all' ? 'All Items' : category} • Page ${currentPage + 1}/${totalPages} • Prices in PHP`,
                });
                return embed;
            };

            const createComponents = () => {
                const items = getFilteredItems();
                const ITEMS_PER_PAGE = 4;
                const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
                const categoryMenu = new StringSelectMenuBuilder()
                    .setCustomId('barracks_shop_category')
                    .setPlaceholder('Choose a shop category')
                    .addOptions(CATEGORIES.map(option => ({
                        label: option.label,
                        value: option.value,
                        emoji: option.emoji,
                        default: option.value === category,
                    })));

                const rows = [new ActionRowBuilder().addComponents(categoryMenu)];

                if (items.length) {
                    const pageItems = items.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);
                    const itemMenu = new StringSelectMenuBuilder()
                        .setCustomId('barracks_shop_item')
                        .setPlaceholder('Select an item to see its purchase command')
                        .addOptions(pageItems.map(item => ({
                            label: item.name.slice(0, 100),
                            description: `₱${item.price.toLocaleString()} • ${item.type}`.slice(0, 100),
                            value: item.id,
                            default: item.id === selectedItem,
                        })));
                    rows.push(new ActionRowBuilder().addComponents(itemMenu));
                }

                if (totalPages > 1) {
                    rows.push(new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('barracks_shop_prev')
                            .setLabel('Previous')
                            .setEmoji('⬅️')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPage === 0),
                        new ButtonBuilder()
                            .setCustomId('barracks_shop_next')
                            .setLabel('Next')
                            .setEmoji('➡️')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPage >= totalPages - 1),
                    ));
                }
                return rows;
            };

            const message = await interaction.reply({
                embeds: [createEmbed()],
                components: createComponents(),
            });

            const collector = message.createMessageComponentCollector({
                time: 300000,
            });

            collector.on('collect', async component => {
                if (component.user.id !== interaction.user.id) {
                    await component.reply({
                        content: 'This shop panel belongs to someone else. Run `b!shop` to open your own.',
                        ephemeral: true,
                    });
                    return;
                }

                if (component.customId === 'barracks_shop_category') {
                    category = component.values[0];
                    currentPage = 0;
                    selectedItem = null;
                } else if (component.customId === 'barracks_shop_item') {
                    selectedItem = component.values[0];
                } else if (component.customId === 'barracks_shop_prev') {
                    currentPage = Math.max(0, currentPage - 1);
                } else if (component.customId === 'barracks_shop_next') {
                    const totalPages = Math.max(1, Math.ceil(getFilteredItems().length / 4));
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                }

                await component.update({
                    embeds: [createEmbed()],
                    components: createComponents(),
                });
            });

            collector.on('end', async () => {
                try {
                    await message.edit({ components: [] });
                } catch (error) {
                    logger.debug('shop_browse: could not disable panel on collector end', {
                        error: error.message,
                    });
                }
            });
        } catch (error) {
            await handleInteractionError(interaction, error, { command: 'shop_browse' });
        }
    },
};
