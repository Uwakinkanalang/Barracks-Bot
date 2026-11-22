import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed, buildUserErrorEmbed } from '../../utils/embeds.js';
import { withEconomyTransaction } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { BotConfig } from '../../config/bot.js';

const ROB_COOLDOWN = BotConfig.economy?.cooldowns?.rob ?? 4 * 60 * 60 * 1000;
const BASE_ROB_SUCCESS_CHANCE = BotConfig.economy?.robSuccessRate ?? 0.4;
const ROB_PERCENTAGE = 0.15;
const FINE_PERCENTAGE = 0.1;

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Attempt to rob another user (very risky)')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to rob')
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
            
            const robberId = interaction.user.id;
            const victimUser = interaction.options.getUser("user");
            const guildId = interaction.guildId;
            const now = Date.now();

            if (robberId === victimUser.id) {
                throw createError(
                    "Cannot rob self",
                    ErrorTypes.VALIDATION,
                    "You cannot rob yourself.",
                    { robberId, victimId: victimUser.id }
                );
            }
            
            if (victimUser.bot) {
                throw createError(
                    "Cannot rob bot",
                    ErrorTypes.VALIDATION,
                    "You cannot rob a bot.",
                    { victimId: victimUser.id, isBot: true }
                );
            }

            const robbery = await withEconomyTransaction(client, guildId, [robberId, victimUser.id], async (accounts) => {
                const robberData = accounts[robberId];
                const victimData = accounts[victimUser.id];
                const lastRob = Number(robberData.lastRob) || 0;
                if (now < lastRob + ROB_COOLDOWN) {
                    const remaining = lastRob + ROB_COOLDOWN - now;
                    const hours = Math.floor(remaining / (1000 * 60 * 60));
                    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
                    throw createError("Robbery cooldown active", ErrorTypes.RATE_LIMIT,
                        `You need to lay low. Wait **${hours}h ${minutes}m** before attempting another robbery.`,
                        { remaining, hours, minutes, cooldownType: 'rob' });
                }
                if ((Number(victimData.wallet) || 0) < 500) {
                    throw createError("Victim too poor", ErrorTypes.VALIDATION,
                        `${victimUser.username} is too poor. They need at least ₱500 cash to be worth robbing.`,
                        { victimWallet: victimData.wallet, required: 500 });
                }

                robberData.lastRob = now;
                if ((Number(victimData.inventory?.personal_safe) || 0) > 0) {
                    return { blockedBySafe: true, robberData: structuredClone(robberData), victimData: structuredClone(victimData) };
                }

                const isSuccessful = Math.random() < BASE_ROB_SUCCESS_CHANCE;
                let amountStolen = 0;
                let fineAmount = 0;
                if (isSuccessful) {
                    amountStolen = Math.floor((Number(victimData.wallet) || 0) * ROB_PERCENTAGE);
                    robberData.wallet = (Number(robberData.wallet) || 0) + amountStolen;
                    victimData.wallet = (Number(victimData.wallet) || 0) - amountStolen;
                } else {
                    fineAmount = Math.floor((Number(robberData.wallet) || 0) * FINE_PERCENTAGE);
                    robberData.wallet = Math.max(0, (Number(robberData.wallet) || 0) - fineAmount);
                }
                return {
                    blockedBySafe: false, isSuccessful, amountStolen, fineAmount,
                    robberData: structuredClone(robberData), victimData: structuredClone(victimData),
                };
            });

            const { robberData, victimData } = robbery;
            if (robbery.blockedBySafe) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [warningEmbed(
                        'Robbery Blocked',
                        `${victimUser.username} was prepared! Your attempt failed because they own a **Personal Safe**. You got away clean but didn't gain anything.`
                    )],
                });
            }

            let resultEmbed;
            if (robbery.isSuccessful) {
                resultEmbed = successEmbed(
                    'Robbery Successful',
                    `You successfully stole **₱${robbery.amountStolen.toLocaleString()}** from ${victimUser.username}!`
                );
            } else {
                resultEmbed = buildUserErrorEmbed(
                    'unknown',
                    `You failed the robbery and were caught! You were fined **₱${robbery.fineAmount.toLocaleString()}** of your own cash.`,
                    { titleOverride: 'Robbery Failed' }
                );
            }

            resultEmbed
                .addFields(
                    {
                        name: `Your New Cash (${interaction.user.username})`,
                        value: `₱${robberData.wallet.toLocaleString()}`,
                        inline: true,
                    },
                    {
                        name: `Victim's New Cash (${victimUser.username})`,
                        value: `₱${victimData.wallet.toLocaleString()}`,
                        inline: true,
                    },
                )
                .setFooter({ text: `Next robbery available in ${Math.ceil(ROB_COOLDOWN / (60 * 60 * 1000))} hours.` });

            await InteractionHelper.safeEditReply(interaction, { embeds: [resultEmbed] });
    }, { command: 'rob' })
};