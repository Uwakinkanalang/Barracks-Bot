import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { getEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import EconomyService from '../../services/economyService.js';

export default {
    prefixOnly: true,
    data: new SlashCommandBuilder()
        .setName('bgive')
        .setDescription('Give BCash from your wallet to another member')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Member who will receive your BCash')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount of BCash to send')
                .setMinValue(1)
                .setMaxValue(1000000000)
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const senderId = interaction.user.id;
        const receiver = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const guildId = interaction.guildId;

        if (!receiver) {
            throw createError(
                'Missing recipient',
                ErrorTypes.VALIDATION,
                'Please mention a server member. Example: `bgive @user 500`.'
            );
        }

        if (receiver.bot) {
            throw createError(
                'Cannot give BCash to a bot',
                ErrorTypes.VALIDATION,
                'Bots cannot receive BCash.'
            );
        }

        if (receiver.id === senderId) {
            throw createError(
                'Cannot give BCash to yourself',
                ErrorTypes.VALIDATION,
                'You cannot send BCash to yourself.'
            );
        }

        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw createError(
                'Invalid BCash amount',
                ErrorTypes.VALIDATION,
                'Enter a whole-number amount greater than zero.'
            );
        }

        const [senderData, receiverData] = await Promise.all([
            getEconomyData(client, guildId, senderId),
            getEconomyData(client, guildId, receiver.id)
        ]);

        if (!senderData || !receiverData) {
            throw createError(
                'Failed to load economy data',
                ErrorTypes.DATABASE,
                'Could not load a wallet. Please try again later.'
            );
        }

        const result = await EconomyService.transferMoney(
            client,
            guildId,
            senderId,
            receiver.id,
            amount
        );

        const embed = successEmbed(
            'BCash Transfer',
            `<@${senderId}> gave BCash to <@${receiver.id}>.`
        ).addFields({
            name: '💸 Amount Sent',
            value: `₱${amount.toLocaleString()}`,
            inline: true
        }).setFooter({
            text: `Sent to ${receiver.username}`,
            iconURL: receiver.displayAvatarURL?.()
        });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

        logger.info('[ECONOMY] BCash transfer completed', {
            guildId,
            senderId,
            receiverId: receiver.id,
            amount,
            senderNewBalance: result.senderNewBalance,
            receiverNewBalance: result.receiverNewBalance
        });

        try {
            const receiverEmbed = createEmbed({
                title: '💰 You Received BCash!',
                description: `<@${senderId}> sent you **₱${amount.toLocaleString()} BCash**.`
            }).addFields({
                name: 'Your New Cash',
                value: `₱${result.receiverNewBalance.toLocaleString()}`,
                inline: true
            });
            await receiver.send({ embeds: [receiverEmbed] });
        } catch (error) {
            logger.debug(`Could not DM BCash recipient ${receiver.id}: ${error.message}`);
        }
    }, { command: 'bgive' })
};
