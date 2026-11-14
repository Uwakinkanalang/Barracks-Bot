import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getEconomyData, removeMoney, addMoney } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];

function colorOf(number) {
    if (number === 0) return 'GREEN';
    return RED_NUMBERS.has(number) ? 'RED' : 'BLACK';
}

function parseBet(choice) {
    const value = String(choice || '').trim().toLowerCase();
    if (['red', 'black', 'green'].includes(value)) return { type: value, value };
    if (/^\d{1,2}$/.test(value)) {
        const number = Number(value);
        if (number >= 0 && number <= 36) return { type: 'number', value: number };
    }
    return null;
}

function formatNumber(number) {
    const color = colorOf(number);
    const emoji = color === 'RED' ? '🔴' : color === 'BLACK' ? '⚫' : '🟢';
    return { color, emoji };
}

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('broulette')
        .setDescription('Play European Roulette using your bCash wallet')
        .addStringOption(option => option.setName('amount').setDescription('Amount of bCash to wager').setRequired(true))
        .addStringOption(option => option.setName('bet').setDescription('red, black, green, or a number from 0 to 36').setRequired(true)),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Roulette requires a server', ErrorTypes.VALIDATION, 'Play Roulette inside a server.');
        }

        const amountInput = interaction.options.getString('amount', true).trim().toLowerCase();
        const betInput = interaction.options.getString('bet', true);
        const bet = Number(amountInput);
        const selection = parseBet(betInput);

        if (!Number.isSafeInteger(bet) || bet <= 0) {
            throw createError('Invalid bet', ErrorTypes.VALIDATION, 'Enter a positive whole-number bCash bet.');
        }
        if (!selection) {
            throw createError('Invalid roulette bet', ErrorTypes.VALIDATION, 'Choose **red**, **black**, **green**, or a number from **0 to 36**.');
        }

        const account = await getEconomyData(client, interaction.guildId, interaction.user.id);
        const wallet = Math.max(0, Number(account.wallet) || 0);
        if (bet > wallet) {
            throw createError('Insufficient bCash', ErrorTypes.VALIDATION, `You only have **₱${wallet.toLocaleString()}** in your cash wallet.`);
        }

        await removeMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');

        const number = Math.floor(Math.random() * 37);
        const resultColor = colorOf(number);
        const won = selection.type === 'number'
            ? number === selection.value
            : selection.type === 'green'
                ? number === 0
                : resultColor.toLowerCase() === selection.value;
        const multiplier = selection.type === 'number' || selection.type === 'green' ? 36 : 2;
        const payout = won ? bet * multiplier : 0;

        const betLabel = selection.type === 'number' ? `number **${selection.value}**` : `**${selection.value.toUpperCase()}**`;
        const spinning = new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle('🎰 BARRACKS ROULETTE')
            .setDescription(`<@${interaction.user.id}> placed **₱${bet.toLocaleString()}** on ${betLabel}.\n\n🎡 **The wheel is spinning...**`)
            .setFooter({ text: 'European Roulette • 0–36' });

        await interaction.reply({ embeds: [spinning] });
        await new Promise(resolve => setTimeout(resolve, 1800));

        if (payout > 0) {
            await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
        }

        const { emoji } = formatNumber(number);
        const newBalance = wallet - bet + payout;
        const resultEmbed = new EmbedBuilder()
            .setColor(won ? 0x2ECC71 : 0xE74C3C)
            .setTitle('🎰 BARRACKS ROULETTE')
            .setDescription(
                `<@${interaction.user.id}> bet **₱${bet.toLocaleString()}** on ${betLabel}.\n\n` +
                `## ${emoji} ${number} — ${resultColor}\n\n` +
                (won
                    ? `🎉 **YOU WON!**\n**Payout:** ₱${payout.toLocaleString()} (x${multiplier})\n**Net Profit:** +₱${(payout - bet).toLocaleString()}`
                    : `💔 **YOU LOST!**\n**Lost Bet:** ₱${bet.toLocaleString()}`)
            )
            .addFields({ name: '💰 New bCash Balance', value: `₱${newBalance.toLocaleString()}`, inline: true })
            .setFooter({ text: 'European Roulette • 0–36 • Good luck, Soldier!' });

        const reply = await interaction.fetchReply();
        if (reply?.edit) {
            await reply.edit({ embeds: [resultEmbed] });
        } else {
            await interaction.editReply({ embeds: [resultEmbed] });
        }
    }, { command: 'roulette' }),
};
