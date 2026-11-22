import { handleWagerRecoveryModal } from '../../../services/wagerRecoveryPanelService.js';

export default {
  name: 'wagerrecovery',
  async execute(interaction, client, args = []) {
    return handleWagerRecoveryModal(interaction, client, args);
  },
};
