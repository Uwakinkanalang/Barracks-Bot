import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getAFKKey } from '../../utils/database.js';

export default {
  data: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Mark yourself as away')
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Why you are away (optional)')
        .setMaxLength(200)
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'Use this command inside a server.', flags: MessageFlags.Ephemeral });
    }

    const key = getAFKKey(interaction.guildId, interaction.user.id);
    const previous = await interaction.client.db.get(key, null);
    const reason = interaction.options.getString('reason')?.trim() || 'AFK';

    await interaction.client.db.set(key, {
      reason,
      since: previous?.since || previous?.timestamp || Date.now(),
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    return interaction.reply({
      content: `🌙 **AFK status activated.** I'll notify anyone who mentions you.\n**Reason:** ${reason}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
