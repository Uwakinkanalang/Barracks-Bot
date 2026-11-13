import { Events, EmbedBuilder } from 'discord.js';
import { addMoney } from '../utils/economy.js';
import { logger } from '../utils/logger.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const DEFAULT_REWARD = 1000;
const GAME_MANAGER_ROLE_IDS = new Set(['1557784711072579706', '1557781661352071239']);
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

async function createSilhouette(pokemon) {
  const response = await fetch(pokemon.artwork);
  if (!response.ok) throw new Error(`Could not download Pokémon artwork (HTTP ${response.status})`);
  const image = await loadImage(Buffer.from(await response.arrayBuffer()));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#000000';
  context.fillRect(0, 0, image.width, image.height);
  return canvas.toBuffer('image/png');
}

function buildQuestionEmbed(pokemon, reward, seconds = 60) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("❓ WHO'S THAT POKÉMON?")
    .setDescription(
      'A mystery Pokémon has appeared, Soldier!\n\n' +
      `**Type your guess in chat.** The first correct answer wins **₱${reward.toLocaleString()} bCash**.\n` +
      `⏳ Time limit: **${seconds} seconds**`
    )
    .setImage('attachment://pokemon-silhouette.png')
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
      await addMoney(client, game.guildId, winnerId, game.reward, 'wallet');
      reward = game.reward;

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

function canManageGame(message) {
  return message.guild.ownerId === message.author.id
    || [...GAME_MANAGER_ROLE_IDS].some(roleId => message.member?.roles?.cache?.has(roleId));
}

async function startGame(message, client, reward = DEFAULT_REWARD) {
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
        reward,
        finished: false,
        timeout: null,
      };

      const silhouette = await createSilhouette(pokemon);
      activeGames.set(key, game);
      await loadingMessage.edit({
        content: null,
        embeds: [buildQuestionEmbed(pokemon, reward)],
        files: [{ attachment: silhouette, name: 'pokemon-silhouette.png' }],
      });
      game.timeout = setTimeout(() => {
        finishGame(client, key, game).catch(error => logger.error('Pokémon game timeout failed:', error));
      }, ROUND_TIME_MS);
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
      if (/^bpokemon\s+stop$/i.test(content)) {
        if (!canManageGame(message)) {
          await message.reply('⛔ Only members with the **Festivities**, **Management Team**, or **Server Owner** access can manage Pokémon rounds.');
          return;
        }
        const key = gameKey(message.guild.id, message.channel.id);
        const game = activeGames.get(key);
        if (!game) {
          await message.reply('There is no active Pokémon round in this channel.');
          return;
        }
        await finishGame(client, key, game);
        return;
      }

      const startMatch = content.match(/^bpokemon(?:\s+start)?(?:\s+(\d+))?$/i);
      if (startMatch) {
        if (!canManageGame(message)) {
          await message.reply('⛔ Only members with the **Festivities**, **Management Team**, or **Server Owner** access can start Pokémon rounds.');
          return;
        }
        const reward = startMatch[1] ? Number(startMatch[1]) : DEFAULT_REWARD;
        if (!Number.isSafeInteger(reward) || reward < 1 || reward > 1000000000) {
          await message.reply('Please enter a reward between **₱1 and ₱1,000,000,000**. Example: `bpokemon start 5000`.');
          return;
        }
        await startGame(message, client, reward);
        return;
      }

      await handleGuess(message, client);
    } catch (error) {
      logger.error('Pokémon game message handler failed:', error);
    }
  },
};
