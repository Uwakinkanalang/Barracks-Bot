import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getEconomyData, removeMoney, addMoney } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';

const SUITS = ['♠️', '♥️', '♦️', '♣️'];

function drawCard() {
    return {
        value: Math.floor(Math.random() * 13) + 1,
        suit: SUITS[Math.floor(Math.random() * SUITS.length)]
    };
}

function cardLabel(card) {
    const face = ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[card.value] || card.value;
    return `**${face}** ${card.suit}`;
}

export default {
    prefixOnly: true,
    category: 'economy',
    data: new SlashCommandBuilder()
        .setName('bhl')
        .setDescription('Higher or Lower — predict the next card and win bCash')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount of bCash to wager')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('choice')
                .setDescription('Predict whether the next card is higher or lower')
                .setRequired(true)
                .addChoices(
                    { name: 'Higher', value: 'higher' },
                    { name: 'Lower', value: 'lower' }
                )
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Higher-Lower requires a server', ErrorTypes.VALIDATION, 'Play Higher-Lower inside a server.');
        }

        const amountInput = String(interaction.options.getString('amount', true) || '').trim();
        const choice = String(interaction.options.getString('choice', true) || '').trim().toLowerCase();
        const bet = Number(amountInput);

        if (!/^\d+$/.test(amountInput) || !Number.isSafeInteger(bet) || bet <= 0) {
            throw createError('Invalid bet', ErrorTypes.VALIDATION, 'Enter a positive whole-number bCash bet. Usage: `bhl 100 higher`.');
        }
        if (!['higher', 'lower'].includes(choice)) {
            throw createError('Invalid choice', ErrorTypes.VALIDATION, 'Choose **higher** or **lower**. Usage: `bhl 100 higher`.');
        }

        const account = await getEconomyData(client, interaction.guildId, interaction.user.id);
        const wallet = Math.max(0, Number(account?.wallet) || 0);
        if (bet > wallet) {
            throw createError('Insufficient bCash', ErrorTypes.VALIDATION, `You only have **₱${wallet.toLocaleString()}** in your cash wallet.`);
        }

        await removeMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');

        const first = drawCard();
        const second = drawCard();
        const difference = second.value - first.value;
        const tie = difference === 0;
        const won = !tie && ((choice === 'higher' && difference > 0) || (choice === 'lower' && difference < 0));
        const payout = tie ? bet : (won ? bet * 2 : 0);

        try {
            if (payout > 0) {
                await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
            }
        } catch (error) {
            await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet').catch(() => {});
            throw error;
        }

        const newBalance = wallet - bet + payout;
        const resultText = tie ? '🤝 **IT’S A TIE — YOUR BET WAS RETURNED!**' : (won ? '🏆 **YOU WON!**' : '💔 **YOU LOST!**');
        const embed = new EmbedBuilder()
            .setColor(tie ? 0xF1C40F : (won ? 0x2ECC71 : 0xE74C3C))
            .setTitle('🃏 BARRACKS HIGHER-LOWER')
            .setDescription(`<@${interaction.user.id}> predicted **${choice.toUpperCase()}**.\n\n**First Card**\n${cardLabel(first)}\n\n**Next Card**\n${cardLabel(second)}`)
            .addFields(
                { name: '🎯 Your Prediction', value: choice.toUpperCase(), inline: true },
                { name: '📊 Card Result', value: tie ? 'Same value' : (difference > 0 ? 'Higher ⬆️' : 'Lower ⬇️'), inline: true },
                { name: '💰 Amount Bet', value: `₱${bet.toLocaleString()}`, inline: true },
                { name: '🏁 Result', value: resultText, inline: false },
                { name: tie ? '↩️ Bet Returned' : (won ? '💵 Payout' : '📉 Lost Bet'), value: `₱${payout.toLocaleString()}`, inline: true },
                { name: '💳 New bCash Balance', value: `**₱${newBalance.toLocaleString()}**`, inline: true }
            )
            .setFooter({ text: 'BARRACKS • HIGHER-LOWER • A = 1, K = 13 • Win pays 2x' });

        await interaction.reply({ embeds: [embed] });
    }, { command: 'bhl' })
};
