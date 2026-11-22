import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { renderWagerRecoveryPanel } from '../../services/wagerRecoveryPanelService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('wagerrecovery')
    .setDescription('Open the staff-only game wager recovery panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  category: 'Economy',
  async execute(interaction, config, client) {
    return renderWagerRecoveryPanel(interaction, client);
  },
};
