import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { createError, ErrorTypes, withErrorHandling } from '../../utils/errorHandler.js';
import { getEconomyData, removeMoney, addMoney } from '../../utils/economy.js';

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
      `💰 **Bet:** ₱${game.bet.toLocaleString()} each | **Prize:** ₱${(game.bet * 2).toLocaleString()}\n\n${status}`
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
    )
    .addIntegerOption(option =>
      option.setName('bet')
        .setDescription('Optional cash bet per player (0 for a free game)')
        .setMinValue(0)
        .setMaxValue(10000000)
        .setRequired(false)
    ),

  execute: withErrorHandling(async (interaction) => {
    if (!interaction.inGuild()) {
      throw createError('Tic Tac Toe requires a server', ErrorTypes.VALIDATION, 'Play Tic Tac Toe inside a server.');
    }

    const opponent = interaction.options.getUser('opponent', true);
    const challenger = interaction.user;
    const bet = interaction.options.getInteger('bet') ?? 0;
    const guildId = interaction.guildId;

    if (opponent.bot) {
      throw createError('Invalid opponent', ErrorTypes.VALIDATION, 'You cannot challenge a bot, Soldier.');
    }
    if (opponent.id === challenger.id) {
      throw createError('Invalid opponent', ErrorTypes.VALIDATION, 'You cannot challenge yourself.');
    }

    if (bet > 0) {
      const challengerData = await getEconomyData(interaction.client, guildId, challenger.id);
      if ((Number(challengerData.wallet) || 0) < bet) {
        throw createError('Insufficient cash', ErrorTypes.VALIDATION, `You need ₱${bet.toLocaleString()} in your wallet to create this match.`);
      }
      await removeMoney(interaction.client, guildId, challenger.id, bet, 'wallet');
    }

    const game = {
      id: interaction.id,
      playerX: challenger.id,
      playerO: opponent.id,
      bet,
      client: interaction.client,
      guildId,
      settled: false,
      board: Array(9).fill(null),
      turn: 'X',
      finished: false,
      accepted: false,
    };

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('⚔️ Tic Tac Toe Challenge!')
        .setDescription(`<@${challenger.id}> challenged <@${opponent.id}> to a game!\n\n${bet > 0 ? `Both players wager **₱${bet.toLocaleString()}**. Winner takes **₱${(bet * 2).toLocaleString()}**.` : 'This is a free match.'}\n\n<@${opponent.id}>, press **Join Game** to accept.`)
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

    const settle = async (result) => {
      if (game.settled || game.bet <= 0) { game.settled = true; return; }
      game.settled = true;
      if (result === 'draw' || result === 'cancel') {
        await addMoney(game.client, game.guildId, game.playerX, game.bet, 'wallet');
        if (game.accepted) await addMoney(game.client, game.guildId, game.playerO, game.bet, 'wallet');
      } else {
        const winnerId = result === 'X' ? game.playerX : game.playerO;
        await addMoney(game.client, game.guildId, winnerId, game.bet * 2, 'wallet');
      }
    };

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
          if (game.bet > 0) {
            const opponentData = await getEconomyData(game.client, game.guildId, game.playerO);
            if ((Number(opponentData.wallet) || 0) < game.bet) {
              return button.reply({ content: `You need **₱${game.bet.toLocaleString()}** in your wallet to accept this match.`, ephemeral: true });
            }
            await removeMoney(game.client, game.guildId, game.playerO, game.bet, 'wallet');
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
          await settle('draw');
          return updateBoard(button, `🤝 **It is a draw! Good fight, Soldiers.** ${game.bet > 0 ? `Both players received their ₱${game.bet.toLocaleString()} bet back.` : ''}`, true);
        }
        const winnerId = result === 'X' ? game.playerX : game.playerO;
        await settle(result);
        return updateBoard(button, `🏆 **<@${winnerId}> wins the match!** ${game.bet > 0 ? `They receive **₱${(game.bet * 2).toLocaleString()}**!` : ''}`, true);
      }

      game.turn = game.turn === 'X' ? 'O' : 'X';
      return updateBoard(button);
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'finished') return;
      game.finished = true;
      await settle('cancel');
      const status = game.accepted
        ? `⏰ **Game expired. The match has been cancelled.** ${game.bet > 0 ? 'Both players received their bets back.' : ''}`
        : `⏰ **Challenge expired. No game was started.** ${game.bet > 0 ? 'Your bet was returned.' : ''}`;
      await message.edit({
        embeds: [buildEmbed(game, status, true)],
        components: buildBoard(game, true),
      }).catch(() => {});
    });
  }, { command: 'tictactoe' }),
};
