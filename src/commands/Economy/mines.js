import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    SlashCommandBuilder,
} from 'discord.js';
import { getEconomyData, removeMoney, addMoney } from '../../utils/economy.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';

const BOARD_SIZE = 9;
const COLLECTOR_TIME = 2 * 60 * 1000;
const HOUSE_EDGE = 0.97;
const FIXED_MINE_COUNT = 3;

function getMultiplier(safePicks, mineCount) {
    if (safePicks <= 0) return 1;
    let survivalChance = 1;
    for (let i = 0; i < safePicks; i++) {
        survivalChance *= (BOARD_SIZE - mineCount - i) / (BOARD_SIZE - i);
    }
    return HOUSE_EDGE / survivalChance;
}

function buildBoard(game, ended = false, explodedIndex = -1) {
    const rows = [];
    for (let row = 0; row < 3; row++) {
        const buttons = [];
        for (let col = 0; col < 3; col++) {
            const index = row * 3 + col;
            const isMine = game.mines.has(index);
            const isRevealed = game.revealed.has(index);
            let emojiName;
            let label = '?';
            let style = ButtonStyle.Secondary;

            if (isRevealed && !isMine) {
                emojiName = '💎';
                style = ButtonStyle.Success;
            } else if (ended && isMine) {
                emojiName = index === explodedIndex ? '💥' : '💣';
                style = ButtonStyle.Danger;
            } else if (ended) {
                // Reveal every safe tile when the round ends, including tiles the player never picked.
                emojiName = '💎';
                style = ButtonStyle.Success;
            }

            const tileButton = new ButtonBuilder()
                .setCustomId(`mines:${game.id}:${index}`)
                .setStyle(style)
                .setDisabled(ended || isRevealed);
            if (emojiName) {
                tileButton.setLabel('');
                tileButton.setEmoji({ name: emojiName });
            } else {
                tileButton.setLabel(label);
            }
            buttons.push(tileButton);
        }
        rows.push(new ActionRowBuilder().addComponents(buttons));
    }

    if (!ended) {
        rows.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mines:${game.id}:cashout`)
                     .setLabel('💵 Cash Out')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(game.revealed.size === 0)
            )
        );
    }
    return rows;
}

function gameEmbed(game, status = 'in progress', extra = '') {
    const safePicks = game.revealed.size;
    const multiplier = getMultiplier(safePicks, game.mineCount);
    const nextPayout = Math.floor(game.bet * getMultiplier(safePicks + 1, game.mineCount));
    const cashoutMultiplier = safePicks > 0 ? multiplier : 0;

    return createEmbed({
        description:
            `**${game.userMention} started a mines game.**\n\n` +
            `**Bet:** \`₱${game.bet.toLocaleString()}\`   **Mines:** \`${game.mineCount}\`\n` +
            `**Cash Out:** \`₱${game.currentPayout.toLocaleString()}\` (\`${cashoutMultiplier.toFixed(2)}x\`)\n` +
            `**Next:** \`₱${nextPayout.toLocaleString()}\` (\`${getMultiplier(safePicks + 1, game.mineCount).toFixed(2)}x\`)` +
            `\n\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            (extra ? `**${status}**\n${extra}` : `**${status}**`),
        color: status === 'BOOM! You hit a mine.' ? 'error' : 'info',
    });
}

export default {
    data: new SlashCommandBuilder()
        .setName('mines')
        .setDescription('Play Mines using your Barracks cash wallet')
        .addIntegerOption(option =>
            option
                .setName('bet')
                .setDescription('How much cash to wager')
                .setMinValue(1)
                .setMaxValue(1000000000)
                .setRequired(true)
        )
        ,

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Mines requires a server', ErrorTypes.VALIDATION, 'Play Mines inside a server.');
        }

        const bet = interaction.options.getInteger('bet', true);
        const mineCount = FIXED_MINE_COUNT;
        const userData = await getEconomyData(client, interaction.guildId, interaction.user.id);

        if (bet > (userData.wallet || 0)) {
            throw createError(
                'Insufficient cash',
                ErrorTypes.VALIDATION,
                `You only have **₱${(userData.wallet || 0).toLocaleString()}** in your cash wallet.`
            );
        }

        await removeMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');

        const minePositions = new Set();
        while (minePositions.size < mineCount) {
            minePositions.add(Math.floor(Math.random() * BOARD_SIZE));
        }

        const game = {
            id: interaction.id,
            userMention: interaction.user.toString(),
            bet,
            mineCount,
            mines: minePositions,
            revealed: new Set(),
            currentPayout: 0,
            finished: false,
        };

        const message = await interaction.reply({
            embeds: [gameEmbed(game, 'Choose a tile.')],
            components: buildBoard(game),
            fetchReply: true,
        });

        const collector = message.createMessageComponentCollector({
            time: COLLECTOR_TIME,
            filter: button => button.customId.startsWith(`mines:${game.id}:`),
        });

        collector.on('collect', async button => {
            if (button.user.id !== interaction.user.id) {
                return button.reply({ content: 'This is not your Mines round. Start your own with /mines.', ephemeral: true });
            }

            if (game.finished) {
                return button.reply({ content: 'This round has already ended.', ephemeral: true });
            }

            if (button.customId.endsWith(':cashout')) {
                if (game.revealed.size === 0) {
                    return button.reply({ content: 'Reveal at least one safe tile before cashing out.', ephemeral: true });
                }

                game.finished = true;
                const payout = game.currentPayout;
                await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
                collector.stop('cashed_out');

                return button.update({
                    embeds: [gameEmbed(game, 'Cashed out!', `You received **₱${payout.toLocaleString()}**. Net: **₱${(payout - bet).toLocaleString()}**.`)],
                    components: buildBoard(game, true),
                });
            }

            const index = Number(button.customId.split(':').at(-1));
            if (!Number.isInteger(index) || index < 0 || index >= BOARD_SIZE || game.revealed.has(index)) {
                return button.reply({ content: 'That tile is not available.', ephemeral: true });
            }

            if (game.mines.has(index)) {
                game.finished = true;
                collector.stop('mine_hit');
                return button.update({
                    embeds: [gameEmbed(game, 'BOOM! You hit a mine.', `You lost your **₱${bet.toLocaleString()}** bet. Better luck next patrol.`)],
                    components: buildBoard(game, true, index),
                });
            }

            game.revealed.add(index);
            game.currentPayout = Math.floor(bet * getMultiplier(game.revealed.size, mineCount));

            if (game.revealed.size === BOARD_SIZE - mineCount) {
                game.finished = true;
                const payout = game.currentPayout;
                await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
                collector.stop('board_cleared');
                return button.update({
                    embeds: [gameEmbed(game, 'Board cleared!', `All safe tiles found! You received **₱${payout.toLocaleString()}**.`)],
                    components: buildBoard(game, true),
                });
            }

            return button.update({
                embeds: [gameEmbed(game, 'Safe tile! Keep going or cash out.')],
                components: buildBoard(game),
            });
        });

        collector.on('end', async (_collected, reason) => {
            if (game.finished || reason === 'cashed_out' || reason === 'mine_hit' || reason === 'board_cleared') return;

            game.finished = true;
            try {
                if (game.revealed.size > 0 && game.currentPayout > 0) {
                    await addMoney(client, interaction.guildId, interaction.user.id, game.currentPayout, 'wallet');
                }
                await message.edit({
                    embeds: [gameEmbed(game, 'Round expired.', game.revealed.size > 0
                        ? `Your current cash-out of **₱${game.currentPayout.toLocaleString()}** was returned to your wallet.`
                        : 'Your bet was returned because no tile was selected.')],
                    components: buildBoard(game, true),
                });
                if (game.revealed.size === 0) {
                    await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');
                }
            } catch (error) {
                console.error('[MINES] Failed to settle expired game:', error);
            }
        });
    }, { command: 'mines' }),
};
