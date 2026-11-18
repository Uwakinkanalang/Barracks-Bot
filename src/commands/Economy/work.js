import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botConfig, isBotOwner } from '../../config/bot.js';
import { getUserLevelData } from '../../services/leveling/leveling.js';

const WORK_COOLDOWN = botConfig.economy?.cooldowns?.work ?? 30 * 60 * 1000;
const BASE_WORK_AMOUNT = 700;
const WORK_LEVEL_BONUS = 100;
const LAPTOP_MULTIPLIER = 1.5;
const WORK_JOB_WEIGHTS = [
    { name: "Software Developer", chance: 100 / 18 },
    { name: "Barista", chance: 100 / 18 },
    { name: "Janitor", chance: 100 / 18 },
    { name: "YouTuber", chance: 100 / 18 },
    { name: "Cashier", chance: 100 / 18 },
    { name: "Grab Driver", chance: 100 / 18 },
    { name: "Private Investigator", chance: 100 / 18 },
    { name: "MMDA Traffic Enforcer", chance: 100 / 18 },
    { name: "Professional Cuddler", chance: 100 / 18 },
    { name: "Artista sa GMA", chance: 100 / 18 },
    { name: "Professional Chismosa", chance: 100 / 18 },
    { name: "Taga-bukas ng pinto sa 7-Eleven", chance: 100 / 18 },
    { name: "Snatcher sa Quiapo", chance: 100 / 18 },
    { name: "Albularyo", chance: 100 / 18 },
    { name: "Sinabihan ng Pogi si <@1316339704454447154>", chance: 100 / 18 },
    { name: "Video editor ni <@748548558868709507>", chance: 100 / 18 },
    { name: "Vivamax Artist", chance: 100 / 18 },
    { name: "[PAPS WORKS](https://www.facebook.com/profile.php?id=61573478493835) Motorshop - <@750989582887157781>", chance: 100 / 18 },
];

const WORK_JOB_SALARIES = {
    "Software Developer": 3000,
    "Barista": 1000,
    "Janitor": 800,
    "YouTuber": 2500,
    "Cashier": 1000,
    "Grab Driver": 1500,
    "Private Investigator": 3500,
    "MMDA Traffic Enforcer": 1800,
    "Professional Cuddler": 1200,
    "Artista sa GMA": 4000,
    "Professional Chismosa": 1500,
    "Taga-bukas ng pinto sa 7-Eleven": 700,
    "Snatcher sa Quiapo": 2000,
    "Albularyo": 2800,
    "Sinabihan ng Pogi si <@1316339704454447154>": 10000,
    "Video editor ni <@748548558868709507>": 5000,
    "Vivamax Artist": 5000,
    "[PAPS WORKS](https://www.facebook.com/profile.php?id=61573478493835) Motorshop - <@750989582887157781>": BASE_WORK_AMOUNT,
};

function selectWorkJob() {
    const roll = Math.random() * 100;
    let cumulativeChance = 0;

    for (const job of WORK_JOB_WEIGHTS) {
        cumulativeChance += job.chance;
        if (roll < cumulativeChance) return job.name;
    }

    return WORK_JOB_WEIGHTS[WORK_JOB_WEIGHTS.length - 1].name;
}

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('work')
        .setDescription('Work to earn some money'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
            
            const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const now = Date.now();
            const ownerBypass = isBotOwner(userId);

            const userData = await getEconomyData(client, guildId, userId);

            if (!userData) {
                throw createError(
                    "Failed to load economy data for work",
                    ErrorTypes.DATABASE,
                    "Failed to load your economy data. Please try again later.",
                    { userId, guildId }
                );
            }

            logger.debug(`[ECONOMY] Work command started for ${userId}`, { userId, guildId });

            const lastWork = userData.lastWork || 0;
            const inventory = userData.inventory || {};
            const extraWorkShifts = inventory["extra_work"] || 0;
            const hasLaptop = inventory["laptop"] || 0;

            let cooldownActive = !ownerBypass && now < lastWork + WORK_COOLDOWN;
            let usedConsumable = false;

            if (cooldownActive) {
                if (extraWorkShifts > 0) {
                    inventory["extra_work"] = (inventory["extra_work"] || 0) - 1;
                    usedConsumable = true;
                } else {
                    const remaining = lastWork + WORK_COOLDOWN - now;
                    throw createError(
                        "Work cooldown active",
                        ErrorTypes.RATE_LIMIT,
                        `You're working too fast! Wait **${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m** before working again.`,
                        { timeRemaining: remaining, cooldownType: 'work' }
                    );
                }
            }

            const levelData = await getUserLevelData(client, guildId, userId);
            const memberLevel = Math.max(0, Number(levelData?.level) || 0);
            const levelBonus = memberLevel * WORK_LEVEL_BONUS;
            const job = selectWorkJob();
            const jobBasePay = WORK_JOB_SALARIES[job] ?? BASE_WORK_AMOUNT;
            let earned = jobBasePay + levelBonus;

            const baseEarnings = earned;
            const laptopBonus = hasLaptop > 0
                ? Math.floor(baseEarnings * (LAPTOP_MULTIPLIER - 1))
                : 0;
            if (hasLaptop > 0) {
                earned = Math.floor(earned * LAPTOP_MULTIPLIER);
            }

            userData.wallet = (userData.wallet || 0) + earned;
            userData.lastWork = now;

            await setEconomyData(client, guildId, userId, userData);

            logger.info(`[ECONOMY_TRANSACTION] Work completed`, {
                userId,
                guildId,
                amount: earned,
                job,
                usedConsumable,
                hasLaptop: hasLaptop > 0,
                newWallet: userData.wallet,
                timestamp: new Date().toISOString()
            });

            const earningsBreakdown = [
                `• Base pay: **₱${jobBasePay.toLocaleString()}**`,
                `• Level bonus (Level ${memberLevel}): **+₱${levelBonus.toLocaleString()}**`,
                ...(hasLaptop > 0 ? [`• Laptop bonus (+50%): **+₱${laptopBonus.toLocaleString()}**`] : []),
            ].join("\n");

            const embed = successEmbed(
                "💼 Work Complete!",
                `**Job:** ${job}\n**Total earned:** **₱${earned.toLocaleString()}**\n\n**Earnings breakdown**\n${earningsBreakdown}`
            )
                .addFields(
                    {
                        name: "💰 Bcash Balance",
                        value: `**₱${userData.wallet.toLocaleString()}**`,
                        inline: true,
                    },
                    {
                        name: "⏳ Next Work",
                        value: ownerBypass ? "**No cooldown (Bot Owner)**" : `<t:${Math.floor((now + WORK_COOLDOWN) / 1000)}:R>`,
                        inline: true,
                    }
                )
                .setFooter({
                    text: `Requested by ${interaction.user.tag}`,
                    iconURL: interaction.user.displayAvatarURL(),
                });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'work' })
};