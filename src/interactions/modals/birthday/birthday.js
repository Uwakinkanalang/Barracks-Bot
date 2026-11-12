import { MessageFlags } from 'discord.js';
import { setBirthday, validateBirthday } from '../../../services/birthdayService.js';

function parseBirthday(rawValue) {
  const value = rawValue.trim();
  let month;
  let day;

  let match = value.match(/^(?:\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    month = Number(match[1]);
    day = Number(match[2]);
  } else {
    match = value.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
      throw new Error('Please use YYYY-MM-DD or MM-DD (for example, 2000-01-19 or 01-19).');
    }
    month = Number(match[1]);
    day = Number(match[2]);
  }

  const validation = validateBirthday(month, day);
  if (!validation.isValid) {
    throw new Error(validation.error);
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
