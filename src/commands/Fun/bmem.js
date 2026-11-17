import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomInt, randomUUID } from 'node:crypto';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';

const activeGames = new Set();
const ANIMALS = ['🐼', '🦊', '🐸', '🐯', '🐵', '🐰', '🐧', '🦁', '🐨', '🐻', '🐮', '🦄'];

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function makeBoard(cards, revealed, matched) {
  return cards.map((animal, index) => {
    if (matched.has(index) || revealed.includes(index)) return animal;
    return '🟩';
  });
}

function renderBoard(cards, revealed, matched, tries, bet, status) {
  const visible = makeBoard(cards, revealed, matched);
  const lines = [
    '**🪖 BARRACKS MEMORY MATCH**',
    'Find all **4 matching pairs**. Only you can play this round.',
    '',
    `💰 Entry: **₱${bet.toLocaleString()} bCash**   •   🔁 Tries: **${tries}**`,
    '',
    `╭───────┬───────┬───────┬───────╮`,
    ...[0, 1].map(row => `│ ${visible.slice(row * 4, row * 4 + 4).join(' │ ')} │`),
    `╰───────┴───────┴───────┴───────╯`,
    '',
    status,
  ];
  return lines.join('\\n');
}

function makeRows(gameId, disabled = false) {
  return [0, 1].map(row => new ActionRowBuilder().addComponents(
    ...Array.from({ length: 4 }, (_, col) => {
      const number = row * 4 + col;
      return new ButtonBuilder()
        .setCustomId(`bmem:${gameId}:${number}`)
        .setLabel(String(number + 1))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
    }),
  ));
}

export default {
  prefixOnly: true,
  data: new SlashCommandBuilder()
    .setName('bmem')
    .setDescription('Play Barracks Memory Match with four animal pairs')
    .addIntegerOption(option => option
      .setName('amount')
      .setDescription('Barracks Cash entry amount')
      .setMinValue(1)
      .setMaxValue(1_000_000_000)
      .setRequired(true)),

  async execute(interaction, config, client) {
    if (!interaction.inGuild()) return interaction.reply({ content: 'Play this game inside a server.' });

    const bet = interaction.options.getInteger('amount', true);
    const lockKey = `${interaction.guildId}:${interaction.user.id}`;
    if (activeGames.has(lockKey)) {
      return interaction.reply({ content: '⏳ You already have a Memory game running. Finish that round first.' });
    }

    activeGames.add(lockKey);
    let charged = false;
    try {
      const account = await getEconomyData(client, interaction.guildId, interaction.user.id);
      const wallet = Math.max(0, Number(account.wallet) || 0);
      if (wallet < bet) {
        return interaction.reply({ content: `❌ You only have **₱${wallet.toLocaleString()} bCash** in your wallet.` });
      }

      account.wallet = wallet - bet;
      await setEconomyData(client, interaction.guildId, interaction.user.id, account);
      charged = true;

      const animals = shuffle(ANIMALS).slice(0, 4);
      const cards = shuffle([...animals, ...animals]);
      const revealed = [];
      const matched = new Set();
      let tries = 0;
      let pendingMismatch = false;
      let finished = false;
      const gameId = randomUUID().slice(0, 8);
      const message = await interaction.channel.send({
        content: renderBoard(cards, revealed, matched, tries, bet, '👇 Choose a numbered card below.'),
        components: makeRows(gameId),
      });

      const collector = message.createMessageComponentCollector({
        time: 180_000,
        filter: component => component.customId.startsWith(`bmem:${gameId}:`),
      });

      collector.on('collect', async component => {
        if (component.user.id !== interaction.user.id) {
          await component.reply({ content: 'This is not your game, recruit!', ephemeral: true });
          return;
        }

        const index = Number(component.customId.split(':').at(-1));
        if (!Number.isInteger(index) || index < 0 || index > 7 || matched.has(index) || revealed.includes(index)) {
          await component.deferUpdate();
          return;
        }

        if (pendingMismatch) {
          revealed.length = 0;
          pendingMismatch = false;
        }

        revealed.push(index);
        if (revealed.length === 2) {
          tries++;
          if (cards[revealed[0]] === cards[revealed[1]]) {
            matched.add(revealed[0]);
            matched.add(revealed[1]);
            revealed.length = 0;
          } else {
            pendingMismatch = true;
          }
        }

        if (matched.size === 8) {
          finished = true;
          collector.stop('completed');
          const latest = await getEconomyData(client, interaction.guildId, interaction.user.id);
          const prize = bet * 2;
          latest.wallet = Math.max(0, Number(latest.wallet) || 0) + prize;
          await setEconomyData(client, interaction.guildId, interaction.user.id, latest);
          await component.update({
            content: renderBoard(cards, cards.map((_, i) => i), matched, tries, bet,
              `🏆 **Mission complete!** You found all 4 pairs in **${tries} tries** and won **₱${prize.toLocaleString()} bCash**!`),
            components: makeRows(gameId, true),
          });
          return;
        }

        const status = pendingMismatch
          ? '❌ No match! Choose another card to turn both cards back over.'
          : matched.size === 8 ? '🏆 All pairs found!' : '👇 Choose your next card.';
        await component.update({
          content: renderBoard(cards, revealed, matched, tries, bet, status),
          components: makeRows(gameId, false),
        });
      });

      collector.on('end', async (_, reason) => {
        activeGames.delete(lockKey);
        if (reason === 'completed') return;
        if (!finished) {
          if (charged) {
            const latest = await getEconomyData(client, interaction.guildId, interaction.user.id);
            latest.wallet = Math.max(0, Number(latest.wallet) || 0) + bet;
            await setEconomyData(client, interaction.guildId, interaction.user.id, latest);
          }
          await message.edit({
            content: renderBoard(cards, revealed, matched, tries, bet,
              '⌛ Game expired. Your entry fee has been refunded. Start again with `bmem :amount`.'),
            components: makeRows(gameId, true),
          }).catch(() => {});
        }
      });
    } finally {
      // The game lock is released by the collector's end event below.
      // Keep the lock while the interactive game is active.
      if (!charged) activeGames.delete(lockKey);
    }
  },
};
