import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { withEconomyTransaction } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const BASE_WIN_CHANCE = 0.4;
const CLOVER_WIN_BONUS = 0.1;
const CHARM_WIN_BONUS = 0.08;
const PAYOUT_MULTIPLIER = 2.0;
const GAMBLE_COOLDOWN = 5 * 60 * 1000;

export default {
    data: new SlashCommandBuilder()
        .setName('gamble')
        .setDescription('Gamble your money for a chance to win more')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount of cash to gamble')
                .setRequired(true)
                .setMinValue(1)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
            
            const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const betAmount = interaction.options.getInteger("amount");
            const now = Date.now();

            const gamble = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
                const userData = accounts[userId];
                const lastGamble = Number(userData.lastGamble) || 0;
                if (now < lastGamble + GAMBLE_COOLDOWN) {
                    const remaining = lastGamble + GAMBLE_COOLDOWN - now;
                    const minutes = Math.floor(remaining / 60000);
                    const seconds = Math.floor((remaining % 60000) / 1000);
                    throw createError("Gamble cooldown active", ErrorTypes.RATE_LIMIT,
                        `You need to cool down before gambling again. Wait **${minutes}m ${seconds}s**.`,
                        { remaining, cooldownType: 'gamble' });
                }
                const wallet = Number(userData.wallet) || 0;
                if (wallet < betAmount) {
                    throw createError("Insufficient cash for gamble", ErrorTypes.VALIDATION,
                        `You only have ₱${wallet.toLocaleString()} cash, but you are trying to bet ₱${betAmount.toLocaleString()}.`,
                        { required: betAmount, current: wallet });
                }

                userData.inventory ||= {};
                let winChance = BASE_WIN_CHANCE;
                let usedClover = false;
                let usedCharm = false;
                if ((Number(userData.inventory.lucky_clover) || 0) > 0) {
                    winChance += CLOVER_WIN_BONUS;
                    userData.inventory.lucky_clover -= 1;
                    usedClover = true;
                } else if ((Number(userData.inventory.lucky_charm) || 0) > 0) {
                    winChance += CHARM_WIN_BONUS;
                    userData.inventory.lucky_charm -= 1;
                    usedCharm = true;
                }

                const win = Math.random() < winChance;
                const amountWon = win ? Math.floor(betAmount * PAYOUT_MULTIPLIER) : 0;
                const cashChange = win ? amountWon - betAmount : -betAmount;
                userData.wallet = wallet + cashChange;
                userData.lastGamble = now;
                return {
                    win, winChance, usedClover, usedCharm,
                    cloverRemaining: Number(userData.inventory.lucky_clover) || 0,
                    charmRemaining: Number(userData.inventory.lucky_charm) || 0,
                    amountWon, newCash: userData.wallet,
                };
            });

            const { win, winChance, usedClover, usedCharm, cloverRemaining, charmRemaining, amountWon, newCash } = gamble;
            const cloverMessage = usedClover
                ? `\n🍀 **Lucky Clover Consumed:** Your win chance was boosted!`
                : usedCharm
                    ? `\n🍀 **Lucky Charm Used (${charmRemaining} uses remaining):** Your win chance was boosted!`
                    : "";

            let resultEmbed;
            if (win) {
                resultEmbed = successEmbed(
                    "🎉 You Won!",
                    `You successfully gambled and turned your **₱${betAmount.toLocaleString()}** bet into **₱${amountWon.toLocaleString()}**!${cloverMessage}`,
                );
            } else {
                resultEmbed = warningEmbed(
                    "💔 You Lost...",
                    `The dice rolled against you. You lost your **₱${betAmount.toLocaleString()}** bet.`,
                );
            }

            resultEmbed.addFields({
                name: "New Cash Balance",
                value: `₱${newCash.toLocaleString()}`,
                inline: true,
            });

            if (usedClover) {
                resultEmbed.setFooter({
                    text: `You have ${cloverRemaining} Lucky Clovers left. Win chance was ${Math.round(winChance * 100)}%.`,
                });
            } else if (usedCharm) {
                resultEmbed.setFooter({
                    text: `You have ${charmRemaining} Lucky Charm uses left. Win chance was ${Math.round(winChance * 100)}%.`,
                });
            } else {
                resultEmbed.setFooter({
                    text: `Next gamble available in 5 minutes. Base win chance: ${Math.round(BASE_WIN_CHANCE * 100)}%.`,
                });
            }

            await InteractionHelper.safeEditReply(interaction, { embeds: [resultEmbed] });
    }, { command: 'gamble' })
};