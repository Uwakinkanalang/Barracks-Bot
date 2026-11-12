import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    SlashCommandBuilder,
} from 'discord.js';
import { removeMoney, addMoney, getEconomyData } from '../../utils/economy.js';
import { createError, ErrorTypes, withErrorHandling } from '../../utils/errorHandler.js';

const ROUND_TIMEOUT = 60 * 1000;
const FIGHT_DELAY = 1800;

function buildTalpakEmbed(game, status, color = 0xD97706, title = '🐓 BARRACKS TALPAK ARENA 🐓') {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `<@${game.userId}> Bet **₱${game.bet.toLocaleString()}**\n\n` +
            `Your pick: **${game.choice ? game.choice.toUpperCase() : 'Choose your chicken!'}**\n\n` +
            status
        )
        .setFooter({ text: 'Pick Meron or Wala • Correct pick pays 2x your bet' });
}

function buildChoiceButtons(game, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`talpak:${game.id}:meron`)
            .setLabel('🐓 MERON')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`talpak:${game.id}:wala`)
            .setLabel('🐓 WALA')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

export default {
    prefixOnly: true,
    category: 'economy',
    data: new SlashCommandBuilder()
        .setName('btalpak')
        .setDescription('Bet on a Barracks Talpak chicken fight')
        .addIntegerOption(option =>
            option.setName('bet')
                .setDescription('Amount of cash to wager')
                .setMinValue(1)
                .setMaxValue(1000000000)
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Talpak requires a server', ErrorTypes.VALIDATION, 'Play Talpak inside a server.');
        }

        const bet = interaction.options.getInteger('bet', true);
        const userData = await getEconomyData(client, interaction.guildId, interaction.user.id);
        const wallet = Number(userData?.wallet) || 0;

        if (bet > wallet) {
            throw createError(
                'Insufficient cash',
                ErrorTypes.VALIDATION,
                `You only have **₱${wallet.toLocaleString()}** in your wallet.`
            );
        }

        const game = {
            id: interaction.id,
            userId: interaction.user.id,
            bet,
            choice: null,
            finished: false,
        };

        await removeMoney(client, interaction.guildId, game.userId, bet, 'wallet');

        let message;
        try {
            message = await interaction.reply({
                embeds: [buildTalpakEmbed(game, 'Choose which chicken will win the fight!')],
                components: [buildChoiceButtons(game)],
                fetchReply: true,
            });
        } catch (error) {
            await addMoney(client, interaction.guildId, game.userId, bet, 'wallet');
            throw error;
        }

        const collector = message.createMessageComponentCollector({
            time: ROUND_TIMEOUT,
            filter: button => button.customId.startsWith(`talpak:${game.id}:`),
        });

        collector.on('collect', async button => {
            if (button.user.id !== game.userId) {
                return button.reply({ content: 'This is not your Talpak bet, Soldier!', ephemeral: true });
            }
            if (game.finished) {
                return button.reply({ content: 'This Talpak round has already ended.', ephemeral: true });
            }

            game.finished = true;
            game.choice = button.customId.endsWith(':meron') ? 'Meron' : 'Wala';
            const winner = Math.random() < 0.5 ? 'Meron' : 'Wala';
            const won = game.choice === winner;

            await button.update({
                embeds: [buildTalpakEmbed(game, '🥁 The chickens are fighting... 🐓💨', 0xD97706)],
                components: [buildChoiceButtons(game, true)],
            });

            await new Promise(resolve => setTimeout(resolve, FIGHT_DELAY));

            if (won) {
                const payout = bet * 2;
                await addMoney(client, interaction.guildId, game.userId, payout, 'wallet');
                await message.edit({
                    embeds: [buildTalpakEmbed(
                        game,
                        `🟢 🏆 **${winner.toUpperCase()} WINS!**\n\n🎉 Your chicken won! :green_circle: You received **₱${payout.toLocaleString()}** (2x payout).\n\n💰 Net profit: **₱${bet.toLocaleString()}**`,
                        0x2ECC71,
                        '🟢 TALPAK — YOU WIN!'
                    )],
                    components: [buildChoiceButtons(game, true)],
                });
            } else {
                await message.edit({
                    embeds: [buildTalpakEmbed(
                        game,
                        `🔴 💥 **${winner.toUpperCase()} WINS!**\n\n😢 Your chicken lost. :red_circle: You lost your **₱${bet.toLocaleString()}** bet. Better luck next Soldier!`,
                        0xE74C3C,
                        '🔴 TALPAK — YOU LOST!'
                    )],
                    components: [buildChoiceButtons(game, true)],
                });
            }

            collector.stop('round_finished');
        });

        collector.on('end', async (_collected, reason) => {
            if (reason === 'round_finished' || game.finished) return;
            game.finished = true;
            await addMoney(client, interaction.guildId, game.userId, bet, 'wallet');
            await message.edit({
                embeds: [buildTalpakEmbed(game, '⏰ No pick was made in time. Your bet has been refunded.', 0x808080)],
                components: [buildChoiceButtons(game, true)],
            }).catch(() => {});
        });
    }, { command: 'btalpak' }),
};
