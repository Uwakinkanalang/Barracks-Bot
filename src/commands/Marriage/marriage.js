import { SlashCommandBuilder } from 'discord.js';
import { postMarriagePanel } from '../../services/marriagePanelService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('marriage')
    .setDescription('Barracks Marriage Center')
    .addSubcommand(sub => sub.setName('panel').setDescription('Post the interactive Marriage Center panel')),
  async execute(interaction) {
    if (interaction.options.getSubcommand() === 'panel') return postMarriagePanel(interaction);
  },
};
