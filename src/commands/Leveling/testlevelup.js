import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { checkUserPermissions } from '../../utils/permissionGuard.js';
import { getLevelingConfig, getUserLevelData, getXpForLevel } from '../../services/leveling/leveling.js';
import { sendLevelUpAnnouncement } from '../../services/leveling/xpSystem.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder()
    .setName('testlevelup')
    .setDescription('Send a test of the level-up announcement without changing XP')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction, { ephemeral: true });

    const hasPermission = await checkUserPermissions(
      interaction,
      PermissionFlagsBits.ManageGuild,
      'You need Manage Server permission to use this command.'
    );
    if (!hasPermission) return;

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const levelingConfig = await getLevelingConfig(client, interaction.guildId);
    const currentData = await getUserLevelData(client, interaction.guildId, member.id);

    // Simulate the next level for display only. No XP or level data is saved.
    const testLevelData = {
      ...currentData,
      level: Math.min(currentData.level + 1, 1000),
      totalXp: currentData.totalXp + getXpForLevel(currentData.level),
    };

    const sent = await sendLevelUpAnnouncement(
      interaction.guild,
      member,
      testLevelData,
      levelingConfig
    );

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        createEmbed({
          title: sent ? 'Test Announcement Sent' : 'Could Not Send Test',
          description: sent
            ? 'The level-up test announcement was posted in your configured level-up channel (or the server system channel). Your XP and level were not changed.'
            : 'I could not send the test announcement. Check that the level-up channel is configured, is a text channel, and that I have Send Messages and Embed Links permissions.',
          color: sent ? 'success' : 'error',
        }),
      ],
    });
  },
};
