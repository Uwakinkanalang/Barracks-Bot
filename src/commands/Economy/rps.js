import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';

const GAME_TIMEOUT = 2 * 60 * 1000;
const PICK_OPTIONS = {
  rock: { label: 'Rock', emoji: '✊' },
  paper: { label: 'Paper', emoji: '✋' },
  scissors: { label: 'Scissors', emoji: '✌️' },
};

function buildEmbed(game, phase = 'challenge', result = null) {
  const embed = new EmbedBuilder()
    .setColor(result?.winnerId ? 0x2ECC71 : result?.draw ? 0xF1C40F : 0x5865F2)
    .setTitle('✊ ROCK • PAPER • SCISSORS')
    .setFooter({ text: 'Barracks • Two-Player Challenge' });

  if (phase === 'challenge') {
    embed.setDescription(
      `<@\u200b${game.challengerId}> challenged <@\u200b${game.opponentId}> to Rock Paper Scissors!\n\n` +
      '**<@' + game.opponentId + '>**, accept the challenge to begin.'
    );
    embed.addFields(
      { name: 'Player 1', value: `<@${game.challengerId}>`, inline: true },
      { name: 'Player 2', value: `<@${game.opponentId}>`, inline: true },
    );
    return embed;
  }

  const challengerPicked = Boolean(game.choices[game.challengerId]);
  const opponentPicked = Boolean(game.choices[game.opponentId]);

  if (!result) {
    embed.setDescription(
      'Both players must choose one option below. Your choice stays **secret** until both players have locked in.'
    );
    embed.addFields(
      { name: 'Player 1', value: `<@${game.challengerId}>\n${challengerPicked ? '🔒 Choice locked in' : '⏳ Choosing...'}`, inline: true },
      { name: 'Player 2', value: `<@${game.opponentId}>\n${opponentPicked ? '🔒 Choice locked in' : '⏳ Choosing...'}`, inline: true },
    );
    return embed;
  }

  const challengerChoice = PICK_OPTIONS[game.choices[game.challengerId]];
  const opponentChoice = PICK_OPTIONS[game.choices[game.opponentId]];
  embed.setDescription('Both choices are revealed!');

  embed.addFields(
    {
      name: `Player 1 • ${game.challengerName}`,
      value: `${challengerChoice.emoji} **${challengerChoice.label}**`,
      inline: true,
    },
    {
      name: `Player 2 • ${game.opponentName}`,
      value: `${opponentChoice.emoji} **${opponentChoice.label}**`,
      inline: true,
    },
  );

  if (result.draw) {
    embed.addFields({ name: '🤝 Result', value: '**It is a draw!** Nobody scores a point.' });
  } else {
    embed.addFields({
      name: '🏆 Winner',
      value: `<@\u200b${result.winnerId}> wins this round and scores **1 point**!`,
    });
  }

  return embed;
}

function buildChallengeButtons(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:accept`)
      .setLabel('Accept Challenge')
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`rps:${gameId}:decline`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPickButtons(gameId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rps:${gameId}:rock`).setLabel('Rock').setEmoji('✊').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`rps:${gameId}:paper`).setLabel('Paper').setEmoji('✋').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`rps:${gameId}:scissors`).setLabel('Scissors').setEmoji('✌️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  );
}

function getWinner(game) {
  const first = game.choices[game.challengerId];
  const second = game.choices[game.opponentId];
  if (first === second) return { draw: true };

  const firstWins =
    (first === 'rock' && second === 'scissors') ||
    (first === 'paper' && second === 'rock') ||
    (first === 'scissors' && second === 'paper');

  return { winnerId: firstWins ? game.challengerId : game.opponentId };
}

