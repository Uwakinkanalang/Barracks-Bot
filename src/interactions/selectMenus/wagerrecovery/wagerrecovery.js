import { handleWagerRecoverySelect } from '../../../services/wagerRecoveryPanelService.js';

export default {
  name: 'wagerrecovery',
  async execute(interaction, client) {
    return handleWagerRecoverySelect(interaction, client);
  },
};
