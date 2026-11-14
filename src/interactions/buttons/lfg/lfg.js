import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

function buildComponents(record, disabled = false) {
  const full = record.members.length >= record.partySize;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lfg:join')
        .setLabel('Join')
        .setEmoji('🎮')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled || full),
      new ButtonBuilder()
        .setCustomId('lfg:leave')
        .setLabel('Leave')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
}

function buildEmbed(record, expired = false) {
  const spotsLeft = Math.max(0, record.partySize - record.members.length);
  const roster = record.members.map((userId, index) =>
    `${index + 1}. <@${userId}>${userId === record.hostId ? ' 👑' : ''}`
  );

  return new EmbedBuilder()
    .setColor(expired ? 0x747F8D : spotsLeft === 0 ? 0x57F287 : 0x5865F2)
    .setTitle(`🎮 Looking for Group: ${record.game}`)
    .setDescription(`<@${record.hostId}> is looking for ${record.partySize - 1} player${record.partySize - 1 === 1 ? '' : 's'}!`)
    .addFields({
      name: `Party (${record.members.length}/${record.partySize}) — ${spotsLeft} places left`,
      value: roster.join('\n') || 'No players yet.',
    })
    .setFooter({
      text: expired
        ? 'This party has expired.'
        : spotsLeft === 0
          ? 'Party full • Barracks-Bot'
          : `Expires <t:${Math.floor(record.expiresAt / 1000)}:R> • Join to enter the host's voice channel`,
    })
    .setTimestamp(new Date(record.createdAt));
}

async function updatePost(interaction, record, expired = false) {
  await interaction.message.edit({
    embeds: [buildEmbed(record, expired)],
    components: buildComponents(record, expired),
  });
}

export default {
  name: 'lfg',

  async execute(interaction, client, args) {
    const action = args[0];
    const key = `guild:${interaction.guildId}:lfg:${interaction.message.id}`;
    const record = await client.db.get(key, null);

    if (!record) {
      return interaction.reply({
        content: 'This LFG post is no longer active.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (Date.now() >= record.expiresAt) {
      await updatePost(interaction, record, true);
      await client.db.delete?.(key);
      return interaction.reply({
        content: 'This LFG post has expired.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'join') {
      if (record.members.includes(interaction.user.id)) {
        return interaction.reply({
          content: 'You are already in this party.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (record.members.length >= record.partySize) {
        return interaction.reply({
          content: 'This party is already full.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const host = await interaction.guild.members.fetch(record.hostId).catch(() => null);
      if (!host?.voice?.channelId || host.voice.channelId !== record.voiceChannelId) {
        return interaction.reply({
          content: 'The party host is no longer in their original voice channel. Ask them to create a new LFG post.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const joiningMember = await interaction.guild.members.fetch(interaction.user.id);
      if (!joiningMember.voice.channelId) {
        return interaction.reply({
          content: 'Join any voice channel first. I can then move you into the host\'s voice channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const botMember = interaction.guild.members.me;
      const permissions = host.voice.channel.permissionsFor(botMember);
      if (!permissions?.has(PermissionFlagsBits.Connect) ||
          !permissions?.has(PermissionFlagsBits.MoveMembers)) {
        return interaction.reply({
          content: 'I need **Connect** and **Move Members** permissions in the host\'s voice channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await joiningMember.voice.setChannel(host.voice.channel, 'Joined a Barracks LFG party');
      } catch (error) {
        return interaction.editReply({
          content: 'I could not move you into the host\'s voice channel. Check my Move Members permission and the channel permissions.',
        });
      }

      record.members.push(interaction.user.id);
      await client.db.set(key, record);
      await updatePost(interaction, record);
      return interaction.editReply({
        content: `✅ You joined **${record.game}** and were moved into <#${record.voiceChannelId}>.`,
      });
    }

    if (action === 'leave') {
      if (!record.members.includes(interaction.user.id)) {
        return interaction.reply({
          content: 'You are not part of this party.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (interaction.user.id === record.hostId) {
        await client.db.delete?.(key);
        await interaction.update({
          embeds: [buildEmbed(record, true).setFooter({ text: 'The party host closed this LFG post.' })],
          components: [],
        });
        return;
      }

      record.members = record.members.filter(userId => userId !== interaction.user.id);
      await client.db.set(key, record);
      await updatePost(interaction, record);
      return interaction.reply({
        content: 'You left the party. You can leave the voice channel manually if you want.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: 'Unknown LFG action.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
