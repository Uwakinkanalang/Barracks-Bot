import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getAFKKey } from '../../utils/database.js';

const AFK_PREFIX = '[AFK] ';

function removeAfkPrefix(name) {
  let cleaned = name ?? '';
  while (cleaned.startsWith(AFK_PREFIX)) {
    cleaned = cleaned.slice(AFK_PREFIX.length);
  }
  return cleaned;
}

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
    const isBarracksGuild = Boolean(process.env.GUILD_ID) && interaction.guildId === process.env.GUILD_ID;
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

    const currentNickname = member?.nickname ?? null;
    const fallbackName = member?.user.globalName ?? member?.user.username ?? interaction.user.username;
    const cleanCurrentName = removeAfkPrefix(currentNickname ?? fallbackName);

    const status = {
      reason,
      since: previous?.since || previous?.timestamp || Date.now(),
      userId: interaction.user.id,
      guildId: interaction.guildId,
      originalNickname: previous?.originalNickname ?? (currentNickname ? removeAfkPrefix(currentNickname) : null),
      afkNickname: null,
    };

    if (isBarracksGuild && member) {
      status.afkNickname = `${AFK_PREFIX}${cleanCurrentName}`.slice(0, 32);
    }

    // Save AFK status even if Discord prevents the nickname update.
    await interaction.client.db.set(key, status);

    let nicknameNote = '';
    if (isBarracksGuild && member && status.afkNickname && currentNickname !== status.afkNickname) {
      try {
        await member.setNickname(status.afkNickname, 'Member activated AFK status');
        nicknameNote = '\nYour nickname now shows **[AFK]**.';
      } catch {
        nicknameNote = '\nI could not update your nickname. Please check my **Manage Nicknames** permission and role position.';
      }
    }

    return interaction.reply({
      content: `🌙 **AFK status activated.** I'll notify anyone who mentions you.\n**Reason:** ${reason}${nicknameNote}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
