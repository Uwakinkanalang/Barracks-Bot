import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getLevelingConfig, getUserLevelData, getXpForLevel } from '../../services/leveling/leveling.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('Check your level and XP (or another member\'s)')
    .setDMPermission(false)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Member whose level you want to check')
        .setRequired(false)
    ),

  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);

    const levelingConfig = await getLevelingConfig(client, interaction.guildId);
    if (!levelingConfig?.enabled) {
      return InteractionHelper.safeEditReply(interaction, {
        content: 'The leveling system is currently disabled on this server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const data = await getUserLevelData(client, interaction.guildId, targetUser.id);
    const xpNeeded = getXpForLevel(data.level);
    const currentXp = Math.max(0, data.xp || 0);
    const totalXp = Math.max(0, data.totalXp || 0);
    const progress = xpNeeded > 0 ? Math.min(100, Math.floor((currentXp / xpNeeded) * 100)) : 100;
    const remainingXp = Math.max(0, xpNeeded - currentXp);

    const rewards = Object.entries(levelingConfig.roleRewards || {})
      .map(([level, roleId]) => ({ level: Number(level), roleId }))
      .filter((reward) => Number.isInteger(reward.level) && reward.level <= data.level)
      .sort((a, b) => b.level - a.level);
    const currentReward = rewards.find((reward) => member?.roles.cache.has(reward.roleId));
    const rankName = currentReward
      ? interaction.guild.roles.cache.get(currentReward.roleId)?.name || 'Unlocked'
      : 'Unranked';

    const displayName = targetUser.globalName || targetUser.username;

    const embed = new EmbedBuilder()
      .setColor('#000000')
      .setAuthor({
        name: `${displayName}'s Level`,
        iconURL: targetUser.displayAvatarURL({ size: 128 }),
      })
      .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
      .setDescription([
        `**Level:** ${data.level}`,
        `**Rank:** ${rankName}`,
        '',
        `**EXP:** ${currentXp.toLocaleString('en-US')} / ${xpNeeded.toLocaleString('en-US')} XP`,
        `**EXP remaining:** ${remainingXp.toLocaleString('en-US')} XP`,
        '',
        `**Total EXP earned:** ${totalXp.toLocaleString('en-US')} XP`,
      ].join('\n'))
      .setFooter({ text: 'Keep chatting to earn more XP!' })
      .setTimestamp();

    return InteractionHelper.safeEditReply(interaction, {
      embeds: [embed],
    });
  },
};
