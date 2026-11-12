import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getLevelingConfig, getUserLevelData, getXpForLevel } from '../../services/leveling/leveling.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

async function createLevelCard(user, data, rankName, progress, xpNeeded, remainingXp) {
  const width = 1000;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Black rank-card background with subtle charcoal gradients and accents.
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#080808');
  bg.addColorStop(0.55, '#111111');
  bg.addColorStop(1, '#050505');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#292929';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, width - 48, height - 48);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px Sans';
  ctx.fillText('BARRACKS  /  SOLDIER PROFILE', 58, 82);
  ctx.fillStyle = '#888888';
  ctx.font = '20px Sans';
  ctx.fillText(user.username.toUpperCase(), 60, 122);

  // Centered circular user avatar.
  const avatar = await loadImage(user.displayAvatarURL({ extension: 'png', size: 256 }));
  const avatarSize = 190;
  const avatarX = (width - avatarSize) / 2;
  const avatarY = 145;
  ctx.save();
  ctx.beginPath();
  ctx.arc(width / 2, avatarY + avatarSize / 2, avatarSize / 2 + 8, 0, Math.PI * 2);
  ctx.fillStyle = '#1c1c1c';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#d6d6d6';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(width / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 46px Sans';
  ctx.fillText(`LEVEL ${data.level}`, width / 2, 390);
  ctx.fillStyle = '#bdbdbd';
  ctx.font = '24px Sans';
  ctx.fillText(`RANK  •  ${rankName}`, width / 2, 430);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#999999';
  ctx.font = '20px Sans';
  ctx.fillText('XP PROGRESS', 60, 478);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${progress}%`, width - 60, 478);

  const barX = 60;
  const barY = 495;
  const barWidth = width - 120;
  const barHeight = 16;
  ctx.fillStyle = '#333333';
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 8);
  ctx.fill();
  ctx.fillStyle = '#eeeeee';
  ctx.beginPath();
  ctx.roundRect(barX, barY, Math.max(8, barWidth * progress / 100), barHeight, 8);
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#aaaaaa';
  ctx.font = '17px Sans';
  ctx.fillText(`${data.xp.toLocaleString()} / ${xpNeeded.toLocaleString()} XP  •  ${remainingXp.toLocaleString()} XP TO NEXT LEVEL`, 60, 540);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${data.totalXp.toLocaleString()} TOTAL XP`, width - 60, 540);

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
    const remainingXp = Math.max(0, xpNeeded - data.xp);
    const progress = xpNeeded > 0 ? Math.min(100, Math.floor((data.xp / xpNeeded) * 100)) : 100;

    const rewards = Object.entries(levelingConfig.roleRewards || {})
      .map(([level, roleId]) => ({ level: Number(level), roleId }))
      .filter((reward) => Number.isInteger(reward.level) && reward.level <= data.level)
      .sort((a, b) => b.level - a.level);
    const currentReward = rewards.find((reward) => member?.roles.cache.has(reward.roleId));
    const rankName = currentReward
      ? interaction.guild.roles.cache.get(currentReward.roleId)?.name || 'Unlocked'
      : 'Unranked';

    const image = await createLevelCard(targetUser, data, rankName, progress, xpNeeded, remainingXp);
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
