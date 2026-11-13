import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botConfig } from '../../config/bot.js';
import { getUserLevelData } from '../../services/leveling/leveling.js';

const WORK_COOLDOWN = botConfig.economy?.cooldowns?.work ?? 30 * 60 * 1000;
const BASE_WORK_AMOUNT = 700;
const WORK_LEVEL_BONUS = 100;
const LAPTOP_MULTIPLIER = 1.5;
const WORK_JOBS = [
    "Software Developer",
    "Barista",
    "Janitor",
    "YouTuber",
    "Discord Bot Developer",
    "Cashier",
    "Pizza Delivery Driver",
    "Librarian",
    "Gardener",
    "Data Analyst",
];

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

            let cooldownActive = now < lastWork + WORK_COOLDOWN;
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
            let earned = BASE_WORK_AMOUNT + levelBonus;
            const job = WORK_JOBS[Math.floor(Math.random() * WORK_JOBS.length)];

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
                `• Base pay: **₱${BASE_WORK_AMOUNT.toLocaleString()}**`,
                `• Level bonus (Level ${memberLevel}): **+₱${levelBonus.toLocaleString()}**`,
                ...(hasLaptop > 0 ? [`• Laptop bonus (+50%): **+₱${laptopBonus.toLocaleString()}**`] : []),
            ].join("\\n");

            const embed = successEmbed(
                "💼 Work Complete!",
                `**Job:** ${job}\\n**Total earned:** **₱${earned.toLocaleString()}**\\n\\n**Earnings breakdown**\\n${earningsBreakdown}`
            )
                .addFields(
                    {
                        name: "💰 Bcash Balance",
                        value: `**₱${userData.wallet.toLocaleString()}**`,
                        inline: true,
                    },
                    {
                        name: "⏳ Next Work",
                        value: `<t:${Math.floor((now + WORK_COOLDOWN) / 1000)}:R>`,
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