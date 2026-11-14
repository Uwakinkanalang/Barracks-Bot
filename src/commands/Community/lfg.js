import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';

const DEFAULT_DURATION_HOURS = 2;
const MAX_PARTY_SIZE = 10;

export default {
  data: new SlashCommandBuilder()
    .setName('lfg')
    .setDescription('Find players for a game and bring them into your voice channel')
    .addStringOption(option =>
      option
        .setName('game')
        .setDescription('The game you are looking to play')
        .setMaxLength(50)
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('players')
        .setDescription('Total party size, including you')
        .setMinValue(2)
        .setMaxValue(MAX_PARTY_SIZE)
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('duration')
        .setDescription('How long the post stays open (hours)')
        .addChoices(
          { name: '1 hour', value: 1 },
          { name: '2 hours', value: 2 },
          { name: '3 hours', value: 3 },
          { name: '4 hours', value: 4 },
        )
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: 'Join a voice channel first. Players who click **Join** will be moved into your current voice channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const game = interaction.options.getString('game', true).trim();
    const partySize = interaction.options.getInteger('players', true);
    const durationHours = interaction.options.getInteger('duration') || DEFAULT_DURATION_HOURS;
    const expiresAt = Date.now() + durationHours * 60 * 60 * 1000;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🎮 Looking for Group: ${game}`)
      .setDescription(`<@${interaction.user.id}> is looking for ${partySize - 1} player${partySize - 1 === 1 ? '' : 's'}!`)
      .addFields({
        name: `Party (1/${partySize}) — ${partySize - 1} places left`,
        value: `1. <@${interaction.user.id}> 👑`,
      })
      .setFooter({ text: `Expires in ${durationHours} hour${durationHours === 1 ? '' : 's'} • Join to enter the host's voice channel` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lfg:join')
        .setLabel('Join')
        .setEmoji('🎮')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('lfg:leave')
        .setLabel('Leave')
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
    const message = await interaction.fetchReply();

    const record = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: message.id,
      hostId: interaction.user.id,
      voiceChannelId: voiceChannel.id,
      game,
      partySize,
      members: [interaction.user.id],
      createdAt: Date.now(),
      expiresAt,
    };

    await interaction.client.db.set(`guild:${interaction.guildId}:lfg:${message.id}`, record);

    const timer = setTimeout(async () => {
      try {
        const key = `guild:${record.guildId}:lfg:${record.messageId}`;
        const current = await interaction.client.db.get(key, null);
        if (!current) return;
        const channel = await interaction.client.channels.fetch(current.channelId).catch(() => null);
        const post = await channel?.messages.fetch(current.messageId).catch(() => null);
        if (post) {
          const expiredEmbed = EmbedBuilder.from(post.embeds[0])
            .setColor(0x747F8D)
            .setFooter({ text: 'This party has expired.' });
          await post.edit({ embeds: [expiredEmbed], components: [] }).catch(() => {});
        }
        await interaction.client.db.delete?.(key);
      } catch (error) {
        interaction.client.logger?.warn?.('Failed to expire LFG post:', error);
      }
    }, durationHours * 60 * 60 * 1000);
    timer.unref?.();
  },
};
