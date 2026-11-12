import {
  ActionRowBuilder,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getUserBirthday } from '../../../services/birthdayService.js';

function getBirthdaySummary(birthday) {
  if (!birthday) {
    return "You haven't set a birthday yet. Submit a date below to register it.";
  }

  // Use the same Asia/Manila calendar as the automatic birthday announcements.
  const todayParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date());

  const part = (type) => Number(todayParts.find((item) => item.type === type)?.value);
  const today = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  let nextBirthday = new Date(Date.UTC(part('year'), birthday.month - 1, birthday.day));

  if (nextBirthday < today) {
    nextBirthday = new Date(Date.UTC(part('year') + 1, birthday.month - 1, birthday.day));
  }

  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(nextBirthday);

  const daysUntil = Math.round((nextBirthday - today) / 86400000);
  let relative;
  if (daysUntil === 0) {
    relative = 'today';
  } else if (daysUntil < 45) {
    relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(daysUntil, 'day');
  } else {
    const monthsUntil = Math.max(1, Math.round(daysUntil / 30.4375));
    relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(monthsUntil, 'month');
  }

  return `Your current birthday is **${dateLabel}** (${relative}).\nSubmit a new date below to update it.`;
}

export default [
  {
    name: 'birthday_set',
    async execute(interaction, client) {
      const existing = await getUserBirthday(client, interaction.guildId, interaction.user.id);
      const dateInput = new TextInputBuilder()
        .setCustomId('birthday_date')
        .setLabel('Your birthday (MM-DD-YYYY or MM-DD)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('MM-DD-YYYY or MM-DD')
        .setMinLength(5)
        .setMaxLength(10)
        .setRequired(true);

      if (existing) {
        dateInput.setValue(`${String(existing.month).padStart(2, '0')}-${String(existing.day).padStart(2, '0')}${existing.year ? `-${existing.year}` : ''}`);
      }

      const modal = new ModalBuilder()
        .setCustomId('birthday_submit')
        .setTitle('Set your birthday')
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(getBirthdaySummary(existing)),
        )
        .addComponents(new ActionRowBuilder().addComponents(dateInput));

      await interaction.showModal(modal);
    },
  },
  {
    name: 'birthday_remove',
    async execute(interaction, client) {
      const { deleteBirthday } = await import('../../../services/birthdayService.js');
      const result = await deleteBirthday(client, interaction.guildId, interaction.user.id);
      await interaction.reply({
        content: result.status === 'removed'
          ? '🎂 Your birthday has been removed from this server.'
          : 'You do not have a birthday registered yet.',
        ephemeral: true,
      });
    },
  },
];
