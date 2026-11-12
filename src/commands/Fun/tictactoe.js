import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { createError, ErrorTypes, withErrorHandling } from '../../utils/errorHandler.js';

const GAME_TIMEOUT = 5 * 60 * 1000;
const MARKS = { X: '❌', O: '⭕' };

function buildBoard(game, ended = false) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
    const row = new ActionRowBuilder();
    for (let colIndex = 0; colIndex < 3; colIndex++) {
      const index = rowIndex * 3 + colIndex;
      const mark = game.board[index];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tictactoe:${game.id}:${index}`)
          .setLabel(mark ? MARKS[mark] : '・')
          .setStyle(mark === 'X' ? ButtonStyle.Danger : mark === 'O' ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(Boolean(mark) || ended)
      );
    }
    rows.push(row);
  }
  return rows;
}

function getWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(Boolean) ? 'draw' : null;
}

function buildEmbed(game, status, ended = false) {
  return new EmbedBuilder()
    .setColor(ended ? 0x2ecc71 : 0x3498db)
    .setTitle('⚔️ Barracks — Tic Tac Toe')
    .setDescription(
      `❌ **X:** <@${game.playerX}>\n⭕ **O:** <@${game.playerO}>\n\n` +
      `${status}`
    )
    .setFooter({ text: 'First player to get three in a row wins!' });
}

export default {
  prefixOnly: true,
  data: new SlashCommandBuilder()
    .setName('tictactoe')
    .setDescription('Challenge another Soldier to Tic Tac Toe')
    .addUserOption(option =>
      option.setName('opponent')
        .setDescription('The Soldier you want to challenge')
        .setRequired(true)
    ),

  execute: withErrorHandling(async (interaction) => {
    if (!interaction.inGuild()) {
      throw createError('Tic Tac Toe requires a server', ErrorTypes.VALIDATION, 'Play Tic Tac Toe inside a server.');
    }

    const opponent = interaction.options.getUser('opponent', true);
    const challenger = interaction.user;

    if (opponent.bot) {
      throw createError('Invalid opponent', ErrorTypes.VALIDATION, 'You cannot challenge a bot, Soldier.');
    }
    if (opponent.id === challenger.id) {
      throw createError('Invalid opponent', ErrorTypes.VALIDATION, 'You cannot challenge yourself.');
    }

    const game = {
      id: interaction.id,
      playerX: challenger.id,
      playerO: opponent.id,
      board: Array(9).fill(null),
      turn: 'X',
      finished: false,
      accepted: false,
    };

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('⚔️ Tic Tac Toe Challenge!')
        .setDescription(`<@${challenger.id}> challenged <@${opponent.id}> to a game!\n\n<@${opponent.id}>, press **Join Game** to accept.`)
        .setFooter({ text: 'The challenge expires in 5 minutes.' })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`tictactoe:${game.id}:join`)
          .setLabel('Join Game')
          .setEmoji('🎮')
          .setStyle(ButtonStyle.Success)
      )],
    });

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      time: GAME_TIMEOUT,
      filter: button => button.customId.startsWith(`tictactoe:${game.id}:`),
    });

    const updateBoard = async (button = null, status = null, ended = false) => {
      const currentStatus = status || `**${game.turn === 'X' ? '❌' : '⭕'} <@${game.turn === 'X' ? game.playerX : game.playerO}>'s turn**`;
      const payload = { embeds: [buildEmbed(game, currentStatus, ended)], components: buildBoard(game, ended) };
      if (button) await button.update(payload);
      else await message.edit(payload);
    };

    collector.on('collect', async button => {
      if (!game.accepted) {
        if (button.customId.endsWith(':join')) {
          if (button.user.id !== game.playerO) {
            return button.reply({ content: 'Only the challenged Soldier can join this game.', ephemeral: true });
          }
          game.accepted = true;
          return updateBoard(button, `**❌ <@${game.playerX}>'s turn**`);
        }
        return button.reply({ content: 'The game has not started yet. The opponent must join first.', ephemeral: true });
      }

      const expectedPlayer = game.turn === 'X' ? game.playerX : game.playerO;
      if (button.user.id !== expectedPlayer) {
        return button.reply({ content: 'It is not your turn, Soldier!', ephemeral: true });
      }

      const index = Number(button.customId.split(':').at(-1));
      if (!Number.isInteger(index) || index < 0 || index > 8 || game.board[index]) {
        return button.reply({ content: 'That square is not available.', ephemeral: true });
      }

      game.board[index] = game.turn;
      const result = getWinner(game.board);
      if (result) {
        game.finished = true;
        collector.stop('finished');
        if (result === 'draw') {
          return updateBoard(button, '🤝 **It is a draw! Good fight, Soldiers.**', true);
        }
        const winnerId = result === 'X' ? game.playerX : game.playerO;
        return updateBoard(button, `🏆 **<@${winnerId}> wins the match!**`, true);
      }

      game.turn = game.turn === 'X' ? 'O' : 'X';
      return updateBoard(button);
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'finished') return;
      game.finished = true;
      const status = game.accepted
        ? '⏰ **Game expired. The match has been cancelled.**'
        : '⏰ **Challenge expired. No game was started.**';
      await message.edit({
        embeds: [buildEmbed(game, status, true)],
        components: buildBoard(game, true),
      }).catch(() => {});
    });
  }, { command: 'tictactoe' }),
};
