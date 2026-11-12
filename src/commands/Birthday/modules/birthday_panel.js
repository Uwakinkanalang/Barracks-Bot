import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';

export default {
  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      return InteractionHelper.safeReply(interaction, {
        content: 'You need **Manage Server** permission to post the birthday registration panel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🎂 Birthdays')
      .setDescription(
        "Let us celebrate you! Click the button below to register your birthday and we'll shout it out on your special day.\n\nYour birthday is used only for server celebrations. Never enter passwords or other sensitive information.\n\nYou can update or remove it at any time."
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('birthday_set')
        .setLabel('🎂 Set my birthday')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('birthday_remove')
        .setLabel('Remove my birthday')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    return InteractionHelper.safeReply(interaction, {
      content: `Birthday registration panel posted in ${interaction.channel}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
