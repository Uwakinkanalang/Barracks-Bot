import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { withEconomyTransaction } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const MINE_COOLDOWN = 60 * 60 * 1000;
const BASE_MIN_REWARD = 400;
const BASE_MAX_REWARD = 1200;
const PICKAXE_MULTIPLIER = 1.2;
const DIAMOND_PICKAXE_MULTIPLIER = 2.0;

const MINE_LOCATIONS = [
    "abandoned gold mine",
    "dark, damp cave",
    "backyard rock quarry",
    "volcanic obsidian vent",
    "deep-sea mineral trench",
];

export default {
    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Go mining to earn money'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
            
            const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const now = Date.now();

            const baseEarned = Math.floor(Math.random() * (BASE_MAX_REWARD - BASE_MIN_REWARD + 1)) + BASE_MIN_REWARD;
            const location = MINE_LOCATIONS[Math.floor(Math.random() * MINE_LOCATIONS.length)];
            const mining = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
                const userData = accounts[userId];
                const lastMine = Number(userData.lastMine) || 0;
                if (now < lastMine + MINE_COOLDOWN) {
                    const remaining = lastMine + MINE_COOLDOWN - now;
                    const hours = Math.floor(remaining / 3600000);
                    const minutes = Math.floor((remaining % 3600000) / 60000);
                    throw createError("Mining cooldown active", ErrorTypes.RATE_LIMIT,
                        `Your pickaxe is cooling down. Wait for **${hours}h ${minutes}m** before mining again.`,
                        { remaining, cooldownType: 'mine' });
                }
                const hasDiamondPickaxe = Number(userData.inventory?.diamond_pickaxe) || 0;
                const hasPickaxe = Number(userData.inventory?.pickaxe) || 0;
                let finalEarned = baseEarned;
                let multiplierMessage = "";
                if (hasDiamondPickaxe > 0) {
                    finalEarned = Math.floor(baseEarned * DIAMOND_PICKAXE_MULTIPLIER);
                    multiplierMessage = `\n💎 **Diamond Pickaxe Bonus: +100%**`;
                } else if (hasPickaxe > 0) {
                    finalEarned = Math.floor(baseEarned * PICKAXE_MULTIPLIER);
                    multiplierMessage = `\n⛏️ **Pickaxe Bonus: +20%**`;
                }
                userData.wallet = (Number(userData.wallet) || 0) + finalEarned;
                userData.lastMine = now;
                return { wallet: userData.wallet, finalEarned, multiplierMessage };
            });
            const { wallet: newWallet, finalEarned, multiplierMessage } = mining;

            const embed = successEmbed(
                "💰 Mining Expedition Successful!",
                `You explored a **${location}** and managed to find minerals worth **₱${finalEarned.toLocaleString()}**!${multiplierMessage}`,
            )
                .addFields({
                    name: "New Cash Balance",
                    value: `₱${newWallet.toLocaleString()}`,
                    inline: true,
                })
                .setFooter({ text: `Next mine available in 1 hour.` });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'mine' })
};