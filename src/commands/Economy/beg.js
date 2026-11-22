import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { withEconomyTransaction } from '../../utils/economy.js';
import { botConfig } from '../../config/bot.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const COOLDOWN = 30 * 60 * 1000;
const MIN_WIN = Number(botConfig?.economy?.begMin) || 50;
const MAX_WIN = Number(botConfig?.economy?.begMax) || 200;
const SUCCESS_CHANCE = 0.7;

export default {
    data: new SlashCommandBuilder()
        .setName('beg')
        .setDescription('Beg for a small amount of money'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
            
            const userId = interaction.user.id;
            const guildId = interaction.guildId;

            const now = Date.now();
            const success = Math.random() < SUCCESS_CHANCE;
            const amountWon = success
                ? Math.floor(Math.random() * (MAX_WIN - MIN_WIN + 1)) + MIN_WIN
                : 0;

            await withEconomyTransaction(client, guildId, userId, async (accounts) => {
                const userData = accounts[userId];
                const lastBeg = Number(userData.lastBeg) || 0;
                const remainingTime = lastBeg + COOLDOWN - now;
                if (remainingTime > 0) {
                    const minutes = Math.floor(remainingTime / 60000);
                    const seconds = Math.floor((remainingTime % 60000) / 1000);
                    const timeMessage = minutes > 0 ? `${minutes} minute(s)` : `${seconds} second(s)`;
                    throw createError("Beg cooldown active", ErrorTypes.RATE_LIMIT,
                        `You are tired from begging! Try again in **${timeMessage}**.`,
                        { remainingTime, minutes, seconds, cooldownType: 'beg' });
                }
                if (success) userData.wallet = (Number(userData.wallet) || 0) + amountWon;
                userData.lastBeg = now;
                return true;
            });

            let replyEmbed;
            if (success) {
                const successMessages = [
                    `A kind stranger drops **₱${amountWon.toLocaleString()}** into your cup.`,
                    `You spotted an unattended wallet! You grab **₱${amountWon.toLocaleString()}** and run.`,
                    `Someone took pity on you and gave you **₱${amountWon.toLocaleString()}**!`,
                    `You found **₱${amountWon.toLocaleString()}** under a park bench.`,
                ];

                replyEmbed = successEmbed(
                    'Begging Successful',
                    successMessages[
                        Math.floor(Math.random() * successMessages.length)
                    ]
                );
            } else {
                const failMessages = [
                    "The police chased you off. You got nothing.",
                    "Someone yelled, 'Get a job!' and walked past.",
                    "A squirrel stole the single coin you had.",
                    "You tried to beg, but you were too embarrassed and gave up.",
                ];

                replyEmbed = warningEmbed(
                    'Insufficient Funds',
                    failMessages[Math.floor(Math.random() * failMessages.length)]
                );
            }

            await InteractionHelper.safeEditReply(interaction, { embeds: [replyEmbed] });
    }, { command: 'beg' })
};