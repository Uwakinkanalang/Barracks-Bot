import { SlashCommandBuilder } from 'discord.js';
import { addMoney } from '../../utils/economy.js';
import { isBotOwner } from '../../config/bot.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const BARRACKS_GUILD_ID = '1137695060096471160';

export default {
    data: new SlashCommandBuilder()
        .setName('addcash')
        .setDescription('Add cash to a member’s wallet (bot owner only)')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Member who will receive the cash')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount of cash to add')
                .setMinValue(1)
                .setMaxValue(1000000000)
                .setRequired(true)
        ),

    async execute(interaction, config, client) {
        if (interaction.guildId !== BARRACKS_GUILD_ID) {
            return InteractionHelper.universalReply(interaction, {
                embeds: [errorEmbed('Wrong Server', 'This command is only available in the Barracks server.')],
                ephemeral: true,
            });
        }

        if (!isBotOwner(interaction.user.id)) {
            return InteractionHelper.universalReply(interaction, {
                embeds: [errorEmbed('Permission Denied', 'Only the configured bot owner can use this command.')],
                ephemeral: true,
            });
        }

        const target = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount', true);

        if (target.bot) {
            return InteractionHelper.universalReply(interaction, {
                embeds: [errorEmbed('Invalid Target', 'Bots cannot receive economy cash.')],
                ephemeral: true,
            });
        }

        await InteractionHelper.safeDefer(interaction, true);

        const result = await addMoney(client, interaction.guildId, target.id, amount, 'wallet');

        return InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    'Cash Added',
                    `Added **₱${amount.toLocaleString()}** to <@${target.id}>’s cash wallet.\n**New wallet balance:** ₱${result.newBalance.toLocaleString()}\n**Bank balance:** unchanged.`
                ),
            ],
        });
    },
};
