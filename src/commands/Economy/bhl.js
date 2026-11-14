import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getEconomyData, removeMoney, addMoney } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';

const SUITS = ['♠️', '♥️', '♦️', '♣️'];

function drawCard() {
    return {
        value: Math.floor(Math.random() * 13) + 2,
        suit: SUITS[Math.floor(Math.random() * SUITS.length)]
    };
}

function cardFace(value) {
    return ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[value] || String(value);
}

function cardDisplay(card) {
    const fence = String.fromCharCode(96).repeat(3);
    return `${fence}
╭─────────╮
│ ${String(card.value).padEnd(7, ' ')}│
│         │
│    ${card.suit}    │
│         │
│${cardFace(card.value).padStart(7, ' ')} │
╰─────────╯
${fence}`;
}

function makeButtons(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bhl_higher').setLabel('HIGHER ⬆️').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId('bhl_lower').setLabel('⬇️ LOWER').setStyle(ButtonStyle.Danger).setDisabled(disabled)
    );
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
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Higher-Lower requires a server', ErrorTypes.VALIDATION, 'Play Higher-Lower inside a server.');
        }

        const amountInput = String(interaction.options.getString('amount', true) || '').trim();
        const bet = Number(amountInput);

        if (!/^\d+$/.test(amountInput) || !Number.isSafeInteger(bet) || bet <= 0) {
            throw createError('Invalid bet', ErrorTypes.VALIDATION, 'Enter a positive whole-number bCash bet. Usage: `bhl 100`.');
        }

        const account = await getEconomyData(client, interaction.guildId, interaction.user.id);
        const wallet = Math.max(0, Number(account?.wallet) || 0);
        if (bet > wallet) {
            throw createError('Insufficient bCash', ErrorTypes.VALIDATION, `You only have **₱${wallet.toLocaleString()}** in your cash wallet.`);
        }

        await removeMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');

        const first = drawCard();
        const startEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🃏 BARRACKS HIGHER-LOWER')
            .setDescription(`<@${interaction.user.id}>, will the next card be **HIGHER** or **LOWER**?\n\n**YOUR CARD**\n${cardDisplay(first)}\n\nChoose a button below to make your prediction!`)
            .addFields(
                { name: '💰 Your Bet', value: `₱${bet.toLocaleString()}`, inline: true },
                { name: '🎯 Possible Values', value: '2 to 14 (Ace is high)', inline: true }
            )
            .setFooter({ text: 'Correct guess pays 2x • Tie returns your bet • You have 30 seconds' });

        let gameMessage;
        try {
            gameMessage = await interaction.reply({
                embeds: [startEmbed],
                components: [makeButtons()],
                fetchReply: true
            });
        } catch (error) {
            await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet').catch(() => {});
            throw error;
        }

        const collector = gameMessage.createMessageComponentCollector({
            time: 30000,
            max: 1,
            filter: button => button.user.id === interaction.user.id
        });

        collector.on('collect', async button => {
            await button.deferUpdate();
            const choice = button.customId === 'bhl_higher' ? 'higher' : 'lower';
            const second = drawCard();
            const tie = second.value === first.value;
            const won = !tie && ((choice === 'higher' && second.value > first.value) || (choice === 'lower' && second.value < first.value));
            const payout = tie ? bet : (won ? bet * 2 : 0);

            try {
                if (payout > 0) {
                    await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
                }
            } catch (error) {
                await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet').catch(() => {});
                const failedEmbed = new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle('⚠️ HIGHER-LOWER ERROR')
                    .setDescription('The payout could not be processed. Your bet has been refunded.');
                await gameMessage.edit({ embeds: [failedEmbed], components: [makeButtons(true)] }).catch(() => {});
                return;
            }

            const newBalance = wallet - bet + payout;
            const outcome = tie
                ? '🤝 **TIE! Your bet has been returned.**'
                : (won ? '🏆 **YOU WON!**' : '💔 **YOU LOST!**');
            const resultEmbed = new EmbedBuilder()
                .setColor(tie ? 0xF1C40F : (won ? 0x2ECC71 : 0xE74C3C))
                .setTitle('🃏 BARRACKS HIGHER-LOWER')
                .setDescription(`<@${interaction.user.id}> picked **${choice.toUpperCase()}**!\n\n**YOUR CARD**\n${cardDisplay(first)}\n\n**NEXT CARD**\n${cardDisplay(second)}`)
                .addFields(
                    { name: '📊 Card Values', value: `**${first.value}** → **${second.value}**`, inline: true },
                    { name: '🏁 Result', value: outcome, inline: true },
                    { name: tie ? '↩️ Bet Returned' : (won ? '💵 Payout' : '📉 Lost Bet'), value: `₱${payout.toLocaleString()}`, inline: true },
                    { name: '💳 New bCash Balance', value: `**₱${newBalance.toLocaleString()}**`, inline: true }
                )
                .setFooter({ text: 'BARRACKS • HIGHER-LOWER • Ace = 14 • Correct guess pays 2x' });

            await gameMessage.edit({ embeds: [resultEmbed], components: [makeButtons(true)] });
        });

        collector.on('end', async collected => {
            if (collected.size === 0) {
                await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet').catch(() => {});
                const timeoutEmbed = new EmbedBuilder()
                    .setColor(0x95A5A6)
                    .setTitle('⏰ HIGHER-LOWER • TIME UP')
                    .setDescription(`<@${interaction.user.id}>, you didn't choose Higher or Lower in time. Your **₱${bet.toLocaleString()}** bet has been returned.`);
                await gameMessage.edit({ embeds: [timeoutEmbed], components: [makeButtons(true)] }).catch(() => {});
            }
        });
    }, { command: 'bhl' })
};
