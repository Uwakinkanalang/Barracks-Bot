import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SlashCommandBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { removeMoney, addMoney, getEconomyData } from '../../utils/economy.js';
import { createError, ErrorTypes, withErrorHandling } from '../../utils/errorHandler.js';

const GAME_TIMEOUT = 2 * 60 * 1000;
const FLIP_DELAY = 450;
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

function isBlackjack(cards) {
    return cards.length === 2 && handValue(cards) === 21;
}

function cardFace(card) {
    // Unicode playing-card symbols render as compact card-style glyphs in Discord.
    const suitBase = {
        '♠': 0x1F0A1,
        '♥': 0x1F0B1,
        '♦': 0x1F0C1,
        '♣': 0x1F0D1,
    }[card.suit];

    const rankOffset = {
        A: 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6,
        '8': 7, '9': 8, '10': 9, J: 10, Q: 12, K: 13,
    }[card.rank];

    return String.fromCodePoint(suitBase + rankOffset);
}

function renderCards(cards, hiddenIndices = []) {
    return cards.map((card, index) => hiddenIndices.includes(index) ? '🂠' : cardFace(card)).join('　');
}

function buildGame(game, status = '🎲 ~ Game in progress', options = {}) {
    const { revealDealer = false, ended = false, hiddenPlayerIndices = [], hideDealerHole = false } = options;
    const dealerHidden = hideDealerHole || (!revealDealer && !ended);
    const dealerCards = renderCards(game.dealer, dealerHidden ? [1] : []);
    const playerCards = renderCards(game.player, hiddenPlayerIndices);
    const dealerValue = revealDealer ? handValue(game.dealer) : `${game.dealer[0].rank}+?`;
    const playerValue = handValue(game.player);
    const container = new ContainerBuilder().setAccentColor(0x3498DB);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `**${game.userMention}, you bet ₱${game.bet.toLocaleString()} to play Blackjack**\n\n` +
            `**Dealer**　[${dealerValue}]　　　　 **${game.displayName}**　[${playerValue}]\n` +
            `${dealerCards}　　　　 ${playerCards}\n\n` +
            `${status}`
        )
    );

    if (!ended) {
        container.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`blackjack:${game.id}:hit`)
                    .setLabel('👊 Hit')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(Boolean(game.busy)),
                new ButtonBuilder()
                    .setCustomId(`blackjack:${game.id}:stand`)
                    .setLabel('🛑 Stand')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(Boolean(game.busy))
            )
        );
    }

    return container;
}

