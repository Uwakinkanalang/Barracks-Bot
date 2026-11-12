import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { checkUserPermissions } from '../../utils/permissionGuard.js';
import { getLevelingConfig, getUserLevelData, getXpForLevel } from '../../services/leveling/leveling.js';
import { sendLevelUpAnnouncement } from '../../services/leveling/xpSystem.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder()
    .setName('testlevelup')
    .setDescription('Test the next role-reward level-up announcement without changing XP or roles')
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

    // Test the next configured role-reward level so the announcement includes
    // a role mention. This is display-only; no XP, level, or roles are changed.
    const rewardLevels = Object.keys(levelingConfig.roleRewards || {})
      .map(Number)
      .filter((level) => Number.isInteger(level) && level > 0)
      .sort((a, b) => a - b);
    const testLevel = rewardLevels.find((level) => level > currentData.level)
      ?? rewardLevels[0];

    if (!testLevel) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          createEmbed({
            title: 'No Role Rewards Configured',
            description: 'Set up at least one role reward level before testing the role-reward announcement.',
            color: 'error',
          }),
        ],
      });
      return;
    }

    const testLevelData = {
      ...currentData,
      level: testLevel,
      totalXp: currentData.totalXp + getXpForLevel(testLevel - 1),
    };

    const sent = await sendLevelUpAnnouncement(
      interaction.guild,
      member,
      testLevelData,
      levelingConfig,
      testLevel - 1
    );

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        createEmbed({
          title: sent ? 'Test Announcement Sent' : 'Could Not Send Test',
          description: sent
            ? 'The level-up test announcement was posted in your configured level-up channel (or the server system channel). Your XP, level, and roles were not changed.'
            : 'I could not send the test announcement. Check that the level-up channel is configured, is a text channel, and that I have Send Messages and Embed Links permissions.',
          color: sent ? 'success' : 'error',
        }),
      ],
    });
  },
};
