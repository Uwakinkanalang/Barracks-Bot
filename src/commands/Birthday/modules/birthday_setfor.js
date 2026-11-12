import { EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { setBirthday } from '../../../services/birthdayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';

export default {
    async execute(interaction, config, client) {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('Permission Denied')
                .setDescription('You need **Manage Server** permissions to set another member\'s birthday.');
            return InteractionHelper.safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        const target = interaction.options.getUser('user');
        const month = interaction.options.getInteger('month');
        const day = interaction.options.getInteger('day');

        if (!target || target.bot) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('Invalid Member')
                .setDescription('Please choose a valid server member (not a bot).');
            return InteractionHelper.safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!member) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('Member Not Found')
                .setDescription('That user is not a member of this server.');
            return InteractionHelper.safeReply(interaction, {
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        await InteractionHelper.safeDefer(interaction);
        const result = await setBirthday(client, interaction.guildId, target.id, month, day);

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Member Birthday Updated!')
            .setDescription(`Set **${member.user.username}**'s birthday to **${result.data.monthName} ${result.data.day}**.`)
            .setThumbnail(member.displayAvatarURL({ size: 256 }));

        return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    },
};
