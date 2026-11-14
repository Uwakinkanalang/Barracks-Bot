import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getAFKKey } from '../../utils/database.js';

const AFK_PREFIX = '[AFK] ';

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
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

    const status = {
      reason,
      since: previous?.since || previous?.timestamp || Date.now(),
      userId: interaction.user.id,
      guildId: interaction.guildId,
      originalNickname: previous?.originalNickname ?? member?.nickname ?? null,
      afkNickname: previous?.afkNickname ?? null,
    };

    if (member && !status.afkNickname) {
      const baseName = member.nickname ?? member.user.globalName ?? member.user.username;
      status.afkNickname = `${AFK_PREFIX}${baseName}`.slice(0, 32);
    }

    // Save AFK status even if Discord prevents the nickname update.
    await interaction.client.db.set(key, status);

    let nicknameNote = '';
    if (member && status.afkNickname && member.nickname !== status.afkNickname) {
      try {
        await member.setNickname(status.afkNickname, 'Member activated AFK status');
        nicknameNote = '\\nYour nickname now shows **[AFK]**.';
      } catch {
        nicknameNote = '\\nI could not update your nickname. Please check my **Manage Nicknames** permission and role position.';
      }
    }

    return interaction.reply({
      content: `🌙 **AFK status activated.** I'll notify anyone who mentions you.\\n**Reason:** ${reason}${nicknameNote}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
