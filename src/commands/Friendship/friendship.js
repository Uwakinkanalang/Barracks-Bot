import { SlashCommandBuilder } from 'discord.js';
import { postFriendshipPanel } from '../../services/friendshipPanelService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('friendship')
    .setDescription('Barracks Friendship Center')
    .addSubcommand(sub => sub.setName('panel').setDescription('Post the interactive Friendship Center panel')),
  async execute(interaction) {
    if (interaction.options.getSubcommand() === 'panel') return postFriendshipPanel(interaction);
  },
};
