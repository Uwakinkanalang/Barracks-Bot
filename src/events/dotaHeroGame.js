import { Events, EmbedBuilder } from 'discord.js';
import { addMoney } from '../utils/economy.js';
import { logger } from '../utils/logger.js';

const DEFAULT_REWARD = 1000;
const ROUND_TIME_MS = 60_000;
const GAME_MANAGER_ROLE_IDS = new Set(['1557784711072579706', '1557781661352071239']);
const HERO_API = 'https://api.opendota.com/api/heroStats';
const activeGames = new Map();
const recentlyUsed = new Set();
let heroCache = { heroes: [], fetchedAt: 0 };

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

async function fetchHeroes() {
  if (heroCache.heroes.length && Date.now() - heroCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return heroCache.heroes;
  }

  const response = await fetch(HERO_API);
  if (!response.ok) throw new Error(`OpenDota returned HTTP ${response.status}`);
  const data = await response.json();

  const heroes = data
    .filter(hero => hero.localized_name && hero.img)
    .map(hero => ({
      id: hero.id,
      name: hero.localized_name,
      image: hero.img.startsWith('http') ? hero.img : `https://cdn.cloudflare.steamstatic.com${hero.img}`,
      roles: Array.isArray(hero.roles) ? hero.roles : [],
      primaryAttr: hero.primary_attr || 'unknown',
    }));

  if (!heroes.length) throw new Error('OpenDota returned no heroes.');
  heroCache = { heroes, fetchedAt: Date.now() };
  return heroes;
}

async function fetchRandomHero() {
  const heroes = await fetchHeroes();
  const available = heroes.filter(hero => !recentlyUsed.has(hero.id));
  const pool = available.length ? available : heroes;
  const hero = pool[Math.floor(Math.random() * pool.length)];

  recentlyUsed.add(hero.id);
  if (recentlyUsed.size > Math.max(20, Math.floor(heroes.length / 2))) {
    recentlyUsed.delete(recentlyUsed.values().next().value);
  }

  return hero;
}

function buildQuestionEmbed(hero, reward) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('❓ GUESS THE DOTA 2 HERO!')
    .setDescription(
      'A mysterious hero has entered the battlefield, Soldier!\n\n' +
      '**Who is this Dota 2 hero?** Type your answer in chat. The first correct guess wins **₱' +
      reward.toLocaleString() + ' bCash**.\n\n' +
      '⏳ Time limit: **60 seconds**'
    )
    .setImage(hero.image)
    .addFields({ name: 'Hint', value: `Primary attribute: **${hero.primaryAttr.toUpperCase()}**\nRoles: **${hero.roles.join(', ') || 'Unknown'}**` })
    .setFooter({ text: 'Barracks-Bot • Dota 2 Hero Guessing Game' });
}

function buildResultEmbed(hero, winnerId, reward) {
  return new EmbedBuilder()
    .setColor(winnerId ? 0x2ECC71 : 0xE74C3C)
    .setTitle(winnerId ? '🏆 HERO IDENTIFIED!' : '⏰ TIME IS UP!')
    .setDescription(
      winnerId
        ? `<@${winnerId}> correctly identified **${hero.name}**!\n\n💰 Reward: **₱${reward.toLocaleString()} bCash**`
        : `Nobody identified the hero in time. The hero was **${hero.name}**!`
    )
    .setImage(hero.image)
    .setFooter({ text: `Dota 2 Hero #${hero.id} • Barracks-Bot` });
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

      const winsKey = `guild:${game.guildId}:dota_hero_game_wins`;
      const wins = await client.db.get(winsKey, {});
      const nextWins = wins && typeof wins === 'object' && !Array.isArray(wins) ? wins : {};
      nextWins[winnerId] = (Number(nextWins[winnerId]) || 0) + 1;
      await client.db.set(winsKey, nextWins);
    } catch (error) {
      logger.error('Failed to award Dota 2 hero game reward:', error);
    }
  }

  await game.channel.send({ embeds: [buildResultEmbed(game.hero, winnerId, reward)] }).catch(error => {
    logger.warn('Could not send Dota 2 hero game result:', error.message);
  });
}

