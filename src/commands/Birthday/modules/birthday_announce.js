import { EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getAllBirthdays } from '../../../services/birthdayService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

const BIRTHDAY_BANNER_URL = 'https://raw.githubusercontent.com/Uwakinkanalang/Barracks-Bot/main/birthday-banner.png';

function getManilaDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Manila',
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

export default {
    async execute(interaction, config, client) {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
            return InteractionHelper.safeReply(interaction, {
                content: 'You need **Manage Server** permission to post the birthday announcement.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        try {
            const guildConfig = await getGuildConfig(client, interaction.guildId);
            if (!guildConfig?.birthdayChannelId) {
                return InteractionHelper.safeEditReply(interaction, {
                    content: 'No birthday announcement channel is configured. Run `/birthday setchannel` first.',
                });
            }

            const channel = await interaction.guild.channels.fetch(guildConfig.birthdayChannelId).catch(() => null);
            if (!channel?.isTextBased() || !channel.send) {
                return InteractionHelper.safeEditReply(interaction, {
                    content: 'The configured birthday channel is unavailable. Please run `/birthday setchannel` again.',
                });
            }

            const { month, day } = getManilaDateParts();
            const birthdays = await getAllBirthdays(client, interaction.guildId);
            const todaysBirthdays = birthdays.filter(birthday => birthday.month === month && birthday.day === day);

            if (todaysBirthdays.length === 0) {
                return InteractionHelper.safeEditReply(interaction, {
                    content: 'There are no registered birthdays today (Philippine time). No announcement was posted.',
                });
            }

            const members = [];
            for (const birthday of todaysBirthdays) {
                const member = await interaction.guild.members.fetch(birthday.userId).catch(() => null);
                if (member) members.push(member);
            }

            if (members.length === 0) {
                return InteractionHelper.safeEditReply(interaction, {
                    content: 'No birthday celebrants from today\'s list are currently in this server.',
                });
            }

            const names = members.map(member => member.displayName);
            const mentions = members.map(member => member.toString()).join(', ');
            const plural = members.length > 1;
            const embed = new EmbedBuilder()
                .setColor(0x8BFF00)
                .setAuthor({
                    name: `BARRACKS • BIRTHDAY CELEBRATION`,
                    iconURL: interaction.guild.iconURL({ size: 128 }) || undefined,
                })
                .setTitle('🎂 HAPPY BIRTHDAY!')
                .setDescription([
                    '**ATTENTION, SOLDIERS!**',
                    '',
                    members.length === 1
                        ? `Today we celebrate **${mentions}'s Birthday**`
                        : `Today we celebrate the birthdays of **${mentions}**`,
                    '',
                    'Wishing you a day filled with happiness, good health, and strength!',
                    '',
                    'Enjoy your special day!',
                    '',
                    'From all of us at Barracks ♡',
                ].join('\n'))
                .setThumbnail(members[0].user.displayAvatarURL({ size: 256 }))
                .addFields(
                    { name: plural ? '🎁 Birthday Soldiers' : '🎁 Birthday Soldier', value: members.map(member => member.toString()).join('\n'), inline: true },
                    { name: '🎂 Celebrating Today', value: String(members.length), inline: true },
                )
                .setImage(BIRTHDAY_BANNER_URL)
                .setFooter({ text: `Barracks • ${interaction.guild.name}` })
                .setTimestamp();

            await channel.send({
                content: mentions,
                embeds: [embed],
                allowedMentions: { users: members.map(member => member.id) },
            });

            return InteractionHelper.safeEditReply(interaction, {
                content: `Birthday announcement posted in <#${channel.id}> for ${names.join(', ')}.`,
            });
        } catch (error) {
            logger.error('birthday_announce error:', error);
            return InteractionHelper.safeEditReply(interaction, {
                content: 'Something went wrong while posting the birthday announcement. Check the bot logs for details.',
            });
        }
    },
};
