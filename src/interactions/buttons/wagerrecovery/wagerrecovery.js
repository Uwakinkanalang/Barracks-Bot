import { handleWagerRecoveryButton } from '../../../services/wagerRecoveryPanelService.js';

export default {
  name: 'wagerrecovery',
  async execute(interaction, client, args = []) {
    return handleWagerRecoveryButton(interaction, client, args[0]);
  },
};