function canManageGame(message) {
  return message.guild.ownerId === message.author.id
    || [...GAME_MANAGER_ROLE_IDS].some(roleId => message.member?.roles?.cache?.has(roleId));
}

async function startGame(message, client, reward = DEFAULT_REWARD) {
  const key = gameKey(message.guild.id, message.channel.id);
  if (activeGames.has(key)) {
    await message.reply('There is already a Dota 2 hero round running in this channel. Identify the current hero first!');
    return;
  }

  const loadingMessage = await message.channel.send('🔎 **Scanning the battlefield for a mystery hero...**');
  try {
    const hero = await fetchRandomHero();
    const game = {
      guildId: message.guild.id,
      channel: message.channel,
      hero,
      reward,
      finished: false,
      timeout: null,
    };

    activeGames.set(key, game);
    await loadingMessage.edit({ content: null, embeds: [buildQuestionEmbed(hero, reward)] });
    game.timeout = setTimeout(() => {
      finishGame(client, key, game).catch(error => logger.error('Dota 2 hero game timeout failed:', error));
    }, ROUND_TIME_MS);
  } catch (error) {
    logger.error('Could not start Dota 2 hero guessing game:', error);
    await loadingMessage.edit('❌ I could not load a Dota 2 hero right now. Please try again in a moment.').catch(() => {});
  }
}

async function handleGuess(message, client) {
  const key = gameKey(message.guild.id, message.channel.id);
  const game = activeGames.get(key);
  if (!game || game.finished) return false;

  if (normalizeAnswer(message.content) === normalizeAnswer(game.hero.name)) {
    await message.react('✅').catch(() => {});
    await finishGame(client, key, game, message.author.id);
  } else if (message.content.trim()) {
    await message.react('❌').catch(() => {});
  }
  return true;
}

async function showLeaderboard(message, client) {
  const wins = await client.db.get(`guild:${message.guild.id}:dota_hero_game_wins`, {});
  const entries = Object.entries(wins && typeof wins === 'object' ? wins : {})
    .map(([userId, count]) => ({ userId, count: Number(count) || 0 }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const description = entries.length
    ? entries.map((entry, index) => `**${index + 1}.** <@${entry.userId}> — **${entry.count}** win${entry.count === 1 ? '' : 's'}`).join('\n')
    : 'No heroes have been identified yet. Be the first to join the leaderboard!';

  await message.channel.send({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('🏅 DOTA 2 HERO LEADERBOARD').setDescription(description).setFooter({ text: 'Barracks-Bot • Top 10 soldiers' })],
  });
}

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (!message.guild || message.author.bot) return;

      const content = message.content.trim();
      if (/^bhero\s+leaderboard$/i.test(content)) {
        await showLeaderboard(message, client);
        return;
      }

      if (/^bhero\s+stop$/i.test(content)) {
        if (!canManageGame(message)) {
          await message.reply('⛔ Only members with the **Festivities**, **Management Team**, or **Server Owner** access can manage Dota 2 hero rounds.');
          return;
        }
        const key = gameKey(message.guild.id, message.channel.id);
        const game = activeGames.get(key);
        if (!game) {
          await message.reply('There is no active Dota 2 hero round in this channel.');
          return;
        }
        await finishGame(client, key, game);
        return;
      }

      const startMatch = content.match(/^bhero(?:\s+start)?(?:\s+(\d+))?$/i);
      if (startMatch) {
        if (!canManageGame(message)) {
          await message.reply('⛔ Only members with the **Festivities**, **Management Team**, or **Server Owner** access can start Dota 2 hero rounds.');
          return;
        }
        const reward = startMatch[1] ? Number(startMatch[1]) : DEFAULT_REWARD;
        if (!Number.isSafeInteger(reward) || reward < 1 || reward > 1000000000) {
          await message.reply('Please enter a reward between **₱1 and ₱1,000,000,000**. Example: `bhero start 5000`.');
          return;
        }
        await startGame(message, client, reward);
        return;
      }

      await handleGuess(message, client);
    } catch (error) {
      logger.error('Dota 2 hero game message handler failed:', error);
    }
  },
};
