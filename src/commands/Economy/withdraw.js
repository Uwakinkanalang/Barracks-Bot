import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getMaxBankCapacity } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { BotConfig } from '../../config/bot.js';
export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('withdraw')
        .setDescription('Withdraw money from your bank to your wallet')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to withdraw')
                .setRequired(true)
                .setMinValue(1)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        await InteractionHelper.safeDefer(interaction);
            
            const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const amountInput = interaction.options.getInteger("amount");

            const userData = await getEconomyData(client, guildId, userId);
            
            if (!userData) {
                throw createError(
                    "Failed to load economy data",
                    ErrorTypes.DATABASE,
                    "Failed to load your economy data. Please try again later.",
                    { userId, guildId }
                );
            }

            let withdrawAmount = amountInput;

            const minTransaction = BotConfig.economy.bankMinTransaction;
            const maxTransaction = BotConfig.economy.bankMaxTransaction;

            if (withdrawAmount < minTransaction) {
                throw createError(
                    "Withdrawal below minimum",
                    ErrorTypes.VALIDATION,
                    `Minimum withdrawal is ₱${minTransaction.toLocaleString()}.`,
                    { amount: withdrawAmount, minTransaction, userId }
                );
            }

            if (withdrawAmount > maxTransaction) {
                throw createError(
                    "Withdrawal exceeds transaction limit",
                    ErrorTypes.VALIDATION,
                    `Maximum withdrawal per transaction is ₱${maxTransaction.toLocaleString()}.`,
                    { amount: withdrawAmount, maxTransaction, userId }
                );
            }

            if (withdrawAmount <= 0) {
                throw createError(
                    "Invalid withdrawal amount",
                    ErrorTypes.VALIDATION,
                    "You must withdraw a positive amount.",
                    { amount: withdrawAmount, userId }
                );
            }

            if (withdrawAmount > userData.bank) {
                withdrawAmount = userData.bank;
            }

            if (withdrawAmount === 0) {
                throw createError(
                    "Empty bank account",
                    ErrorTypes.VALIDATION,
                    "Your bank account is empty.",
                    { userId, bankBalance: userData.bank }
                );
            }

            userData.wallet += withdrawAmount;
            userData.bank -= withdrawAmount;

            await setEconomyData(client, guildId, userId, userData);

            const embed = successEmbed(
                'Withdrawal Successful',
                `You successfully withdrew **₱${withdrawAmount.toLocaleString()}** from your bank.`
            )
                .addFields(
                    {
                        name: "New Cash Balance",
                        value: `₱${userData.wallet.toLocaleString()}`,
                        inline: true,
                    },
                    {
                        name: "New Bank Balance",
                        value: `₱${userData.bank.toLocaleString()}`,
                        inline: true,
                    },
                );

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'withdraw' })
};