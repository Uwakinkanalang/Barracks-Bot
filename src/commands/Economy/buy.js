import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { shopItems } from '../../config/shop/items.js';
import { withEconomyTransaction, addMoney } from '../../utils/economy.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const SHOP_ITEMS = shopItems;

export default {
    data: new SlashCommandBuilder()
        .setName('buy')
        .setDescription('Buy an item from the shop')
        .addStringOption(option =>
            option
                .setName('item_id')
                .setDescription('ID of the item to buy')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('quantity')
                .setDescription('Quantity to buy (default: 1)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(10)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

            const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const itemId = interaction.options.getString("item_id").toLowerCase();
            const quantity = interaction.options.getInteger("quantity") || 1;

            const item = SHOP_ITEMS.find(i => i.id === itemId);

            if (!item) {
                throw createError(
                    `Item ${itemId} not found`,
                    ErrorTypes.VALIDATION,
                    `The item ID \`${itemId}\` does not exist in the shop.`,
                    { itemId }
                );
            }

            if (quantity < 1) {
                throw createError(
                    "Invalid quantity",
                    ErrorTypes.VALIDATION,
                    "You must purchase a quantity of 1 or more.",
                    { quantity }
                );
            }

            const totalCost = item.price * quantity;

            const guildConfig = await getGuildConfig(client, guildId);
            const PREMIUM_ROLE_ID = guildConfig.premiumRoleId;

            let role = null;
            if (item.type === "role" && itemId === "premium_role") {
                if (!PREMIUM_ROLE_ID) {
                    throw createError("Premium role not configured", ErrorTypes.CONFIGURATION,
                        "The **Premium Shop Role** has not been configured by a server administrator yet.", { itemId });
                }
                if (interaction.member.roles.cache.has(PREMIUM_ROLE_ID)) {
                    throw createError("Role already owned", ErrorTypes.VALIDATION,
                        `You already have the **${item.name}** role.`, { itemId, roleId: PREMIUM_ROLE_ID });
                }
                if (quantity > 1) {
                    throw createError("Invalid quantity for role", ErrorTypes.VALIDATION,
                        `You can only purchase the **${item.name}** role once.`, { itemId, quantity });
                }
                role = interaction.guild.roles.cache.get(PREMIUM_ROLE_ID);
                if (!role) {
                    throw createError("Role not found", ErrorTypes.CONFIGURATION,
                        "The configured premium role no longer exists in this guild.", { roleId: PREMIUM_ROLE_ID });
                }
            }

            const userData = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
                const account = accounts[userId];
                const currentWallet = Number(account.wallet) || 0;
                if (currentWallet < totalCost) {
                    throw createError("Insufficient funds", ErrorTypes.VALIDATION,
                        `You need **₱${totalCost.toLocaleString()}** to purchase ${quantity}x **${item.name}**, but you only have **₱${currentWallet.toLocaleString()}** in cash.`,
                        { required: totalCost, current: currentWallet, itemId, quantity });
                }
                account.wallet = currentWallet - totalCost;
                if (item.type === "upgrade") {
                    account.upgrades ||= {};
                    account.upgrades[itemId] = true;
                } else if (item.type === "consumable" || item.type === "tool") {
                    account.inventory ||= {};
                    account.inventory[itemId] = (Number(account.inventory[itemId]) || 0) + quantity;
                }
                return structuredClone(account);
            });

            let successDescription = `You successfully purchased ${quantity}x **${item.name}** for **₱${totalCost.toLocaleString()}**!`;
            if (item.type === "role" && itemId === "premium_role") {
                try {
                    await interaction.member.roles.add(role, `Purchased role: ${item.name}`);
                    successDescription += `\\n\\n**👑 The role ${role.toString()} has been granted to you!**`;
                } catch (roleError) {
                    try {
                        await addMoney(client, guildId, userId, totalCost, 'premium role purchase refund');
                    } catch (refundError) {
                        throw createError("Role assignment and refund failed", ErrorTypes.DATABASE,
                            "The role could not be granted and the automatic refund failed. Please contact staff with your purchase details.",
                            { roleId: PREMIUM_ROLE_ID, originalError: roleError.message, refundError: refundError.message });
                    }
                    throw createError("Role assignment failed", ErrorTypes.DISCORD_API,
                        "The role could not be granted. Your cash has been refunded.",
                        { roleId: PREMIUM_ROLE_ID, originalError: roleError.message });
                }
            } else if (item.type === "upgrade") {
                successDescription += `\\n\\n**✨ Your upgrade is now active!**`;
            } else if (item.type === "tool") {
                successDescription += `\\n\\n**🛠️ ${item.name} added to your inventory!**`;
            }

            const embed = successEmbed(
                "💰 Purchase Successful",
                successDescription,
            ).addFields({
                name: "New Balance",
                value: `₱${userData.wallet.toLocaleString()}`,
                inline: true,
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }, { command: 'buy' })
};