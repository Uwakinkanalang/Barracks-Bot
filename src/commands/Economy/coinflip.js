import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const MAX_BET = 500000;
const WIN_CHANCE = 0.5;

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
        const betInput = String(interaction.options.getString('amount') ?? interaction.options.getInteger('amount') ?? '').trim().toLowerCase();
        const guess = (interaction.options.getString('guess') || 'heads').toLowerCase();

        if (betInput !== 'all' && (!/^\d+$/.test(betInput) || !Number.isSafeInteger(Number(betInput)) || Number(betInput) <= 0)) {
            throw createError(
                'Invalid coin flip bet',
                ErrorTypes.VALIDATION,
                'Enter a valid positive amount to bet.',
                { userId, betInput }
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
        // `all` means the maximum allowed BCF stake, not the user's entire wallet.
        const betAmount = betInput === 'all' ? Math.min(wallet, MAX_BET) : Number(betInput);

        if (betAmount <= 0) {
            throw createError('No cash to bet', ErrorTypes.VALIDATION, 'You do not have any cash in your wallet to bet.');
        }
        if (betAmount > MAX_BET) {
            throw createError(
                'Coin flip bet limit exceeded',
                ErrorTypes.VALIDATION,
                `The maximum BCF bet is **₱${MAX_BET.toLocaleString()}**.`,
                { userId, betAmount, maxBet: MAX_BET }
            );
        }
        if (betAmount > wallet) {
            throw createError(
                'Insufficient cash for coin flip',
                ErrorTypes.VALIDATION,
                `You only have **₱${wallet.toLocaleString()}** cash, but your bet is **₱${betAmount.toLocaleString()}**.`,
                { userId, wallet, betAmount }
            );
        }

        // Every guess has a 50% chance to match and a 50% chance to miss.
        const won = Math.random() < WIN_CHANCE;
        const result = won ? guess : (guess === 'heads' ? 'tails' : 'heads');

        // Correct guesses receive 2x the stake, including the returned original bet.
        userData.wallet = wallet - betAmount + (won ? betAmount * 2 : 0);
        await setEconomyData(client, guildId, userId, userData);

        const embed = won
            ? successEmbed(
                'Coin Flip — You Win :green_circle: 😄',
                `😄 The coin landed on **${result.toUpperCase()}**! You guessed correctly and received **₱${(betAmount * 2).toLocaleString()}**.`
            )
            : warningEmbed(
                'Coin Flip — You Lost :red_circle: 😢',
                `😢 The coin landed on **${result.toUpperCase()}**. You guessed **${guess.toUpperCase()}** and lost your **₱${betAmount.toLocaleString()}** bet.`
            );

        embed.setFooter({ text: `Your guess: ${guess.toUpperCase()} • Win chance: 50% • Payout on a win: 2x your bet` });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'coinflip' })
};
