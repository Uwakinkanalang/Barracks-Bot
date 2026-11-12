import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SlashCommandBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { removeMoney, addMoney } from '../../utils/economy.js';
import { createError, ErrorTypes, withErrorHandling } from '../../utils/errorHandler.js';

const GAME_TIMEOUT = 2 * 60 * 1000;
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) deck.push({ rank, suit });
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function handValue(cards) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
        if (card.rank === 'A') {
            total += 11;
            aces++;
        } else {
            total += ['K', 'Q', 'J'].includes(card.rank) ? 10 : Number(card.rank);
        }
    }
    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }
    return total;
}

function formatHand(cards) {
    return cards.map(card => `${card.rank}${card.suit}`).join('　');
}

function isBlackjack(cards) {
    return cards.length === 2 && handValue(cards) === 21;
}

function buildGame(game, status = 'Choose Hit or Stand.', revealDealer = false, ended = false) {
    const dealerCards = revealDealer
        ? formatHand(game.dealer)
        : `${game.dealer[0].rank}${game.dealer[0].suit}　🂠`;
    const dealerValue = revealDealer ? handValue(game.dealer) : '?';
    const container = new ContainerBuilder().setAccentColor(0x3498DB);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `**🃏 ${game.userMention} started a Blackjack game!**\n\n` +
            `**Bet:** \`₱${game.bet.toLocaleString()}\`\n\n` +
            `**Dealer**　(${dealerValue})\n${dealerCards}\n\n` +
            `**Your hand**　(${handValue(game.player)})\n${formatHand(game.player)}\n\n` +
            `**${status}**`
        )
    );

    if (!ended) {
        container.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`blackjack:${game.id}:hit`)
                    .setLabel('🃏 Hit')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`blackjack:${game.id}:stand`)
                    .setLabel('🛑 Stand')
                    .setStyle(ButtonStyle.Success)
            )
        );
    }

    return container;
}

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('bblackjack')
        .setDescription('Play Blackjack using your Barracks cash wallet')
        .addIntegerOption(option =>
            option.setName('bet')
                .setDescription('How much cash to wager')
                .setMinValue(1)
                .setMaxValue(1000000000)
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Blackjack requires a server', ErrorTypes.VALIDATION, 'Play Blackjack inside a server.');
        }

        const bet = interaction.options.getInteger('bet', true);
        const userData = await (await import('../../utils/economy.js')).getEconomyData(client, interaction.guildId, interaction.user.id);
        if (bet > (userData.wallet || 0)) {
            throw createError(
                'Insufficient cash',
                ErrorTypes.VALIDATION,
                `You only have **₱${(userData.wallet || 0).toLocaleString()}** in your cash wallet.`
            );
        }

        await removeMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');

        const deck = createDeck();
        const game = {
            id: interaction.id,
            userId: interaction.user.id,
            userMention: interaction.user.toString(),
            bet,
            deck,
            player: [deck.pop(), deck.pop()],
            dealer: [deck.pop(), deck.pop()],
            finished: false,
        };

        const settle = async (result, payout = 0) => {
            if (game.finished) return;
            game.finished = true;
            if (payout > 0) await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
            return result;
        };

        const initialPlayerBlackjack = isBlackjack(game.player);
        const initialDealerBlackjack = isBlackjack(game.dealer);

        let initialStatus = 'Choose Hit or Stand.';
        let initialReveal = false;
        let initialEnded = false;
        if (initialPlayerBlackjack || initialDealerBlackjack) {
            initialReveal = true;
            initialEnded = true;
            if (initialPlayerBlackjack && initialDealerBlackjack) {
                initialStatus = `🤝 Push! Both have Blackjack. Your **₱${bet.toLocaleString()}** bet was returned.`;
                await settle('push', bet);
            } else if (initialPlayerBlackjack) {
                const payout = bet + Math.floor(bet * 1.5);
                initialStatus = `🎉 Blackjack! You won **₱${payout.toLocaleString()}** (3:2 payout).`;
                await settle('blackjack', payout);
            } else {
                initialStatus = '💥 Dealer has Blackjack. Better luck next Soldier.';
                await settle('dealer_blackjack', 0);
            }
        }

        let message;
        try {
            message = await interaction.reply({
                flags: MessageFlags.IsComponentsV2,
                components: [buildGame(game, initialStatus, initialReveal, initialEnded)],
                fetchReply: true,
            });
        } catch (error) {
            if (!game.finished) await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');
            throw error;
        }

        if (initialEnded) return;

        const finishRound = async (button, status) => {
            while (handValue(game.dealer) < 17) game.dealer.push(game.deck.pop());
            const playerTotal = handValue(game.player);
            const dealerTotal = handValue(game.dealer);
            let payout = 0;
            let resultText;

            if (playerTotal > 21) {
                resultText = `💥 Bust! You lost **₱${bet.toLocaleString()}**. Better luck next Soldier.`;
            } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
                payout = bet * 2;
                resultText = `🎉 You won **₱${payout.toLocaleString()}**!`;
            } else if (playerTotal === dealerTotal) {
                payout = bet;
                resultText = `🤝 Push! Your **₱${bet.toLocaleString()}** bet was returned.`;
            } else {
                resultText = `💥 Dealer wins. You lost **₱${bet.toLocaleString()}**. Better luck next Soldier.`;
            }

            await settle('finished', payout);
            return button.update({
                components: [buildGame(game, resultText, true, true)],
            });
        };

        const collector = message.createMessageComponentCollector({
            time: GAME_TIMEOUT,
            filter: button => button.customId.startsWith(`blackjack:${game.id}:`),
        });

        collector.on('collect', async button => {
            if (button.user.id !== game.userId) {
                return button.reply({ content: 'This is not your Blackjack game, Soldier.', ephemeral: true });
            }
            if (game.finished) {
                return button.reply({ content: 'This round has already ended.', ephemeral: true });
            }

            const action = button.customId.split(':').at(-1);
            if (action === 'hit') {
                game.player.push(game.deck.pop());
                const total = handValue(game.player);
                if (total >= 21) {
                    if (total === 21) return finishRound(button, 'You reached 21!');
                    while (handValue(game.dealer) < 17) game.dealer.push(game.deck.pop());
                    await settle('bust', 0);
                    collector.stop('bust');
                    return button.update({
                        components: [buildGame(game, `💥 Bust! You lost **₱${bet.toLocaleString()}**. Better luck next Soldier.`, true, true)],
                    });
                }
                return button.update({
                    components: [buildGame(game, 'You drew a card. Hit or Stand?')],
                });
            }

            if (action === 'stand') {
                collector.stop('stood');
                return finishRound(button, 'You stood.');
            }
        });

        collector.on('end', async (_collected, reason) => {
            if (game.finished || reason === 'stood' || reason === 'bust') return;
            try {
                // Timeout acts as Stand so the wager is always settled fairly.
                while (handValue(game.dealer) < 17) game.dealer.push(game.deck.pop());
                const playerTotal = handValue(game.player);
                const dealerTotal = handValue(game.dealer);
                let payout = 0;
                let status;
                if (playerTotal > 21 || (dealerTotal <= 21 && dealerTotal > playerTotal)) {
                    status = `⏰ Time's up. Dealer wins; you lost **₱${bet.toLocaleString()}**. Better luck next Soldier.`;
                } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
                    payout = bet * 2;
                    status = `⏰ Time's up. You won **₱${payout.toLocaleString()}**!`;
                } else {
                    payout = bet;
                    status = `⏰ Time's up. Push! Your **₱${bet.toLocaleString()}** bet was returned.`;
                }
                await settle('timeout', payout);
                await message.edit({
                    components: [buildGame(game, status, true, true)],
                });
            } catch (error) {
                console.error('[BLACKJACK] Failed to settle timed-out game:', error);
            }
        });
    }, { command: 'blackjack' }),
};
