import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getEconomyData, removeMoney, addMoney } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';

const DICE_FACES = {
    1: '⚀',
    2: '⚁',
    3: '⚂',
    4: '⚃',
    5: '⚄',
    6: '⚅',
};

export default {
    prefixOnly: true,
    category: 'economy',
    data: new SlashCommandBuilder()
        .setName('bdice')
        .setDescription('Roll a dice and win bCash by guessing the number')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount of bCash to wager')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('number')
                .setDescription('Your guess: a number from 1 to 6')
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Dice requires a server', ErrorTypes.VALIDATION, 'Play Dice inside a server.');
        }

        const amountInput = String(interaction.options.getString('amount', true) || '').trim().toLowerCase();
        const guessInput = String(interaction.options.getString('number', true) || '').trim();
        const bet = Number(amountInput);
        const guess = Number(guessInput);

        if (!/^\d+$/.test(amountInput) || !Number.isSafeInteger(bet) || bet <= 0) {
            throw createError('Invalid bet', ErrorTypes.VALIDATION, 'Enter a positive whole-number bCash bet. Usage: `bdice 100 4`.');
        }
        if (!/^[1-6]$/.test(guessInput) || !Number.isInteger(guess)) {
            throw createError('Invalid guess', ErrorTypes.VALIDATION, 'Choose a number from **1 to 6**. Usage: `bdice 100 4`.');
        }

        const account = await getEconomyData(client, interaction.guildId, interaction.user.id);
        const wallet = Math.max(0, Number(account.wallet) || 0);
        if (bet > wallet) {
            throw createError('Insufficient bCash', ErrorTypes.VALIDATION, `You only have **₱${wallet.toLocaleString()}** in your cash wallet.`);
        }

        await removeMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');

        const result = Math.floor(Math.random() * 6) + 1;
        const won = result === guess;
        const payout = won ? bet * 6 : 0;

        try {
            if (payout > 0) {
                await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
            }
        } catch (error) {
            // Restore the wager if the winning payout cannot be completed.
            await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet').catch(() => {});
            throw error;
        }

        const embed = new EmbedBuilder()
            .setColor(won ? 0x2ECC71 : 0xE74C3C)
            .setTitle('🎲 BARRACKS DICE')
            .setDescription(`<@${interaction.user.id}> rolled the dice!`)
            .addFields(
                { name: '🎯 Your Guess', value: `**${guess}**`, inline: true },
                { name: '🎲 Dice Result', value: `${DICE_FACES[result]} **${result}**`, inline: true },
                { name: '💰 Amount Bet', value: `₱${bet.toLocaleString()}`, inline: true },
                { name: won ? '🏆 Result' : '💔 Result', value: won ? '**YOU WON!**' : '**YOU LOST!**', inline: true },
                { name: won ? '💵 Payout' : '📉 Lost Bet', value: won ? `₱${payout.toLocaleString()} (x6)` : `₱${bet.toLocaleString()}`, inline: true },
                { name: '💳 New bCash Balance', value: `**₱${(wallet - bet + payout).toLocaleString()}**`, inline: true }
            )
            .setFooter({ text: 'BARRACKS • DICE GAME • Guess 1–6' });

        await interaction.reply({ embeds: [embed] });
    }, { command: 'dice' }),
};
