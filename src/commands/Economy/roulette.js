import { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { getEconomyData, removeMoney, addMoney } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';

const RED_NUMBERS = new Set([1, 3, 5]);

function colorOf(number) {
    if (number === 0) return 'GREEN';
    return RED_NUMBERS.has(number) ? 'RED' : 'BLACK';
}

function parseBet(choice) {
    const value = String(choice || '').trim().toLowerCase();
    if (['red', 'black', 'green'].includes(value)) return { type: value, value };
    if (/^[0-6]$/.test(value)) return { type: 'number', value: Number(value) };
    return null;
}

function formatNumber(number) {
    const color = colorOf(number);
    const emoji = color === 'RED' ? '🔴' : color === 'BLACK' ? '⚫' : '🟢';
    return { color, emoji };
}

export default {
    prefixOnly: true,
    category: 'economy',
    data: new SlashCommandBuilder()
        .setName('broulette')
        .setDescription('Play Mini Roulette using your bCash wallet')
        .addStringOption(option => option.setName('amount').setDescription('Amount of bCash to wager').setRequired(true))
        .addStringOption(option => option.setName('bet').setDescription('red, black, green, or a number from 0 to 6').setRequired(true)),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Roulette requires a server', ErrorTypes.VALIDATION, 'Play Roulette inside a server.');
        }

        const amountInput = String(interaction.options.getString('amount', true) || '').trim().toLowerCase();
        const betInput = interaction.options.getString('bet', true);
        const bet = Number(amountInput);
        const selection = parseBet(betInput);

        if (!/^\d+$/.test(amountInput) || !Number.isSafeInteger(bet) || bet <= 0) {
            throw createError('Invalid bet', ErrorTypes.VALIDATION, 'Enter a positive whole-number bCash bet. Usage: `broulette 100 red`.');
        }
        if (!selection) {
            throw createError('Invalid roulette bet', ErrorTypes.VALIDATION, 'Choose **red**, **black**, **green**, or a number from **0 to 6**. Usage: `broulette 100 4`.');
        }

        const account = await getEconomyData(client, interaction.guildId, interaction.user.id);
        const wallet = Math.max(0, Number(account.wallet) || 0);
        if (bet > wallet) {
            throw createError('Insufficient bCash', ErrorTypes.VALIDATION, `You only have **₱${wallet.toLocaleString()}** in your cash wallet.`);
        }

        await removeMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');

        const number = Math.floor(Math.random() * 7);
        const resultColor = colorOf(number);
        const won = selection.type === 'number'
            ? number === selection.value
            : selection.type === 'green'
                ? number === 0
                : resultColor.toLowerCase() === selection.value;
        const multiplier = selection.type === 'number' || selection.type === 'green' ? 7 : 2;
        const payout = won ? bet * multiplier : 0;
        const betLabel = selection.type === 'number' ? `number **${selection.value}**` : `**${selection.value.toUpperCase()}**`;

        const rouletteGifBuffer = readFileSync(new URL('../../assets/roulette-spin.gif', import.meta.url));
        const spinningGif = new AttachmentBuilder(rouletteGifBuffer, { name: 'roulette-spin.gif' });

        const spinning = new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle('🎰 BARRACKS ROULETTE')
             .setDescription(`<@${interaction.user.id}> placed **₱${bet.toLocaleString()}** on ${betLabel}.\n\n🎡 **The wheel is spinning...**`)
            .setFooter({ text: 'Mini Roulette • 0–6' })
            .setImage('attachment://roulette-spin.gif');

        const sentMessage = await interaction.reply({ embeds: [spinning], files: [spinningGif], fetchReply: true });
        await new Promise(resolve => setTimeout(resolve, 1800));

        if (payout > 0) {
            await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
        }

        const { emoji } = formatNumber(number);
        const newBalance = wallet - bet + payout;
        const resultGif = new AttachmentBuilder(rouletteGifBuffer, { name: 'roulette-spin.gif' });
        const resultEmbed = new EmbedBuilder()
            .setColor(won ? 0x2ECC71 : 0xE74C3C)
            .setTitle('🎰 BARRACKS ROULETTE')
            .setDescription(`<@${interaction.user.id}> wagered **₱${bet.toLocaleString()}** on ${betLabel}.`)
            .addFields(
                { name: '🎯 Winning Number', value: `${emoji} **${number} — ${resultColor}**`, inline: true },
                { name: '🎲 Your Bet', value: `₱${bet.toLocaleString()}`, inline: true },
                { name: won ? '🏆 Result' : '💔 Result', value: won ? '**YOU WON!**' : '**YOU LOST!**', inline: true },
                { name: won ? '💰 Payout' : '📉 Lost Bet', value: won ? `₱${payout.toLocaleString()} (x${multiplier})` : `₱${bet.toLocaleString()}`, inline: true },
                { name: won ? '📈 Net Profit' : '📉 Net Result', value: `${won ? '+' : '−'}₱${Math.abs(payout - bet).toLocaleString()}`, inline: true },
                { name: '💵 New bCash Balance', value: `**₱${newBalance.toLocaleString()}**`, inline: true }
            )
            .setImage('attachment://roulette-spin.gif')
            .setFooter({ text: 'BARRACKS • MINI ROULETTE • 0–6' });

        if (sentMessage?.edit) {
            await sentMessage.edit({ embeds: [resultEmbed], files: [resultGif] });
        } else {
            await interaction.editReply({ embeds: [resultEmbed], files: [resultGif] });
        }
    }, { command: 'roulette' }),
};
