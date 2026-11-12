import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getLevelingConfig, getUserLevelData, getXpForLevel, getLeaderboard } from '../../services/leveling/leveling.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

async function createLevelCard(user, data, rankName, rankNumber, progress, xpNeeded) {
  const width = 1000;
  const height = 324;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Outer charcoal frame and inset black card, matching the supplied reference.
  ctx.fillStyle = '#242729';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#55595c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(16, 14, 968, 296, 14);
  ctx.stroke();

  ctx.fillStyle = '#080909';
  ctx.beginPath();
  ctx.roundRect(54, 48, 892, 228, 16);
  ctx.fill();

  // Rank and level at the top corners.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e7e7e7';
  ctx.font = '28px Sans';
  ctx.fillText('RANK', 78, 102);
  ctx.font = 'bold 46px Sans';
  ctx.fillText(`#${rankNumber || '—'}`, 164, 106);

  ctx.textAlign = 'right';
  ctx.font = '28px Sans';
  ctx.fillText('LEVEL', 855, 102);
  ctx.font = 'bold 46px Sans';
  ctx.fillText(String(data.level), 920, 106);

  // Centered circular avatar.
  const avatar = await loadImage(user.displayAvatarURL({ extension: 'png', size: 256 }));
  const avatarSize = 138;
  const avatarX = (width - avatarSize) / 2;
  const avatarY = 60;
  ctx.save();
  ctx.beginPath();
  ctx.arc(width / 2, avatarY + avatarSize / 2, avatarSize / 2 + 5, 0, Math.PI * 2);
  ctx.fillStyle = '#f4f4f4';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(width / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  ctx.restore();

  // Display name and XP figures on the lower line.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px Sans';
  let displayName = user.globalName || user.username;
  while (ctx.measureText(displayName).width > 480 && displayName.length > 4) {
    displayName = displayName.slice(0, -2) + '…';
  }
  ctx.fillText(displayName, 78, 204);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#d5d5d5';
  ctx.font = 'bold 22px Sans';
  ctx.fillText(`${(data.xp / 1000).toFixed(1)}k / ${(xpNeeded / 1000).toFixed(1)}k XP`, 920, 202);

  // Wide white progress bar with a dark grey remainder.
  const barX = 78;
  const barY = 216;
  const barWidth = 842;
  const barHeight = 38;
  ctx.fillStyle = '#484b4e';
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 20);
  ctx.fill();
  if (progress > 0) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.max(barHeight, barWidth * progress / 100), barHeight, 20);
    ctx.fill();
  }

  return canvas.toBuffer('image/png');
}

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
    const progress = xpNeeded > 0 ? Math.min(100, Math.floor((data.xp / xpNeeded) * 100)) : 100;
    const leaderboard = await getLeaderboard(client, interaction.guildId, 100);
    const rankIndex = leaderboard.findIndex((entry) => entry.userId === targetUser.id);
    const rankNumber = rankIndex >= 0 ? rankIndex + 1 : '—';

    const rewards = Object.entries(levelingConfig.roleRewards || {})
      .map(([level, roleId]) => ({ level: Number(level), roleId }))
      .filter((reward) => Number.isInteger(reward.level) && reward.level <= data.level)
      .sort((a, b) => b.level - a.level);
    const currentReward = rewards.find((reward) => member?.roles.cache.has(reward.roleId));
    const rankName = currentReward
      ? interaction.guild.roles.cache.get(currentReward.roleId)?.name || 'Unlocked'
      : 'Unranked';

    const image = await createLevelCard(targetUser, data, rankName, rankNumber, progress, xpNeeded);
    const attachment = new AttachmentBuilder(image, { name: 'level-card.png' });
    const embed = new EmbedBuilder()
      .setColor('#000000')
      .setImage('attachment://level-card.png')
      .setFooter({ text: 'Keep chatting to earn more XP!' })
      .setTimestamp();

    return InteractionHelper.safeEditReply(interaction, {
      embeds: [embed],
      files: [attachment],
    });
  },
};
