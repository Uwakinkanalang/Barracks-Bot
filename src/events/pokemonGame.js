import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { addMoney } from '../utils/economy.js';
import { logger } from '../utils/logger.js';

const REWARD = 1000;
const ROUND_TIME_MS = 60_000;
const MAX_POKEMON_ID = 1025;
const activeGames = new Map();
const recentlyUsed = new Set();

function gameKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function normalizeAnswer(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function fetchRandomPokemon() {
  let pokemon;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const id = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
    if (recentlyUsed.has(id)) continue;

    const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
    if (!response.ok) throw new Error(`PokéAPI returned HTTP ${response.status}`);
    pokemon = await response.json();
    recentlyUsed.add(id);
    if (recentlyUsed.size > 40) recentlyUsed.delete(recentlyUsed.values().next().value);
    break;
  }

  if (!pokemon) throw new Error('Could not select a fresh Pokémon.');
  const artwork = pokemon.sprites?.other?.['official-artwork']?.front_default
    || pokemon.sprites?.front_default;
  if (!artwork) throw new Error(`No artwork available for Pokémon #${pokemon.id}`);

  return {
    id: pokemon.id,
    name: pokemon.name,
    artwork,
    types: (pokemon.types || []).map(entry => entry.type.name),
  };
}

function buildQuestionEmbed(pokemon, seconds = 60) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("❓ WHO'S THAT POKÉMON?")
    .setDescription(
      'A mystery Pokémon has appeared, Soldier!\n\n' +
      '**Type your guess in chat.** The first correct answer wins **₱1,000 bCash**.\n' +
      `⏳ Time limit: **${seconds} seconds**`
    )
    .setImage(pokemon.artwork)
    .setFooter({ text: 'Barracks-Bot • Pokémon Guessing Game' });
}

function buildResultEmbed(pokemon, winnerId, reward) {
  const embed = new EmbedBuilder()
    .setColor(winnerId ? 0x2ECC71 : 0xE74C3C)
    .setTitle(winnerId ? '🎉 YOU GOT IT!' : '⏰ TIME IS UP!')
    .setDescription(
      winnerId
        ? `🏆 <@${winnerId}> correctly guessed **${pokemon.name.toUpperCase()}**!\n\n💰 Reward: **₱${reward.toLocaleString()} bCash**`
        : `Nobody guessed it in time. The Pokémon was **${pokemon.name.toUpperCase()}**!`
    )
    .setImage(pokemon.artwork)
    .setFooter({ text: `Pokédex #${pokemon.id} • Barracks-Bot` });
  return embed;
}

async function finishGame(client, key, game, winnerId = null) {
  if (game.finished) return;
  game.finished = true;
  clearTimeout(game.timeout);
  activeGames.delete(key);

  let reward = 0;
  if (winnerId) {
    try {
      await addMoney(client, game.guildId, winnerId, REWARD, 'wallet');
      reward = REWARD;

      const winsKey = `guild:${game.guildId}:pokemon_game_wins`;
      const wins = await client.db.get(winsKey, {});
      const nextWins = wins && typeof wins === 'object' && !Array.isArray(wins) ? wins : {};
      nextWins[winnerId] = (Number(nextWins[winnerId]) || 0) + 1;
      await client.db.set(winsKey, nextWins);
    } catch (error) {
      logger.error('Failed to award Pokémon game reward:', error);
    }
  }

  await game.channel.send({ embeds: [buildResultEmbed(game.pokemon, winnerId, reward)] }).catch(error => {
    logger.warn('Could not send Pokémon game result:', error.message);
  });
}

async function startGame(message, client) {
  const key = gameKey(message.guild.id, message.channel.id);
  if (activeGames.has(key)) {
    await message.reply('There is already a Pokémon guessing round running in this channel. Guess the current Pokémon first!');
    return;
  }

  await message.channel.send('🔎 **Searching the Pokédex...**').then(async loadingMessage => {
    try {
      const pokemon = await fetchRandomPokemon();
      const game = {
        guildId: message.guild.id,
        channel: message.channel,
        pokemon,
        startedBy: message.author.id,
        finished: false,
        timeout: null,
      };

      game.timeout = setTimeout(() => {
        finishGame(client, key, game).catch(error => logger.error('Pokémon game timeout failed:', error));
      }, ROUND_TIME_MS);

      activeGames.set(key, game);
      await loadingMessage.edit({ content: null, embeds: [buildQuestionEmbed(pokemon)] });
    } catch (error) {
      logger.error('Could not start Pokémon guessing game:', error);
      await loadingMessage.edit('❌ I could not load a Pokémon right now. Please try again in a moment.').catch(() => {});
    }
  });
}

async function handleGuess(message, client) {
  const key = gameKey(message.guild.id, message.channel.id);
  const game = activeGames.get(key);
  if (!game || game.finished) return false;

  if (normalizeAnswer(message.content) === normalizeAnswer(game.pokemon.name)) {
    await finishGame(client, key, game, message.author.id);
  }
  return true;
}

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (!message.guild || message.author.bot) return;

      const content = message.content.trim();
      if (/^bpokemon(?:\s+start)?$/i.test(content)) {
        await startGame(message, client);
        return;
      }

      if (/^bpokemon\s+stop$/i.test(content)) {
        const key = gameKey(message.guild.id, message.channel.id);
        const game = activeGames.get(key);
        if (!game) {
          await message.reply('There is no active Pokémon round in this channel.');
          return;
        }
        if (game.startedBy !== message.author.id && !message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
          await message.reply('Only the Soldier who started the round or a member with **Manage Server** permission can stop it.');
          return;
        }
        await finishGame(client, key, game);
        return;
      }

      await handleGuess(message, client);
    } catch (error) {
      logger.error('Pokémon game message handler failed:', error);
    }
  },
};
