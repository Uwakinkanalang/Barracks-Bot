import { SlashCommandBuilder } from 'discord.js';

// The test command is handled directly in messageCreate.js so it remains
// available even if the generic prefix-command registry changes.
export default {
  prefixOnly: true,
  data: new SlashCommandBuilder()
    .setName('booster')
    .setDescription('Test the Barracks boost thank-you announcement'),
  async execute() {
    // Intentionally handled by the dedicated b!booster test route.
  },
};
