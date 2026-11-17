import { SlashCommandBuilder } from 'discord.js';
import { randomInt } from 'node:crypto';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createError, ErrorTypes, withErrorHandling } from '../../utils/errorHandler.js';

const activeSpins = new Set();
const DEFAULT_EMOJIS = ['🍒', '🍋', '🍉', '⭐', '💎'];
const SPIN_DELAY = 650;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shuffle = items => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
};

function createSpin(emojis, houseEdge) {
    // RTP is exactly 100% minus the configured house edge.
    const rtp = 1 - houseEdge / 100;
    const roll = randomInt(1_000_000);
    const tripleCutoff = Math.floor((rtp / 20) * 1_000_000);
    const pairCutoff = tripleCutoff + Math.floor((rtp / 6) * 1_000_000);

    if (roll < tripleCutoff) {
        const symbol = emojis[randomInt(emojis.length)];
        return { reels: [symbol, symbol, symbol], multiplier: 10 };
    }
    if (roll < pairCutoff) {
        const pair = emojis[randomInt(emojis.length)];
        const alternatives = emojis.filter(emoji => emoji !== pair);
        return { reels: shuffle([pair, pair, alternatives[randomInt(alternatives.length)]]), multiplier: 3 };
    }

    const reels = [];
    while (reels.length < 3) {
        const symbol = emojis[randomInt(emojis.length)];
        if (!reels.includes(symbol)) reels.push(symbol);
    }
    return { reels: shuffle(reels), multiplier: 0 };
}

function renderSpin(reels, stoppedCount, bet, status) {
    const visible = reels.map((symbol, index) => index < stoppedCount ? symbol : '🎰');
    return [
        '**🎰 BARRACKS SLOTS**',
        `Bet: **₱${bet.toLocaleString()} bCash**`,
        '',
        '╭───────────────╮',
        `│   ${visible.join('  │  ')}   │`,
        '╰───────────────╯',
        '',
        status,
    ].join('\n');
}

export default {
    category: 'Economy',
    data: new SlashCommandBuilder()
        .setName('slots')
        .setDescription('Spin the Barracks slot machine using bCash')
        .addIntegerOption(option =>
            option.setName('bet')
                .setDescription('Amount of bCash to wager')
                .setMinValue(1)
                .setMaxValue(1_000_000_000)
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        if (!interaction.inGuild()) {
            throw createError('Slots requires a server', ErrorTypes.VALIDATION, 'Use the slot machine inside a server.');
        }

        const bet = interaction.options.getInteger('bet', true);
        const lockKey = `${interaction.guildId}:${interaction.user.id}`;
        if (activeSpins.has(lockKey)) {
            throw createError('Spin already running', ErrorTypes.RATE_LIMIT, 'Your slot machine is still spinning. Please wait for it to finish.');
        }

        activeSpins.add(lockKey);
        try {
            const [guildConfig, account] = await Promise.all([
                getGuildConfig(client, interaction.guildId),
                getEconomyData(client, interaction.guildId, interaction.user.id),
            ]);
            const wallet = Math.max(0, Number(account?.wallet) || 0);
            if (bet > wallet) {
                throw createError('Insufficient bCash', ErrorTypes.VALIDATION, `You only have **₱${wallet.toLocaleString()} bCash** in your wallet.`);
            }

            const emojis = Array.isArray(guildConfig.slotsEmojis) ? guildConfig.slotsEmojis : DEFAULT_EMOJIS;
            if (emojis.length < 3 || emojis.length > 15) {
                throw createError('Slots are not configured', ErrorTypes.CONFIGURATION, 'An admin must configure between 3 and 15 slot emojis in /configwizard.');
            }
            const houseEdge = Number(guildConfig.slotsHouseEdge ?? 10);
            const spin = createSpin(emojis, houseEdge);
            const payout = bet * spin.multiplier;
            if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(wallet - bet + payout)) {
                throw createError('Bet is too large', ErrorTypes.VALIDATION, 'That bet is too large to calculate safely.');
            }

            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) return;

            await InteractionHelper.safeEditReply(interaction, { content: renderSpin(spin.reels, 0, bet, '⏳ Spinning...') });
            for (let stopped = 1; stopped <= 3; stopped++) {
                await wait(SPIN_DELAY);
                await InteractionHelper.safeEditReply(interaction, {
                    content: renderSpin(spin.reels, stopped, bet, stopped === 3 ? '🎯 Reels stopped!' : '⏳ Spinning...'),
                });
            }

            const latestAccount = await getEconomyData(client, interaction.guildId, interaction.user.id);
            const latestWallet = Math.max(0, Number(latestAccount?.wallet) || 0);
            if (latestWallet < bet) {
                await InteractionHelper.safeEditReply(interaction, {
                    content: renderSpin(spin.reels, 3, bet, '⚠️ Your wallet changed while the reels were spinning. No bet was charged.'),
                });
                return;
            }

            latestAccount.wallet = latestWallet - bet + payout;
            await setEconomyData(client, interaction.guildId, interaction.user.id, latestAccount);

            const outcome = spin.multiplier === 10
                ? `🎉 **JACKPOT! Three of a kind!** You received **₱${payout.toLocaleString()} bCash** (10×).`
                : spin.multiplier === 3
                    ? `✨ **A pair!** You received **₱${payout.toLocaleString()} bCash** (3×).`
                    : `💥 **No match.** You lost **₱${bet.toLocaleString()} bCash**.`;
            await InteractionHelper.safeEditReply(interaction, {
                content: [renderSpin(spin.reels, 3, bet, outcome), '', `Wallet: **₱${latestAccount.wallet.toLocaleString()} bCash**`, `House edge: **${houseEdge}%**`].join('\n'),
            });
        } finally {
            activeSpins.delete(lockKey);
        }
    }, { command: 'slots' }),
};
