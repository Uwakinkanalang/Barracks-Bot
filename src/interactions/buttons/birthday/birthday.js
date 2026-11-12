import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getUserBirthday } from '../../../services/birthdayService.js';

export default [
  {
    name: 'birthday_set',
    async execute(interaction, client) {
      const existing = await getUserBirthday(client, interaction.guildId, interaction.user.id);
      const dateInput = new TextInputBuilder()
        .setCustomId('birthday_date')
        .setLabel(existing
          ? `Birthday (current: ${existing.monthName} ${existing.day})`
          : 'Your birthday (YYYY-MM-DD or MM-DD)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('YYYY-MM-DD or MM-DD')
        .setMinLength(5)
        .setMaxLength(10)
        .setRequired(true);

      if (existing) {
        dateInput.setValue(`${String(existing.month).padStart(2, '0')}-${String(existing.day).padStart(2, '0')}`);
      }

      const modal = new ModalBuilder()
        .setCustomId('birthday_submit')
        .setTitle('Set your birthday')
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
