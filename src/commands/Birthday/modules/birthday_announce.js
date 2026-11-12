import { EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { getTodaysBirthdays } from '../../../services/birthdayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

export default {
    async execute(interaction, config, client) {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
            return InteractionHelper.safeReply(interaction, {
                content: 'You need **Manage Server** permission to announce birthdays.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const channel = interaction.options.getChannel('channel', true);
        if (!channel.isTextBased() || channel.guildId !== interaction.guildId || typeof channel.send !== 'function') {
            return InteractionHelper.safeReply(interaction, {
                content: 'Please select a text channel in this server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        try {
            const todaysBirthdays = await getTodaysBirthdays(client, interaction.guildId);
            if (todaysBirthdays.length === 0) {
                return InteractionHelper.safeEditReply(interaction, {
                    content: '🎂 There are no birthdays registered for today.',
                });
            }

            const birthdayMembers = [];
            for (const birthday of todaysBirthdays) {
                const member = await interaction.guild.members.fetch(birthday.userId).catch(() => null);
                if (member) birthdayMembers.push(member);
            }

            if (birthdayMembers.length === 0) {
                return InteractionHelper.safeEditReply(interaction, {
                    content: '🎂 No birthday celebrants from today\'s list are currently in this server.',
                });
            }

            const mentions = birthdayMembers.map(member => member.toString()).join(', ');
            const names = birthdayMembers.map(member => member.displayName).join(', ');
            const embed = new EmbedBuilder()
                .setColor(0xff69b4)
                .setAuthor({
                    name: `🎂 Birthday Celebration • ${interaction.guild.name}`,
                    iconURL: interaction.guild.iconURL({ size: 128 }) || undefined,
                })
                .setTitle('🎉 Happy Birthday!')
                .setDescription([
                    `Everyone, let's celebrate ${names}!`,
                    '',
                    'Wishing you a wonderful birthday filled with happiness, laughter, and unforgettable memories. 🥳🎈',
                    '',
                    '**Have an amazing day!** 💖',
                ].join('\n'))
                .addFields({
                    name: birthdayMembers.length > 1 ? '🎁 Celebrants' : '🎁 Celebrant',
                    value: names,
                    inline: true,
                }, {
                    name: '🎂 Today\'s Celebrants',
                    value: String(birthdayMembers.length),
                    inline: true,
                })
                .setThumbnail(birthdayMembers[0].displayAvatarURL({ size: 256 }))
                .setFooter({ text: `Celebrating you • ${interaction.guild.name}` })
                .setTimestamp();

            if (process.env.BIRTHDAY_BANNER_URL) {
                embed.setImage(process.env.BIRTHDAY_BANNER_URL);
            }

            await channel.send({
                content: mentions,
                embeds: [embed],
                allowedMentions: {
                    users: birthdayMembers.map(member => member.id),
                    roles: [],
                    parse: [],
                },
            });

            return InteractionHelper.safeEditReply(interaction, {
                content: `✅ Birthday announcement posted in ${channel} for ${birthdayMembers.length} celebrant${birthdayMembers.length === 1 ? '' : 's'}.`,
            });
        } catch (error) {
            logger.error('Manual birthday announcement failed:', error);
            return InteractionHelper.safeEditReply(interaction, {
                content: '❌ I could not post the birthday announcement. Please check that I have permission to view and send messages in that channel.',
            });
        }
    },
};