function waitForFlip() {
    return new Promise(resolve => setTimeout(resolve, FLIP_DELAY));
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
        const userData = await getEconomyData(client, interaction.guildId, interaction.user.id);
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
            displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
            bet,
            deck,
            player: [deck.pop(), deck.pop()],
            dealer: [deck.pop(), deck.pop()],
            finished: false,
            busy: false,
        };

        const settle = async payout => {
            if (game.finished) return;
            game.finished = true;
            if (payout > 0) await addMoney(client, interaction.guildId, interaction.user.id, payout, 'wallet');
        };

        const initialPlayerBlackjack = isBlackjack(game.player);
        const initialDealerBlackjack = isBlackjack(game.dealer);
        let initialStatus = '🎲 ~ Game in progress';
        let initialEnded = false;
        let initialReveal = false;

        if (initialPlayerBlackjack || initialDealerBlackjack) {
            initialReveal = true;
            initialEnded = true;
            if (initialPlayerBlackjack && initialDealerBlackjack) {
                initialStatus = `🤝 Push! Your ₱${bet.toLocaleString()} bet was returned.`;
                await settle(bet);
            } else if (initialPlayerBlackjack) {
                const payout = bet + Math.floor(bet * 1.5);
                initialStatus = `🎉 Blackjack! You won ₱${payout.toLocaleString()} (3:2 payout).`;
                await settle(payout);
            } else {
                initialStatus = '💥 Dealer has Blackjack. Better luck next Soldier.';
                await settle(0);
            }
        }

        let message;
        try {
            message = await interaction.reply({
                flags: MessageFlags.IsComponentsV2,
                components: [buildGame(game, initialStatus, { revealDealer: initialReveal, ended: initialEnded })],
                fetchReply: true,
            });
        } catch (error) {
            if (!game.finished) await addMoney(client, interaction.guildId, interaction.user.id, bet, 'wallet');
            throw error;
        }

        if (initialEnded) return;

        const finishRound = async (button, status, alreadyAcknowledged = false) => {
            while (handValue(game.dealer) < 17) game.dealer.push(game.deck.pop());
            const playerTotal = handValue(game.player);
            const dealerTotal = handValue(game.dealer);
            let payout = 0;
            let resultText;

            if (playerTotal > 21) {
                resultText = `💥 Bust! You lost ₱${bet.toLocaleString()}. Better luck next Soldier.`;
            } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
                payout = bet * 2;
                resultText = `🎉 You won ₱${payout.toLocaleString()}!`;
            } else if (playerTotal === dealerTotal) {
                payout = bet;
                resultText = `🤝 Push! Your ₱${bet.toLocaleString()} bet was returned.`;
            } else {
                resultText = `💥 Dealer wins. You lost ₱${bet.toLocaleString()}. Better luck next Soldier.`;
            }

            await settle(payout);
            if (!alreadyAcknowledged) {
                await button.update({
                    components: [buildGame(game, '🂠 Dealer is revealing the hidden card...', { ended: true, hideDealerHole: true })],
                });
            }
            await waitForFlip();
            return message.edit({
                components: [buildGame(game, resultText, { revealDealer: true, ended: true })],
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
            if (game.busy) {
                return button.reply({ content: 'Wait for the card to flip, Soldier.', ephemeral: true });
            }

            const action = button.customId.split(':').at(-1);
            if (action === 'hit') {
                game.player.push(game.deck.pop());
                const newCardIndex = game.player.length - 1;
                const total = handValue(game.player);
                game.busy = true;

                await button.update({
                    components: [buildGame(game, '🂠 Your new card is flipping...', { hiddenPlayerIndices: [newCardIndex] })],
                });
                await waitForFlip();
                game.busy = false;

                if (total >= 21) {
                    if (total === 21) {
                        return finishRound(null, 'You reached 21!', true);
                    }
                    await settle(0);
                    collector.stop('bust');
                    return message.edit({
                        components: [buildGame(game, `💥 Bust! You lost ₱${bet.toLocaleString()}. Better luck next Soldier.`, { revealDealer: true, ended: true })],
                    });
                }

                return message.edit({
                    components: [buildGame(game, '🎲 ~ Game in progress')],
                });
            }

            if (action === 'stand') {
                game.busy = true;
                collector.stop('stood');
                return finishRound(button, 'You stood.');
            }
        });

        collector.on('end', async (_collected, reason) => {
            if (game.finished || reason === 'stood' || reason === 'bust') return;
            try {
                while (handValue(game.dealer) < 17) game.dealer.push(game.deck.pop());
                const playerTotal = handValue(game.player);
                const dealerTotal = handValue(game.dealer);
                let payout = 0;
                let status;
                if (playerTotal > 21 || (dealerTotal <= 21 && dealerTotal > playerTotal)) {
                    status = `⏰ Time's up. Dealer wins; you lost ₱${bet.toLocaleString()}. Better luck next Soldier.`;
                } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
                    payout = bet * 2;
                    status = `⏰ Time's up. You won ₱${payout.toLocaleString()}!`;
                } else {
                    payout = bet;
                    status = `⏰ Time's up. Push! Your ₱${bet.toLocaleString()} bet was returned.`;
                }
                await settle(payout);
                await message.edit({
                    components: [buildGame(game, '🂠 Dealer is revealing the hidden card...', { ended: true, hideDealerHole: true })],
                });
                await waitForFlip();
                await message.edit({
                    components: [buildGame(game, status, { revealDealer: true, ended: true })],
                });
            } catch (error) {
                console.error('[BLACKJACK] Failed to settle timed-out game:', error);
            }
        });
    }, { command: 'blackjack' }),
};
