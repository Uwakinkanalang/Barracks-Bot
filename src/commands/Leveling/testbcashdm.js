import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { checkUserPermissions } from '../../utils/permissionGuard.js';
import { createEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const SAMPLE_REWARDS = {
  private: { rank: 'Private', amount: 500000 },
  corporal: { rank: 'Corporal', amount: 1000000 },
  sergeant: { rank: 'Sergeant', amount: 1500000 },
  captain: { rank: 'Captain', amount: 2000000 },
  lieutenant: { rank: 'Lieutenant', amount: 2500000 },
  major: { rank: 'Major', amount: 3000000 },
  colonel: { rank: 'Colonel', amount: 5000000 },
  general: { rank: 'General', amount: 10000000 },
};

export default {
  data: new SlashCommandBuilder()
    .setName('testbcashdm')
    .setDescription('Send yourself a sample Barracks cash rank-reward DM')
    .addStringOption((option) =>
      option
        .setName('rank')
        .setDescription('Choose which rank reward to preview')
        .setRequired(false)
        .addChoices(
          { name: 'Private', value: 'private' },
          { name: 'Corporal', value: 'corporal' },
          { name: 'Sergeant', value: 'sergeant' },
          { name: 'Captain', value: 'captain' },
          { name: 'Lieutenant', value: 'lieutenant' },
          { name: 'Major', value: 'major' },
          { name: 'Colonel', value: 'colonel' },
          { name: 'General', value: 'general' },
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  category: 'Leveling',

  async execute(interaction) {
    await InteractionHelper.safeDefer(interaction, { ephemeral: true });

    const hasPermission = await checkUserPermissions(
      interaction,
      PermissionFlagsBits.ManageGuild,
      'You need Manage Server permission to use this command.'
    );
    if (!hasPermission) return;

    const selectedRank = interaction.options.getString('rank') || 'private';
    const reward = SAMPLE_REWARDS[selectedRank];
    const formattedAmount = reward.amount.toLocaleString('en-US');

    const sampleMessage = [
      `• 🎉 You received **₱${formattedAmount}** in Barracks cash for earning **🔫 ${reward.rank}**!`,
      `• 💰 Your new Bcash balance is **₱${formattedAmount}**.`,
    ].join('\n');

    try {
      await interaction.user.send({ content: sampleMessage });
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          createEmbed({
            title: 'Sample Bcash DM Sent',
            description: `I sent the sample **${reward.rank}** reward DM to your private messages. No Bcash was added and no rank or XP was changed.`,
            color: 'success',
          }),
        ],
      });
    } catch (error) {
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          createEmbed({
            title: 'Could Not Send DM',
            description: 'Please enable direct messages from this server, then run the command again.',
            color: 'error',
          }),
        ],
      });
    }
  },
};
