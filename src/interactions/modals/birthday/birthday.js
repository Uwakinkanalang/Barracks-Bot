import { MessageFlags } from 'discord.js';
import { setBirthday, validateBirthday } from '../../../services/birthdayService.js';

function parseBirthday(rawValue) {
  const value = rawValue.trim();
  const match = value.match(/^(\d{1,2})-(\d{1,2})(?:-(\d{4}))?$/);

  if (!match) {
    throw new Error('Please use MM-DD-YYYY or MM-DD (for example, 01-19-2000 or 01-19).');
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = match[3] ? Number(match[3]) : null;

  const validation = validateBirthday(month, day);
  if (!validation.isValid) {
    throw new Error(validation.error);
  }

  // If a year is supplied, validate the complete calendar date too.
  // The birthday feature stores recurring month/day, not the birth year.
  if (year !== null) {
    const date = new Date(year, month - 1, day);
    if (year < 1 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new Error('That date is not valid. Please check the month, day, and year.');
    }
  }

  return { month, day };
}

export default {
  name: 'birthday_submit',
  async execute(interaction, client) {
    try {
      const { month, day } = parseBirthday(interaction.fields.getTextInputValue('birthday_date'));
      const result = await setBirthday(client, interaction.guildId, interaction.user.id, month, day);

      await interaction.reply({
        content: `🎂 Your birthday has been saved as **${result.data.monthName} ${result.data.day}**! You can update or remove it anytime from the birthday panel.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: `⚠️ ${error.message || 'Could not save your birthday. Please try again.'}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
