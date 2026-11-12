import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import {
  calculateTotalXp,
  getUserLevelData,
  getXpForLevel,
  saveUserLevelData,
} from '../../services/leveling/leveling.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const USERS = [
  '986514869866086400',
  '1052184704301932574',
  '1513957837771116623',
  '764053723290796063',
  '1316339704454447154',
  '1490331824298131570',
  '748548558868709507',
  '980727631001583626',
  '807915293951000616',
  '1539623549629763636',
  '850617308195323955',
  '1267753267073519617',
  '1512744657170338000',
  '589432225221574666',
  '750341804175392769',
  '803983257317277733',
];

const MIGRATION_VERSION = 'level-xp-1000-per-level-v1';

function previousXpForLevel(level) {
  if (level >= 31) {
    const above31 = level - 31;
    return Math.round(5900 + (400 * above31) + (1.5 * above31 * (above31 - 1)));
  }
  return Math.round((5 * level ** 2 + 50 * level + 50) * 0.95);
}

export default {
  data: new SlashCommandBuilder()
    .setName('synclevels')
    .setDescription('Recalculate the 16 imported member XP totals while preserving levels and progress')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  category: 'Leveling',

  async execute(interaction, config, client) {
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return InteractionHelper.universalReply(interaction, {
        content: 'You need Administrator permission to use this command.',
        ephemeral: true,
      });
    }

    await InteractionHelper.safeDefer(interaction);
    const results = [];
    let changed = 0;
    let skipped = 0;

    for (const userId of USERS) {
      const markerKey = `guild:${interaction.guildId}:leveling:${MIGRATION_VERSION}:${userId}`;
      const alreadyDone = await client.db.get(markerKey);
      if (alreadyDone) {
        skipped += 1;
        continue;
      }

      const data = await getUserLevelData(client, interaction.guildId, userId);
      if (!data || data.totalXp <= 0 || data.level <= 0) {
        results.push(`<@${userId}> — no saved leveling data; left unchanged`);
        continue;
      }

      const oldRequirement = previousXpForLevel(data.level);
      const newRequirement = getXpForLevel(data.level);
      const progress = Math.min(1, Math.max(0, data.xp / oldRequirement));
      const adjustedXp = Math.min(newRequirement - 1, Math.max(0, Math.round(progress * newRequirement)));

      const updated = {
        ...data,
        level: data.level,
        xp: adjustedXp,
        totalXp: calculateTotalXp(data.level, adjustedXp),
      };

      await saveUserLevelData(client, interaction.guildId, userId, updated);
      await client.db.set(markerKey, {
        level: updated.level,
        oldXp: data.xp,
        newXp: updated.xp,
        progress,
        completedAt: Date.now(),
      });

      changed += 1;
      results.push(`<@${userId}> — Level ${updated.level}, ${Math.round(progress * 100)}% progress (${adjustedXp.toLocaleString('en-US')} / ${newRequirement.toLocaleString('en-US')} XP)`);
    }

    const embed = new EmbedBuilder()
      .setColor('#000000')
      .setTitle('Level XP Recalculation')
      .setDescription(results.join('\n') || 'No member records needed updating.')
      .addFields(
        { name: 'Updated', value: String(changed), inline: true },
        { name: 'Already processed', value: String(skipped), inline: true },
        { name: 'Total users', value: String(USERS.length), inline: true },
      )
      .setFooter({ text: 'Levels and progress percentages are preserved.' })
      .setTimestamp();

    return InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
  },
};
