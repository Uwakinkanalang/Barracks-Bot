import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { saveGiveaway } from '../../utils/giveaways.js';
import { 
    parseDuration, 
    validatePrize, 
    validateWinnerCount,
    createGiveawayEmbed, 
    createGiveawayButtons 
} from '../../services/giveawayService.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

import { botConfig } from '../../config/bot.js';

const GIVEAWAY_MIN_WINNERS = botConfig.giveaways?.minimumWinners ?? 1;
const GIVEAWAY_MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;

export default {
    data: new SlashCommandBuilder()
        .setName("gcreate")
        .setDescription("Starts a new giveaway in a specified channel.")
        .addStringOption((option) =>
            option
                .setName("duration")
                .setDescription(
                    "How long the giveaway should last (e.g., 1h, 30m, 5d).",
                )
                .setRequired(true),
        )
        .addIntegerOption((option) =>
            option
                .setName("winners")
                .setDescription("The number of winners to pick.")
                .setMinValue(GIVEAWAY_MIN_WINNERS)
                .setMaxValue(GIVEAWAY_MAX_WINNERS)
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("prize")
                .setDescription("The prize being given away.")
                .setRequired(true),
        )
        .addIntegerOption((option) =>
            option.setName("first_place")
                .setDescription("bCash for 1st place (optional).")
                .setMinValue(0)
                .setMaxValue(1000000000)
                .setRequired(false),
        )
        .addIntegerOption((option) =>
            option.setName("second_place")
                .setDescription("bCash for 2nd place (optional).")
                .setMinValue(0)
                .setMaxValue(1000000000)
                .setRequired(false),
        )
        .addIntegerOption((option) =>
            option.setName("third_place")
                .setDescription("bCash for 3rd place (optional).")
                .setMinValue(0)
                .setMaxValue(1000000000)
                .setRequired(false),
        )
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("The channel to send the giveaway to (defaults to current channel).")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        // Defer up front: sending the giveaway message + DB write can exceed the 3s window
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        if (!interaction.inGuild()) {
            throw new TitanBotError(
                'Giveaway command used outside guild',
                ErrorTypes.VALIDATION,
                'This command can only be used in a server.',
                { userId: interaction.user.id }
            );
        }

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            throw new TitanBotError(
                'User lacks ManageGuild permission',
                ErrorTypes.PERMISSION,
                "You need the 'Manage Server' permission to start a giveaway.",
                { userId: interaction.user.id, guildId: interaction.guildId }
            );
        }

        logger.info(`Giveaway creation started by ${interaction.user.tag} in guild ${interaction.guildId}`);

        const durationString = interaction.options.getString("duration");
        const winnerCount = interaction.options.getInteger("winners");
        const prize = interaction.options.getString("prize");
        const firstPlace = interaction.options.getInteger("first_place");
        const secondPlace = interaction.options.getInteger("second_place");
        const thirdPlace = interaction.options.getInteger("third_place");
        const bCashPrizes = [firstPlace, secondPlace, thirdPlace].some(value => value !== null)
            ? { first: firstPlace ?? 0, second: secondPlace ?? 0, third: thirdPlace ?? 0 }
            : null;
        if (bCashPrizes && winnerCount !== 3) {
            throw new TitanBotError('bCash prize tiers require three winners', ErrorTypes.VALIDATION,
                'Set the winner count to 3 when using first, second, and third place bCash prizes.');
        }
        const targetChannel = interaction.options.getChannel("channel") || interaction.channel;

        const durationMs = parseDuration(durationString);
        validateWinnerCount(winnerCount);
        const prizeName = validatePrize(prize);

        if (!targetChannel.isTextBased()) {
            throw new TitanBotError(
                'Target channel is not text-based',
                ErrorTypes.VALIDATION,
                'The channel must be a text channel.',
                { channelId: targetChannel.id, channelType: targetChannel.type }
            );
        }

        const endTime = Date.now() + durationMs;

        const initialGiveawayData = {
            messageId: "placeholder",
            channelId: targetChannel.id,
            guildId: interaction.guildId,
            prize: prizeName,
            hostId: interaction.user.id,
            endTime: endTime,
            endsAt: endTime,
            winnerCount: winnerCount,
            bCashPrizes,
            participants: [],
            isEnded: false,
            ended: false,
            createdAt: new Date().toISOString()
        };

        const embed = createGiveawayEmbed(initialGiveawayData, "active");
        const row = createGiveawayButtons(false);

        const giveawayMessage = await targetChannel.send({
            content: "🎉 **NEW GIVEAWAY** 🎉",
            embeds: [embed],
            components: [row],
        });

        initialGiveawayData.messageId = giveawayMessage.id;
        const saved = await saveGiveaway(
            interaction.client,
            interaction.guildId,
            initialGiveawayData,
        );

        if (!saved) {
            logger.warn(`Failed to save giveaway to database: ${giveawayMessage.id}`);
        }

        try {
            await logEvent({
                client: interaction.client,
                guildId: interaction.guildId,
                eventType: EVENT_TYPES.GIVEAWAY_CREATE,
                data: {
                    description: `Giveaway created: ${prizeName}`,
                    channelId: targetChannel.id,
                    userId: interaction.user.id,
                    fields: [
                        {
                            name: 'Prize',
                            value: prizeName,
                            inline: true
                        },
                        {
                            name: 'Winners',
                            value: winnerCount.toString(),
                            inline: true
                        },
                        {
                            name: 'Duration',
                            value: durationString,
                            inline: true
                        },
                        ...(bCashPrizes ? [{ name: 'bCash Prizes', value: `1st: ₱${bCashPrizes.first.toLocaleString()} | 2nd: ₱${bCashPrizes.second.toLocaleString()} | 3rd: ₱${bCashPrizes.third.toLocaleString()}`, inline: false }] : []),
                        {
                            name: 'Channel',
                            value: targetChannel.toString(),
                            inline: true
                        }
                    ]
                }
            });
        } catch (logError) {
            logger.debug('Error logging giveaway creation event:', logError);
        }

        logger.info(`Giveaway created successfully: ${giveawayMessage.id} in ${targetChannel.name}`);

        await InteractionHelper.safeReply(interaction, {
            embeds: [
                successEmbed(
                    `Giveaway Started! 🎉`,
                    `A new giveaway for **${prizeName}** has been started in ${targetChannel} and will end in **${durationString}**.`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });
    },
};