export default {
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Challenge another member to Rock Paper Scissors')
    .addUserOption(option =>
      option
        .setName('opponent')
        .setDescription('The member you want to challenge')
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Play Rock Paper Scissors inside a server.', ephemeral: true });
      return;
    }

    const opponent = interaction.options.getUser('opponent', true);
    if (opponent.bot) {
      await interaction.reply({ content: 'You cannot challenge a bot. Choose another server member.', ephemeral: true });
      return;
    }
    if (opponent.id === interaction.user.id) {
      await interaction.reply({ content: 'You cannot challenge yourself. Choose another member.', ephemeral: true });
      return;
    }

    const opponentMember = await interaction.guild.members.fetch(opponent.id).catch(() => null);
    if (!opponentMember) {
      await interaction.reply({ content: 'That member is not in this server.', ephemeral: true });
      return;
    }

    const gameId = interaction.id;
    const game = {
      challengerId: interaction.user.id,
      opponentId: opponent.id,
      challengerName: interaction.member?.displayName || interaction.user.username,
      opponentName: opponentMember.displayName || opponent.username,
      choices: {},
      accepted: false,
      finished: false,
    };

    const message = await interaction.reply({
      embeds: [buildEmbed(game, 'challenge')],
      components: [buildChallengeButtons(gameId)],
      fetchReply: true,
    });

    const collector = message.createMessageComponentCollector({
      time: GAME_TIMEOUT,
      filter: button => button.customId.startsWith(`rps:${gameId}:`),
    });

    collector.on('collect', async button => {
      if (game.finished) {
        await button.reply({ content: 'This Rock Paper Scissors round has already ended.', ephemeral: true });
        return;
      }

      const action = button.customId.split(':').at(-1);

      if (action === 'accept' || action === 'decline') {
        if (button.user.id !== game.opponentId) {
          await button.reply({ content: 'Only the member who was challenged can accept or decline.', ephemeral: true });
          return;
        }

        await button.deferUpdate();
        if (action === 'decline') {
          game.finished = true;
          collector.stop('declined');
          await message.edit({
            embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('✊ ROCK • PAPER • SCISSORS').setDescription(`<@\u200b${game.opponentId}> declined the challenge from <@\u200b${game.challengerId}>.`).setFooter({ text: 'Barracks • Two-Player Challenge' })],
            components: [],
          });
          return;
        }

        if (game.accepted) return;
        game.accepted = true;
        await message.edit({
          embeds: [buildEmbed(game, 'picking')],
          components: [buildPickButtons(gameId)],
        });
        return;
      }

      if (!game.accepted) {
        await button.reply({ content: 'Wait for the challenge to be accepted first.', ephemeral: true });
        return;
      }

      if (![game.challengerId, game.opponentId].includes(button.user.id)) {
        await button.reply({ content: 'This round is only for the two challenged players.', ephemeral: true });
        return;
      }

      if (!Object.hasOwn(PICK_OPTIONS, action)) {
        await button.reply({ content: 'That choice is not valid. Please use one of the game buttons.', ephemeral: true });
        return;
      }

      if (game.choices[button.user.id]) {
        await button.reply({ content: 'You have already locked in your choice. Wait for the other player.', ephemeral: true });
        return;
      }

      game.choices[button.user.id] = action;
      await button.deferUpdate();

      const bothPicked = Boolean(game.choices[game.challengerId] && game.choices[game.opponentId]);
      if (!bothPicked) {
        await message.edit({ embeds: [buildEmbed(game, 'picking')] });
        return;
      }

      game.finished = true;
      const result = getWinner(game);
      collector.stop('finished');
      await message.edit({
        embeds: [buildEmbed(game, 'result', result)],
        components: [buildPickButtons(gameId, true)],
      });
    });

    collector.on('end', async (_collected, reason) => {
      if (game.finished || reason === 'finished' || reason === 'declined') return;
      game.finished = true;

      const description = !game.accepted
        ? 'The challenge expired because it was not accepted in time.'
        : 'The round expired before both players locked in their choices. No points were awarded.';

      await message.edit({
        embeds: [new EmbedBuilder()
          .setColor(0x95A5A6)
          .setTitle('✊ ROCK • PAPER • SCISSORS')
          .setDescription(description)
          .setFooter({ text: 'Barracks • Two-Player Challenge' })],
        components: [],
      }).catch(() => {});
    });
  },
};
