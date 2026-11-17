import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
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

const WIN_SYMBOLS = {
    eggplant: { reels: ['🍆', '🍆', '🍆'], multiplier: 1, chance: 20, image: 'https://static.wikia.nocookie.net/owobot/images/5/56/SlotsEggplant.png/revision/latest?cb=20201231080844', label: 'Eggplant' },
    heart: { reels: ['❤️', '❤️', '❤️'], multiplier: 2, chance: 20, image: 'https://static.wikia.nocookie.net/owobot/images/b/bb/SlotsHeart.png/revision/latest?cb=20201231081114', label: 'Heart' },
    cherry: { reels: ['🍒', '🍒', '🍒'], multiplier: 3, chance: 5, image: 'https://static.wikia.nocookie.net/owobot/images/8/80/SlotsCherry.png/revision/latest?cb=20201231081252', label: 'Cherry' },
    note: { reels: ['💵', '💵', '💵'], multiplier: 4, chance: 2.5, image: 'https://static.wikia.nocookie.net/owobot/images/0/06/Cowoncy_Note.png/revision/latest/scale-to-width-down/24?cb=20191203153323', label: 'Barracks Cash' },
    owo: { reels: [':Soldier:', ':Soldier:', ':Soldier:'], multiplier: 10, chance: 50, label: 'Soldier Jackpot', customEmojiName: 'Soldier' },
};

function createSpin(emojis) {
    // Temporary odds: 20%, 20%, 5%, 2.5%, and 50% (97.5% total wins).
    const roll = randomInt(10_000);
    const outcomes = [
        { cutoff: 2000, key: 'eggplant' },
        { cutoff: 4000, key: 'heart' },
        { cutoff: 4500, key: 'cherry' },
        { cutoff: 4750, key: 'note' },
        { cutoff: 9750, key: 'owo' },
    ];
    const winner = outcomes.find(item => roll < item.cutoff);
    if (winner) return { ...WIN_SYMBOLS[winner.key], win: true };

    return {
        reels: Array.from({ length: 3 }, () => emojis[randomInt(emojis.length)]),
        multiplier: 0,
        win: false,
        label: 'No match',
    };
}

function buildReelEmbeds(spin, stoppedCount) {
    const urls = spin.images || (spin.image ? [spin.image, spin.image, spin.image] : []);
    return urls.slice(0, stoppedCount).map((url, index) =>
        new EmbedBuilder().setColor(0x5865F2).setTitle(`Reel ${index + 1}`).setThumbnail(url)
    );
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
    prefixOnly: true,
    category: 'Economy',
    data: new SlashCommandBuilder()
        .setName('bslot')
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
            throw createError('Slots requires a server', ErrorTypes.VALIDATION, 'Use bslot inside a server.');
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
                throw createError('Slots are not configured', ErrorTypes.CONFIGURATION, 'An admin must configure between 3 and 15 slot emojis in the config wizard.');
            }
            const resolveDiscordEmoji = value => {
                const mention = value.match(/^<a?:[A-Za-z0-9_]{2,32}:(\\d{17,20})>$/);
                if (mention) return value;
                const named = value.match(/^:([A-Za-z0-9_]{2,32}):$/);
                if (named) {
                    const found = interaction.guild.emojis.cache.find(
                        emoji => emoji.name?.toLowerCase() === named[1].toLowerCase()
                    );
                    return found ? found.toString() : value;
                }
                return value;
            };
            const spin = createSpin(emojis);
            spin.reels = spin.reels.map(resolveDiscordEmoji);
            if (spin.customEmojiName) {
                const soldierEmoji = interaction.guild.emojis.cache.find(
                    emoji => emoji.name?.toLowerCase() === spin.customEmojiName.toLowerCase()
                );
                if (soldierEmoji) {
                    spin.reels = [soldierEmoji.toString(), soldierEmoji.toString(), soldierEmoji.toString()];
                } else {
                    spin.reels = [':Soldier:', ':Soldier:', ':Soldier:'];
                }
            }
            const payout = bet * spin.multiplier;
            if (!Number.isSafeInteger(payout) || !Number.isSafeInteger(wallet - bet + payout)) {
                throw createError('Bet is too large', ErrorTypes.VALIDATION, 'That bet is too large to calculate safely.');
            }

            const deferred = await InteractionHelper.safeDefer(interaction);
            if (!deferred) return;

            await InteractionHelper.safeEditReply(interaction, { content: renderSpin(spin.reels, 0, bet, '⏳ Spinning...'), embeds: buildReelEmbeds(spin, 0) });
            for (let stopped = 1; stopped <= 3; stopped++) {
                await wait(SPIN_DELAY);
                await InteractionHelper.safeEditReply(interaction, {
                    content: renderSpin(spin.reels, stopped, bet, stopped === 3 ? '🎯 Reels stopped!' : '⏳ Spinning...'),
                    embeds: buildReelEmbeds(spin, stopped),
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

            const outcome = spin.win
                ? `🎉 **${spin.label}!** You won **₱${payout.toLocaleString()} bCash** (${spin.multiplier}× your bet, ${spin.chance}% chance).`
                : `💥 **No match.** You lost **₱${bet.toLocaleString()} bCash**.`;
            await InteractionHelper.safeEditReply(interaction, {
                content: renderSpin(spin.reels, 3, bet, outcome),
                embeds: buildReelEmbeds(spin, 3),
            });
        } finally {
            activeSpins.delete(lockKey);
        }
    }, { command: 'bslot' }),
};
