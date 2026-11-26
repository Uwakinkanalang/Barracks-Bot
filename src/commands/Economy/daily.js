import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { getUserLevelData } from '../../services/leveling/leveling.js';
import { formatDuration } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botConfig } from '../../config/bot.js';

const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const STREAK_GRACE_PERIOD = DAILY_COOLDOWN * 2;
const DAILY_AMOUNT = botConfig.economy?.dailyAmount ?? 5000;
const DAILY_LEVEL_BONUS = botConfig.economy?.dailyLevelBonus ?? 100;
const MAX_DAILY_LEVEL = 100;
const CLAN_BONUS_AMOUNT = 2000;
const BOOSTER_VIP_BONUS_AMOUNT = 5000;

const STREAK_REWARDS = [
    { day: 1, reward: 100 },
    { day: 2, reward: 200 },
    { day: 3, reward: 500 },
    { day: 4, reward: 700 },
    { day: 5, reward: 1000 },
    { day: 6, reward: 1500 },
    { day: 7, reward: 2000 },
    { day: 14, reward: 3000 },
    { day: 30, reward: 5000 },
    { day: 60, reward: 7500 },
    { day: 100, reward: 10000 },
];

function getStreakReward(streak) {
    return STREAK_REWARDS.reduce(
        (reward, milestone) => streak >= milestone.day ? milestone.reward : reward,
        0,
    );
}


export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('Claim your daily bCash reward'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const now = Date.now();

        logger.debug(`[ECONOMY] Daily claim started for ${userId}`, { userId, guildId });

        const userData = await getEconomyData(client, guildId, userId);
        if (!userData) {
            throw createError(
                'Failed to load economy data for daily',
                ErrorTypes.DATABASE,
                'Failed to load your economy data. Please try again later.',
                { userId, guildId },
            );
        }

        const lastDaily = Number(userData.lastDaily) || 0;
        if (now < lastDaily + DAILY_COOLDOWN) {
            const timeRemaining = lastDaily + DAILY_COOLDOWN - now;
            throw createError(
                'Daily cooldown active',
                ErrorTypes.RATE_LIMIT,
                `You need to wait before claiming daily again. Try again in **${formatDuration(timeRemaining)}**.`,
                { timeRemaining, cooldownType: 'daily' },
            );
        }

        const previousStreak = Math.max(0, Number(userData.dailyStreak) || 0);
        const elapsedSinceLastClaim = lastDaily > 0 ? now - lastDaily : 0;
        const dailyStreak = lastDaily === 0 || elapsedSinceLastClaim > STREAK_GRACE_PERIOD
            ? 1
            : previousStreak + 1;
        const streakBonus = getStreakReward(dailyStreak);

        const levelData = await getUserLevelData(client, guildId, userId);
        const memberLevel = Math.min(MAX_DAILY_LEVEL, Math.max(0, Number(levelData?.level) || 0));
        const baseSalary = DAILY_AMOUNT + (memberLevel * DAILY_LEVEL_BONUS);

        const boosterRoleId = botConfig.economy?.boosterRoleId;
        const vipRoleId = botConfig.economy?.vipRoleId;
        const memberRoles = interaction.member?.roles?.cache;
        const hasVipRole = Boolean(vipRoleId && memberRoles?.has(vipRoleId));
        const hasBoosterRole = Boolean(boosterRoleId && memberRoles?.has(boosterRoleId));

        const clanList = await client.db.get(`guild:${guildId}:clans`, []);
        const clans = Array.isArray(clanList) ? clanList : [];
        const hasApprovedClan = clans.some(clan => clan.status === 'approved' && (
            String(clan.leaderId || '') === userId ||
            String(clan.viceLeaderId || '') === userId ||
            (Array.isArray(clan.memberIds) && clan.memberIds.map(String).includes(userId))
        ));

        // Flat bonuses: Clan +2,000; Booster or VIP +5,000 (VIP takes priority).
        const boosterBonus = hasBoosterRole && !hasVipRole ? BOOSTER_VIP_BONUS_AMOUNT : 0;
        const vipBonus = hasVipRole ? BOOSTER_VIP_BONUS_AMOUNT : 0;
        const clanBonus = hasApprovedClan ? CLAN_BONUS_AMOUNT : 0;
        const totalPercentageBonus = boosterBonus + vipBonus + clanBonus;
        const earned = baseSalary + totalPercentageBonus + streakBonus;

        userData.wallet = (userData.wallet || 0) + earned;
        userData.lastDaily = now;
        userData.dailyStreak = dailyStreak;

        const saved = await setEconomyData(client, guildId, userId, userData);
        if (!saved) {
            throw createError(
                'Failed to save daily reward',
                ErrorTypes.DATABASE,
                'Your daily reward could not be saved. Please try again later.',
                { userId, guildId },
            );
        }

        const bonusLines = [
            `💰 **Base Salary:**`,
            `🎖️ **Level Bonus (Level ${memberLevel}):**`,
            `🛡️ **Clan Bonus:**`,
            `🚀 **Booster/VIP Bonus:**`,
            `🔥 **Daily Streak (Day ${dailyStreak}):**`,
        ];
        const bonusAmounts = [
            DAILY_AMOUNT,
            memberLevel * DAILY_LEVEL_BONUS,
            clanBonus,
            boosterBonus + vipBonus,
            streakBonus,
        ];
        const bonusDisplay = bonusLines.map((label, index) =>
            `${label.padEnd(35)} +${bonusAmounts[index].toLocaleString().padStart(8)} bCash`
        ).join('\n');
        const totalDisplay = `**Total: ${earned.toLocaleString()} bCash!**`;

        logger.info('[ECONOMY_TRANSACTION] Daily claimed', {
            userId,
            guildId,
            amount: earned,
            baseSalary,
            boosterBonus,
            vipBonus,
            clanBonus,
            streakBonus,
            dailyStreak,
            newWallet: userData.wallet,
            timestamp: new Date().toISOString(),
        });

        const embed = successEmbed(
            '✅ Daily Claimed!',
            `You received **${earned.toLocaleString()} bCash**!\n\n${bonusDisplay}\n\n${totalDisplay}`,
        )
            .addFields({
                name: 'New bCash Balance',
                value: `${userData.wallet.toLocaleString()} bCash`,
                inline: true,
            })
            .setFooter({
                text: 'Next claim in 24 hours. Keep your streak alive!',
            });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'daily' }),
};
