import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    prefixOnly: true,
    category: 'economy',
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Bet your cash on a coin flip')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount of cash to bet')
                .setRequired(true)
                .setMinValue(1)
        )
        .addStringOption(option =>
            option
                .setName('guess')
                .setDescription('Choose heads or tails (defaults to heads)')
                .setRequired(false)
                .addChoices(
                    { name: 'Heads', value: 'heads' },
                    { name: 'Tails', value: 'tails' },
                )
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const betAmount = interaction.options.getInteger('amount');
        const guess = (interaction.options.getString('guess') || 'heads').toLowerCase();

        if (!Number.isSafeInteger(betAmount) || betAmount <= 0) {
            throw createError(
                'Invalid coin flip bet',
                ErrorTypes.VALIDATION,
                'Enter a valid positive amount to bet.',
                { userId, betAmount }
            );
        }

        if (!['heads', 'tails'].includes(guess)) {
            throw createError(
                'Invalid coin flip guess',
                ErrorTypes.VALIDATION,
                'Choose either heads or tails.',
                { userId, guess }
            );
        }

        const userData = await getEconomyData(client, guildId, userId);
        if (!userData) {
            throw createError(
                'Failed to load economy data',
                ErrorTypes.DATABASE,
                'Could not load your cash balance. Please try again.',
                { userId, guildId }
            );
        }

        const wallet = Number(userData.wallet) || 0;
        if (betAmount > wallet) {
            throw createError(
                'Insufficient cash for coin flip',
                ErrorTypes.VALIDATION,
                `You only have **₱${wallet.toLocaleString()}** cash, but your bet is **₱${betAmount.toLocaleString()}**.`,
                { userId, wallet, betAmount }
            );
        }

        const result = Math.random() < 0.5 ? 'heads' : 'tails';
        const won = guess === result;

        // The stake is removed first. Correct guesses receive 2x the stake,
        // including the returned original bet; incorrect guesses lose the stake.
        userData.wallet = wallet - betAmount + (won ? betAmount * 2 : 0);
        await setEconomyData(client, guildId, userId, userData);

        const coin = result === 'heads' ? '🪙' : '🪙';
        const embed = won
            ? successEmbed(
                'Coin Flip — You Win 😄',
                `😄 The coin landed on **${result.toUpperCase()}**! You guessed correctly and received **₱${(betAmount * 2).toLocaleString()}**.`
            )
            : warningEmbed(
                'Coin Flip — You Lost 😢',
                `😢 The coin landed on **${result.toUpperCase()}**. You guessed **${guess.toUpperCase()}** and lost your **₱${betAmount.toLocaleString()}** bet.`
            );

        embed.setFooter({ text: `Your guess: ${guess.toUpperCase()} • Payout on a win: 2x your bet` });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'coinflip' })
};
