import crypto from 'node:crypto';
import cron from 'node-cron';
import { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getWelcomeConfig, saveWelcomeConfig, getFromDb, setInDb } from '../utils/database.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { getEconomyPrefix } from '../utils/database.js';
import { getEconomyData, setEconomyData, getMaxBankCapacity } from '../utils/economy.js';
import { getLevelingConfig, saveLevelingConfig } from '../services/leveling/leveling.js';
import { getCountingGameConfig, saveCountingGameConfig } from '../services/countingGameService.js';
import { getCommandAccessSnapshot, disableCommand, enableCommand, isProtectedCommand, isCommandEnabledInConfig } from '../services/commandAccessService.js';
import { getAllBirthdays } from '../services/birthdayService.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const DASHBOARD_STAFF_KEY = 'dashboard:staff_accounts';
const DASHBOARD_GUILD_ID = process.env.BARRACKS_GUILD_ID || '1137695060096471160';
const loginAttempts = new Map();
const BOOSTER_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const boosterMemberSnapshots = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);

}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createAccessToken(secret, identity = { username: 'owner', role: 'owner' }) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    scope: 'barracks-dashboard',
    userId: identity.userId || 'owner',
    username: identity.username || 'owner',
    role: identity.role || 'owner'
  })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function validAccessToken(req, secret) {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice(7);
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.scope === 'barracks-dashboard'
      && Number.isFinite(data.exp)
      && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function dashboardTokenData(req, secret) {
  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7), [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.scope !== 'barracks-dashboard' || !Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now()/1000)) return null;
    return data;
  } catch { return null; }
}
function hashDashboardPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyDashboardPassword(password, account) {
  try {
    const hash = crypto.scryptSync(password, account.salt, 64);
    return safeEqual(hash.toString('hex'), account.hash);
  } catch { return false; }
}
async function getDashboardStaff() {
  const raw = await getFromDb(DASHBOARD_STAFF_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

function allowLoginAttempt(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter(time => time > now - 15 * 60 * 1000);
  if (recent.length >= 8) {
    loginAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(ip, recent);
  return true;
}

export function registerDashboardRoutes(app, bot) {
  app.use('/api/dashboard', async (req, res, next) => {
    if (req.path === '/login' || req.path === '/guest') return next();
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    const identity = secret && dashboardTokenData(req, secret);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });
    if (identity.role === 'owner') return next();
    if (identity.role === 'guest') {
      if (req.method === 'GET' && ['/overview','/tournaments'].includes(req.path)) return next();
      return res.status(403).json({ error: 'Guest access is limited to public overview and tournament information.' });
    }
    const staff = await getDashboardStaff();
    const account = staff.find(item => item.id === identity.userId && item.active !== false);
    if (!account || account.role !== identity.role) return res.status(401).json({ error: 'Staff access has been revoked. Please sign in again.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(403).json({ error: 'This staff account is read-only. Ask the dashboard owner for elevated access.' });
    return next();
  });
  app.post('/api/dashboard/guest', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret) return res.status(503).json({ error: 'Dashboard guest access is not configured.' });
    if (!allowLoginAttempt(req.ip)) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    const identity = { userId: 'guest', username: 'guest', role: 'guest' };
    return res.json({ token: createAccessToken(secret, identity), expiresIn: SESSION_TTL_SECONDS, user: { username: identity.username, role: identity.role } });
  });

  app.post('/api/dashboard/login', async (req, res) => {
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!expectedPassword || !secret) return res.status(503).json({ error: 'Dashboard login is not configured.' });
    if (!allowLoginAttempt(req.ip)) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    const username = String(req.body?.username || 'owner').trim().toLowerCase();
    const password = String(req.body?.password || '');
    let identity = null;
    if (username === 'owner' && safeEqual(password, expectedPassword)) {
      identity = { userId: 'owner', username: 'owner', role: 'owner' };
    } else {
      const staff = await getDashboardStaff();
      const account = staff.find(item => item.username === username && item.active !== false);
      if (account && verifyDashboardPassword(password, account)) {
        identity = { userId: account.id, username: account.username, role: account.role || 'staff' };
      }
    }
    if (!identity) return res.status(401).json({ error: 'Incorrect username or password.' });
    return res.json({ token: createAccessToken(secret, identity), expiresIn: SESSION_TTL_SECONDS, user: { username: identity.username, role: identity.role } });
  });

  app.get('/api/dashboard/staff', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET, identity = secret && dashboardTokenData(req, secret);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });
    if (identity.role !== 'owner') return res.status(403).json({ error: 'Only the dashboard owner can manage staff accounts.' });
    const staff = await getDashboardStaff();
    return res.json({ staff: staff.map(({id,username,role,active,createdAt}) => ({id,username,role,active:active!==false,createdAt})) });
  });

  app.post('/api/dashboard/staff', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET, identity = secret && dashboardTokenData(req, secret);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });
    if (identity.role !== 'owner') return res.status(403).json({ error: 'Only the dashboard owner can create staff accounts.' });
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[a-z0-9._-]{3,24}$/.test(username) || username === 'owner') return res.status(400).json({ error: 'Username must be 3–24 letters, numbers, dots, underscores, or hyphens.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    const staff = await getDashboardStaff();
    if (staff.some(item => item.username === username)) return res.status(409).json({ error: 'That username already exists.' });
    const credential = hashDashboardPassword(password);
    const account = { id: crypto.randomUUID(), username, role: 'staff', active: true, createdAt: new Date().toISOString(), ...credential };
    staff.push(account);
    if (!await setInDb(DASHBOARD_STAFF_KEY, staff)) return res.status(500).json({ error: 'Could not save staff account.' });
    return res.status(201).json({ ok: true, staff: {id:account.id,username:account.username,role:account.role,active:true,createdAt:account.createdAt} });
  });

  app.delete('/api/dashboard/staff/:id', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET, identity = secret && dashboardTokenData(req, secret);
    if (!identity) return res.status(401).json({ error: 'Unauthorized' });
    if (identity.role !== 'owner') return res.status(403).json({ error: 'Only the dashboard owner can remove staff accounts.' });
    const staff = await getDashboardStaff(), next = staff.filter(item => item.id !== req.params.id);
    if (next.length === staff.length) return res.status(404).json({ error: 'Staff account not found.' });
    if (!await setInDb(DASHBOARD_STAFF_KEY, next)) return res.status(500).json({ error: 'Could not remove staff account.' });
    return res.json({ ok: true });
  });

  app.get('/api/dashboard/commands', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const config = await getGuildConfig(bot, guild.id);
      const snapshot = getCommandAccessSnapshot(bot, config, 'slash');
      return res.json({
        totalCommands: snapshot.totalCommands,
        enabledTotal: snapshot.enabledTotal,
        categories: snapshot.categories.map(category => ({
          key: category.key, name: category.displayName, icon: category.icon,
          enabledCount: category.enabledCount, totalCount: category.totalCount,
          commands: category.commands.map(command => ({
            name: command.name, description: command.description,
            enabled: category.enabledCommands.includes(command.name),
            protected: command.protected
          }))
        }))
      });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not load slash commands.' }); }
  });

  app.get('/api/dashboard/prefix-commands', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const [{ supportsPrefixExecution }, { getPrefixRestriction }, { resolveSubcommandAlias, commandAliases }] = await Promise.all([
        import('../utils/messageAdapter.js'),
        import('../config/commands/prefixRestrictions.js'),
        import('../config/commands/commandAliases.js'),
      ]);
      const config = await getGuildConfig(bot, guild.id);
      const snapshot = getCommandAccessSnapshot(bot, config, 'prefix');
      const barePrefixAliases = {
        bcount: 'bcount', bgive: 'bgive', bmines: 'bmine', bmine: 'bmine',
        bcash: 'balance', bbj: 'bblackjack', bblackjack: 'bblackjack', bslot: 'bslot', bmem: 'memory',
        bhl: 'bhl', bdaily: 'daily', bwork: 'work', bshop: 'shop',
        btalpak: 'btalpak', bdeposit: 'deposit', bdep: 'deposit',
        bwithdraw: 'withdraw', bwith: 'withdraw', bttt: 'tictactoe',
        btictactoe: 'tictactoe', bcf: 'coinflip', broulette: 'broulette',
        brps: 'rps', 'b!math': 'math',
      };
      const aliasesByCommand = new Map();
      for (const [alias, target] of Object.entries({ ...commandAliases, ...barePrefixAliases })) {
        if (!aliasesByCommand.has(target)) aliasesByCommand.set(target, []);
        aliasesByCommand.get(target).push(alias);
      }
      const categories = snapshot.categories.map(category => {
        const eligible = category.commands.filter(entry => {
          const command = bot.commands.get(entry.name.split(' ')[0]);
          if (!command || !supportsPrefixExecution(command)) return false;
          const args = entry.name.split(' ').slice(1);
          return !getPrefixRestriction(command, args, resolveSubcommandAlias).blocked;
        });
        const commands = eligible.filter(entry => !entry.name.includes(' ')).map(entry => {
          const baseName = entry.name;
          const displayName = baseName === 'bblackjack' ? 'bbj' : (baseName === 'math' ? 'b!math' : baseName);
          const aliases = [...new Set(aliasesByCommand.get(baseName) || [])]
            .filter(alias => alias !== baseName && alias !== displayName && !bot.commands.has(alias) && !(baseName === 'bblackjack' && alias === 'bbj')).sort();
          const subcommands = eligible.filter(candidate => candidate.name.startsWith(baseName + ' '))
            .map(candidate => candidate.name);
          return { ...entry, name: displayName, toggleName: baseName, aliases, subcommands };
        });
        return { key: category.key, name: category.displayName, icon: category.icon,
          enabledCount: commands.filter(command => isCommandEnabledInConfig(config, command.name, category.folder, 'prefix')).length,
          totalCount: commands.length,
          commands: commands.map(command => ({ name: command.name, toggleName: command.toggleName || command.name, description: command.description,
            aliases: command.aliases, subcommands: command.subcommands,
            enabled: isCommandEnabledInConfig(config, command.toggleName || command.name, category.folder, 'prefix'), protected: command.protected })) };
      }).filter(category => category.commands.length);
      return res.json({ categories, totalCommands: categories.reduce((sum, category) => sum + category.totalCount, 0),
        enabledTotal: categories.reduce((sum, category) => sum + category.enabledCount, 0) });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not load prefix commands.' }); }
  });

  app.post('/api/dashboard/prefix-commands/toggle', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const name = String(req.body?.name || '').trim().toLowerCase(), enabled = req.body?.enabled;
    if (!name || typeof enabled !== 'boolean') return res.status(400).json({ error: 'Choose a command and ON or OFF.' });
    if (isProtectedCommand(name.split(' ')[0])) return res.status(403).json({ error: 'This protected command must remain enabled.' });
    try {
      const result = enabled ? await enableCommand(bot, guild.id, name, {}, 'prefix') : await disableCommand(bot, guild.id, name, {}, 'prefix');
      return res.json({ ok: true, ...result });
    } catch (error) { return res.status(400).json({ error: error?.message || 'Could not update prefix command.' }); }
  });

  app.post('/api/dashboard/commands/toggle', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const name = String(req.body?.name || '').trim().toLowerCase();
    const enabled = req.body?.enabled;
    if (!name || typeof enabled !== 'boolean') return res.status(400).json({ error: 'Choose a command and ON or OFF.' });
    if (isProtectedCommand(name.split(' ')[0])) return res.status(403).json({ error: 'This protected command must remain enabled.' });
    try {
      const result = enabled
        ? await enableCommand(bot, guild.id, name)
        : await disableCommand(bot, guild.id, name);
      return res.json({ ok: true, ...result });
    } catch (error) { return res.status(400).json({ error: error?.message || 'Could not update command.' }); }
  });

  app.get('/api/dashboard/settings', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const guildConfig = await getGuildConfig(bot, guild.id);
      const dbStatus = bot.db?.getStatus?.() || { connectionType: 'unknown', isDegraded: true };
      const roles = guild.roles.cache
        .filter(role => role.id !== guild.id && !role.managed)
        .sort((a, b) => b.position - a.position)
        .map(role => ({ id: role.id, name: role.name, color: role.hexColor, position: role.position }));
      return res.json({
        guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount, channelCount: guild.channels.cache.size, roleCount: guild.roles.cache.size },
        bot: { name: bot.user?.username || 'Barracks-Bot', id: bot.user?.id || null, online: bot.isReady(), uptimeSeconds: Math.floor(process.uptime()), commandCount: bot.commands?.size ?? 0 },
        database: { type: dbStatus.connectionType || 'unknown', degraded: Boolean(dbStatus.isDegraded) },
        prefix: typeof guildConfig.prefix === 'string' ? guildConfig.prefix : '!',
        language: typeof guildConfig.dashboardLanguage === 'string' ? guildConfig.dashboardLanguage : 'en',
        timezone: typeof guildConfig.timezone === 'string' ? guildConfig.timezone : 'Asia/Manila',
        managerRoleIds: Array.isArray(guildConfig.managerRoleIds) ? guildConfig.managerRoleIds : [],
        roles
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not load bot settings.' });
    }
  });

  app.put('/api/dashboard/settings', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const body = req.body || {};
    const updates = {};
    if (body.prefix !== undefined) {
      if (typeof body.prefix !== 'string' || body.prefix.length < 1 || body.prefix.length > 5 || /\\s/.test(body.prefix))
        return res.status(400).json({ error: 'Prefix must be 1–5 characters with no spaces.' });
      updates.prefix = body.prefix;
    }
    if (body.language !== undefined) {
      if (!['en', 'fil', 'es', 'fr', 'de'].includes(body.language))
        return res.status(400).json({ error: 'Choose a supported dashboard language.' });
      updates.dashboardLanguage = body.language;
    }
    if (body.timezone !== undefined) {
      if (typeof body.timezone !== 'string' || body.timezone.length > 80)
        return res.status(400).json({ error: 'Choose a valid timezone.' });
      try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); }
      catch { return res.status(400).json({ error: 'Choose a valid timezone.' }); }
      updates.timezone = body.timezone;
    }
    if (body.managerRoleIds !== undefined) {
      if (!Array.isArray(body.managerRoleIds) || body.managerRoleIds.length > 100)
        return res.status(400).json({ error: 'Manager roles must be a list of up to 100 roles.' });
      const roleIds = [...new Set(body.managerRoleIds.map(String))];
      if (roleIds.some(id => !/^\d{17,20}$/.test(id) || !guild.roles.cache.has(id) || id === guild.id))
        return res.status(400).json({ error: 'One or more selected manager roles are invalid.' });
      updates.managerRoleIds = roleIds;
    }
    try {
      const saved = await updateGuildConfig(bot, guild.id, updates);
      if (!saved) return res.status(500).json({ error: 'Could not save server settings.' });
      const verified = await getGuildConfig(bot, guild.id);
      return res.json({
        ok: true,
        prefix: verified.prefix,
        language: verified.dashboardLanguage || 'en',
        timezone: verified.timezone || 'Asia/Manila',
        managerRoleIds: Array.isArray(verified.managerRoleIds) ? verified.managerRoleIds : []
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not save server settings.' });
    }
  });

  app.get('/api/dashboard/welcome', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const config = await getWelcomeConfig(bot, guild.id);
    const channels = guild.channels.cache
      .filter(channel => channel.isTextBased?.() && !channel.isThread?.())
      .map(channel => ({ id: channel.id, name: channel.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ config, channels });
  });

  app.put('/api/dashboard/welcome', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const body = req.body || {};
    const updates = {};
    for (const field of ['welcomeMessage', 'leaveMessage', 'banMessage', 'boostMessage']) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== 'string' || body[field].length > 2000) return res.status(400).json({ error: field + ' must be 2000 characters or fewer.' });
        updates[field] = body[field].trim();
      }
    }
    for (const field of ['welcomeEmbed', 'leaveEmbed', 'banEmbed', 'boostEmbed']) {
      if (body[field] !== undefined) {
        const embed = body[field];
        if (!embed || typeof embed !== 'object' || Array.isArray(embed)) return res.status(400).json({ error: 'Invalid ' + field + ' settings.' });
        const clean = {};
        for (const [key, max] of Object.entries({ color: 7, authorName: 256, title: 256, description: 4096, thumbnailUrl: 500, imageUrl: 500, footerIconUrl: 500, footerText: 2048 })) {
          if (embed[key] === undefined) continue;
          if (typeof embed[key] !== 'string' || embed[key].length > max) return res.status(400).json({ error: 'Invalid ' + field + ' ' + key + '.' });
          const value = embed[key].trim();
          if (['thumbnailUrl', 'imageUrl', 'footerIconUrl'].includes(key) && value) { try { const validationUrl = value.replaceAll('{user.avatar}', 'https://cdn.discordapp.com/embed/avatars/0.png'); const parsed = new URL(validationUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { return res.status(400).json({ error: field + ' ' + key + ' must be a valid HTTP or HTTPS URL or a URL containing {user.avatar}.' }); } }
          clean[key] = value;
        }
        if (clean.color && !/^#[0-9a-fA-F]{6}$/.test(clean.color)) return res.status(400).json({ error: field + ' color must be a 6-digit HEX color.' });
        updates[field] = clean;
      }
    }
    for (const field of ['enabled', 'welcomePing', 'goodbyeEnabled', 'goodbyePing', 'banEnabled', 'boostEnabled']) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== 'boolean') return res.status(400).json({ error: field + ' must be true or false.' });
        updates[field] = body[field];
      }
    }
    for (const field of ['channelId', 'goodbyeChannelId', 'banChannelId', 'boostChannelId']) {
      if (body[field] !== undefined) {
        const id = body[field] === '' || body[field] === null ? null : String(body[field]);
        if (id && !/^\d{17,20}$/.test(id)) return res.status(400).json({ error: 'Invalid channel selection.' });
        const channel = id ? guild.channels.cache.get(id) : null;
        if (id && (!channel || !channel.isTextBased?.() || channel.isThread?.()))
          return res.status(400).json({ error: 'Select a text channel from Barracks.' });
        updates[field] = id;
      }
    }
    for (const field of ['welcomeImage', 'goodbyeImage']) {
      if (body[field] !== undefined) {
        const url = body[field] === '' || body[field] === null ? null : String(body[field]).trim();
        if (url) {
          try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
          catch { return res.status(400).json({ error: field + ' must be a valid HTTP or HTTPS URL.' }); }
        }
        if (field === 'welcomeImage') updates.welcomeImage = url;
        else {
          const current = await getWelcomeConfig(bot, guild.id);
          updates.leaveEmbed = { ...(current.leaveEmbed || {}) };
          if (url) updates.leaveEmbed.image = url;
          else delete updates.leaveEmbed.image;
        }
      }
    }
    const current = await getWelcomeConfig(bot, guild.id);
    const saved = await saveWelcomeConfig(bot, guild.id, { ...current, ...updates });
    if (!saved) return res.status(500).json({ error: 'Could not save welcome settings.' });
    return res.json({ ok: true, config: await getWelcomeConfig(bot, guild.id) });
  });

  app.get('/api/dashboard/overview', (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    return res.json({
      guildId: DASHBOARD_GUILD_ID,
      guildName: guild?.name || 'Barracks',
      guildIcon: guild?.iconURL({ size: 128 }) || null,
      memberCount: guild?.memberCount ?? 0,
      channelCount: guild?.channels?.cache?.size ?? 0,
      roleCount: guild?.roles?.cache?.size ?? 0,
      botName: bot.user?.username || 'Barracks-Bot',
      botAvatar: bot.user?.displayAvatarURL({ size: 128 }) || null,
      botOnline: bot.isReady(),
      commandCount: bot.commands?.size ?? 0,
      uptimeSeconds: Math.floor(process.uptime()),
      updatedAt: new Date().toISOString()
    });
  });

  // Dashboard moderation actions are restricted to the configured Barracks guild.
  const requireDashboardGuild = (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) {
      res.status(503).json({ error: 'Barracks server is not available.' });
      return null;
    }
    return guild;
  };

  const autoNickRulesKey = guildId => `guild:${guildId}:autonick_dashboard_rules`;
  app.get('/api/dashboard/autonick', async (req, res) => {
    const guild = requireDashboardGuild(req, res); if (!guild) return;
    try {
      await guild.roles.fetch();
      const stored = await getFromDb(autoNickRulesKey(guild.id), []);
      const slashStored = await getFromDb(`guild:${guild.id}:autonick_roles`, []);
      const dashboardRules = (Array.isArray(stored) ? stored : []).map(rule => ({
        ...rule, source: 'dashboard', roleName: rule.roleId ? (guild.roles.cache.get(rule.roleId)?.name || 'Deleted role') : null
      }));
      const slashRules = (Array.isArray(slashStored) ? slashStored : []).map(rule => ({
        id: `slash-role:${rule.roleId}`, nickname: rule.tag ? String(rule.tag) : String(rule.prefix || ''), format: rule.tag ? 'clan-tag' : 'none', type: 'role', roleId: rule.roleId,
        priority: Number(rule.priority) || 0, source: 'slash', roleName: guild.roles.cache.get(rule.roleId)?.name || 'Deleted role'
      }));
      const rules = [...dashboardRules, ...slashRules];
      const roles = guild.roles.cache.filter(role => role.id !== guild.id && !role.managed)
        .sort((a,b)=>b.position-a.position).map(role=>({id:role.id,name:role.name}));
      return res.json({ rules, roles });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not load AutoNick rules.' }); }
  });
  app.post('/api/dashboard/autonick', async (req, res) => {
    const guild = requireDashboardGuild(req, res); if (!guild) return;
    const body = req.body || {}, nickname = String(body.nickname || '').trim();
    const type = String(body.type || 'join'), format = String(body.format || 'none');
    const roleId = String(body.roleId || ''), priority = Number(body.priority || 1);
    if (!nickname || nickname.length > 32) return res.status(400).json({ error: 'Nickname must contain 1–32 characters.' });
    if (!['join','role'].includes(type)) return res.status(400).json({ error: 'Choose a valid AutoNick type.' });
    if (!['none','uppercase','lowercase','title'].includes(format)) return res.status(400).json({ error: 'Choose a valid nickname format.' });
    if (type === 'role' && (!guild.roles.cache.has(roleId) || roleId === guild.id || guild.roles.cache.get(roleId)?.managed)) return res.status(400).json({ error: 'Choose a valid server role.' });
    if (type === 'role' && (!Number.isInteger(priority) || priority < 1 || priority > 1000)) return res.status(400).json({ error: 'Priority must be between 1 and 1000.' });
    try {
      const rules = await getFromDb(autoNickRulesKey(guild.id), []);
      const list = Array.isArray(rules) ? rules : [];
      if (type === 'join' && list.some(rule => rule.type === 'join')) return res.status(409).json({ error: 'A server-join AutoNick rule already exists. Delete it first to replace it.' });
      if (type === 'role' && list.some(rule => rule.type === 'role' && rule.roleId === roleId)) return res.status(409).json({ error: 'This role already has an AutoNick rule.' });
      const rule = { id: crypto.randomUUID(), nickname, format, type, roleId: type === 'role' ? roleId : null, priority: type === 'role' ? priority : 0, createdAt: Date.now() };
      list.push(rule); await setInDb(autoNickRulesKey(guild.id), list);
      return res.status(201).json({ ok: true, rule });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not create AutoNick rule.' }); }
  });
  app.patch('/api/dashboard/autonick/:ruleId', async (req, res) => {
    const guild = requireDashboardGuild(req, res); if (!guild) return;
    const requestedId = String(req.params.ruleId || '');
    const body = req.body || {};
    const nickname = String(body.nickname || '').trim();
    const priority = Number(body.priority || 1);
    if (!nickname || nickname.length > 32) return res.status(400).json({ error: 'Nickname must contain 1–32 characters.' });
    try {
      if (requestedId.startsWith('slash-role:')) {
        const roleId = requestedId.slice('slash-role:'.length);
        const slashRules = await getFromDb(`guild:${guild.id}:autonick_roles`, []);
        const list = Array.isArray(slashRules) ? slashRules : [];
        const index = list.findIndex(rule => String(rule.roleId) === roleId);
        if (index < 0) return res.status(404).json({ error: 'AutoNick role rule not found.' });
        if (!Number.isInteger(priority) || priority < 1 || priority > 1000) return res.status(400).json({ error: 'Priority must be between 1 and 1000.' });
        list[index] = { ...list[index], prefix: nickname, priority };
        await setInDb(`guild:${guild.id}:autonick_roles`, list);
        return res.json({ ok: true });
      }
      const type = String(body.type || 'join'), format = String(body.format || 'none');
      const roleId = String(body.roleId || '');
      if (!['join','role'].includes(type)) return res.status(400).json({ error: 'Choose a valid AutoNick type.' });
      if (!['none','uppercase','lowercase','title'].includes(format)) return res.status(400).json({ error: 'Choose a valid nickname format.' });
      if (type === 'role' && (!guild.roles.cache.has(roleId) || roleId === guild.id || guild.roles.cache.get(roleId)?.managed)) return res.status(400).json({ error: 'Choose a valid server role.' });
      if (type === 'role' && (!Number.isInteger(priority) || priority < 1 || priority > 1000)) return res.status(400).json({ error: 'Priority must be between 1 and 1000.' });
      const rules = await getFromDb(autoNickRulesKey(guild.id), []);
      const list = Array.isArray(rules) ? rules : [];
      const index = list.findIndex(rule => rule.id === requestedId);
      if (index < 0) return res.status(404).json({ error: 'AutoNick rule not found.' });
      if (type === 'join' && list.some((rule, i) => i !== index && rule.type === 'join')) return res.status(409).json({ error: 'A server-join AutoNick rule already exists.' });
      if (type === 'role' && list.some((rule, i) => i !== index && rule.type === 'role' && rule.roleId === roleId)) return res.status(409).json({ error: 'This role already has an AutoNick rule.' });
      list[index] = { ...list[index], nickname, format, type, roleId: type === 'role' ? roleId : null, priority: type === 'role' ? priority : 0, updatedAt: Date.now() };
      await setInDb(autoNickRulesKey(guild.id), list);
      return res.json({ ok: true, rule: list[index] });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not edit AutoNick rule.' }); }
  });

  app.delete('/api/dashboard/autonick/:ruleId', async (req, res) => {
    const guild = requireDashboardGuild(req, res); if (!guild) return;
    try {
      const requestedId = String(req.params.ruleId || '');
      if (requestedId.startsWith('slash-role:')) {
        const roleId = requestedId.slice('slash-role:'.length);
        const slashRules = await getFromDb(`guild:${guild.id}:autonick_roles`, []);
        const slashList = Array.isArray(slashRules) ? slashRules : [];
        const slashNext = slashList.filter(rule => rule.roleId !== roleId);
        if (slashNext.length === slashList.length) return res.status(404).json({ error: 'AutoNick role rule not found.' });
        await setInDb(`guild:${guild.id}:autonick_roles`, slashNext);
        return res.json({ ok: true });
      }
      const rules = await getFromDb(autoNickRulesKey(guild.id), []);
      const list = Array.isArray(rules) ? rules : [];
      const next = list.filter(rule => rule.id !== requestedId);
      if (next.length === list.length) return res.status(404).json({ error: 'AutoNick rule not found.' });
      await setInDb(autoNickRulesKey(guild.id), next);
      return res.json({ ok: true });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not delete AutoNick rule.' }); }
  });

  app.get('/api/dashboard/moderation/members', async (req, res) => {
    const guild = requireDashboardGuild(req, res);
    if (!guild) return;
    const query = String(req.query.q || '').trim().toLowerCase();
    if (query.length < 2) return res.status(400).json({ error: 'Enter at least 2 characters to search.' });
    try {
      await guild.members.fetch();
      const members = guild.members.cache
        .filter(member => !member.user.bot && (member.user.username.toLowerCase().includes(query)
          || member.displayName.toLowerCase().includes(query) || member.id.includes(query)))
        .first(15)
        .map(member => ({ id: member.id, username: member.user.username, displayName: member.displayName, avatar: member.user.displayAvatarURL({ size: 64 }) }));
      return res.json({ members });
    } catch {
      return res.status(500).json({ error: 'Could not search server members.' });
    }
  });


  const moderationLogKey = guildId => 'dashboard:moderation:' + guildId + ':logs';
  const recordModerationLog = async (guildId, entry) => {
    const key = moderationLogKey(guildId);
    const existing = await getFromDb(key, []);
    const logs = Array.isArray(existing) ? existing : [];
    logs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), moderator: 'Dashboard staff', ...entry });
    await setInDb(key, logs.slice(0, 500));
  };

  app.get('/api/dashboard/moderation/logs', async (req, res) => {
    const guild = requireDashboardGuild(req, res);
    if (!guild) return;
    const rawLimit = Number(req.query.limit) || 50;
    const limit = Math.min(100, Math.max(1, rawLimit));
    try {
      const stored = await getFromDb(moderationLogKey(guild.id), []);
      const logs = Array.isArray(stored) ? stored.slice(0, limit) : [];
      return res.json({ logs, totalStored: Array.isArray(stored) ? stored.length : 0 });
    } catch {
      return res.status(500).json({ error: 'Could not load moderation logs.' });
    }
  });

  app.post('/api/dashboard/moderation/action', async (req, res) => {
    const guild = requireDashboardGuild(req, res);
    if (!guild) return;
    const { action, userId, reason, duration, channelId, amount } = req.body || {};
    const cleanReason = String(reason || 'No reason provided').trim().slice(0, 400);
    const me = guild.members.me;
    if (!me) return res.status(503).json({ error: 'Bot member information is unavailable.' });
    try {
      if (action === 'clear') {
        if (!me.permissions.has('ManageMessages')) return res.status(403).json({ error: 'Bot needs Manage Messages permission.' });
        const channel = guild.channels.cache.get(String(channelId || ''));
        if (!channel || !channel.isTextBased?.() || !channel.messages?.bulkDelete)
          return res.status(400).json({ error: 'Choose a valid text channel in Barracks.' });
        const count = Math.min(100, Math.max(1, Number(amount) || 10));
        const deleted = await channel.bulkDelete(count, true);
        await recordModerationLog(guild.id, { action, targetId: null, targetName: channel.name, reason: cleanReason, details: deleted.size + ' messages deleted' });
        return res.json({ ok: true, message: 'Deleted ' + deleted.size + ' recent messages.' });
      }

      if (!/^\d{17,20}$/.test(String(userId || ''))) return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
      const target = await guild.members.fetch(String(userId)).catch(() => null);
      if (action !== 'unban' && !target) return res.status(404).json({ error: 'That member was not found in Barracks.' });
      if (target && (target.id === guild.ownerId || target.id === bot.user.id || target.id === req.body?.actorId))
        return res.status(400).json({ error: 'This member cannot be moderated from the dashboard.' });
      if (target && me.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        return res.status(403).json({ error: 'The bot role must be higher than the target member.' });

      if (action === 'ban') {
        if (!me.permissions.has('BanMembers')) return res.status(403).json({ error: 'Bot needs Ban Members permission.' });
        if (!target.bannable) return res.status(403).json({ error: 'The bot cannot ban this member.' });
        await target.ban({ reason: cleanReason });
        await recordModerationLog(guild.id, { action, targetId: target.id, targetName: target.user.tag, reason: cleanReason });
        return res.json({ ok: true, message: 'Member banned successfully.' });
      }
      if (action === 'unban') {
        if (!me.permissions.has('BanMembers')) return res.status(403).json({ error: 'Bot needs Ban Members permission.' });
        await guild.members.unban(String(userId), cleanReason);
        await recordModerationLog(guild.id, { action, targetId: String(userId), targetName: String(userId), reason: cleanReason });
        return res.json({ ok: true, message: 'User unbanned successfully.' });
      }
      if (action === 'kick') {
        if (!me.permissions.has('KickMembers')) return res.status(403).json({ error: 'Bot needs Kick Members permission.' });
        if (!target.kickable) return res.status(403).json({ error: 'The bot cannot kick this member.' });
        await target.kick(cleanReason);
        await recordModerationLog(guild.id, { action, targetId: target.id, targetName: target.user.tag, reason: cleanReason });
        return res.json({ ok: true, message: 'Member kicked successfully.' });
      }
      if (action === 'timeout') {
        if (!me.permissions.has('ModerateMembers')) return res.status(403).json({ error: 'Bot needs Moderate Members permission.' });
        if (!target.moderatable) return res.status(403).json({ error: 'The bot cannot timeout this member.' });
        const minutes = Math.min(40320, Math.max(1, Number(duration) || 10));
        await target.timeout(minutes * 60 * 1000, cleanReason);
        await recordModerationLog(guild.id, { action, targetId: target.id, targetName: target.user.tag, reason: cleanReason, details: minutes + ' minutes' });
        return res.json({ ok: true, message: 'Member timed out for ' + minutes + ' minutes.' });
      }
      if (action === 'untimeout') {
        if (!me.permissions.has('ModerateMembers')) return res.status(403).json({ error: 'Bot needs Moderate Members permission.' });
        if (!target.moderatable) return res.status(403).json({ error: 'The bot cannot edit this member.' });
        await target.timeout(null, cleanReason);
        await recordModerationLog(guild.id, { action, targetId: target.id, targetName: target.user.tag, reason: cleanReason });
        return res.json({ ok: true, message: 'Timeout removed.' });
      }
      if (action === 'warn') {
        const dm = await target.send('You have received a warning in **' + guild.name + '**. Reason: ' + cleanReason).then(() => true).catch(() => false);
        await recordModerationLog(guild.id, { action, targetId: target.id, targetName: target.user.tag, reason: cleanReason, details: dm ? 'DM delivered' : 'DM could not be delivered' });
        return res.json({ ok: true, message: dm ? 'Warning delivered by DM.' : 'Could not DM the member (their DMs may be closed).' });
      }
      return res.status(400).json({ error: 'Unknown moderation action.' });
    } catch (error) {
      return res.status(400).json({ error: error?.message || 'The moderation action failed.' });
    }
  });

  app.get('/api/dashboard/economy', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const rawKeys = await bot.db.list(getEconomyPrefix(guild.id));
      const keys = Array.isArray(rawKeys) ? rawKeys : Object.keys(rawKeys || {});
      const userIds = [...new Set(keys.map(key => String(key).split(':').pop()).filter(id => /^\d{17,20}$/.test(id)))];
      let walletTotal = 0, bankTotal = 0;
      const accounts = [];
      // Read balances concurrently in small batches to avoid serial database waits
      // while keeping database load bounded on larger servers.
      const batchSize = 25;
      for (let i = 0; i < userIds.length; i += batchSize) {
        const batch = userIds.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async userId => {
          const data = await getEconomyData(bot, guild.id, userId);
          const wallet = Number(data.wallet) || 0;
          const bank = Number(data.bank) || 0;
          return { userId, wallet, bank, total: wallet + bank };
        }));
        for (const account of results) {
          walletTotal += account.wallet;
          bankTotal += account.bank;
          accounts.push(account);
        }
      }
      accounts.sort((a, b) => b.total - a.total);
      const top = await Promise.all(accounts.slice(0, 15).map(async account => {
        const member = guild.members.cache.get(account.userId)
          || await guild.members.fetch(account.userId).catch(() => null);
        return {
          ...account,
          serverName: member?.displayName || member?.user?.globalName || member?.user?.username || account.userId
        };
      }));
      return res.json({
        users: accounts.length,
        walletTotal,
        bankTotal,
        total: walletTotal + bankTotal,
        top
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not load economy data.' });
    }
  });

  app.post('/api/dashboard/economy/adjust', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const { userId, account, amount, action } = req.body || {};
    if (!/^\d{17,20}$/.test(String(userId || ''))) return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
    if (!['wallet', 'bank'].includes(account)) return res.status(400).json({ error: 'Choose wallet or bank.' });
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000000) return res.status(400).json({ error: 'Amount must be a whole number from 1 to 1,000,000,000.' });
    if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'Choose add or remove.' });
    try {
      const data = await getEconomyData(bot, guild.id, String(userId));
      const before = Number(data[account]) || 0;
      const after = action === 'add' ? before + value : before - value;
      if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: 'This change would make the balance invalid or negative.' });
      if (account === 'bank' && after > getMaxBankCapacity(data)) return res.status(400).json({ error: 'This would exceed the member bank capacity.' });
      data[account] = after;
      const saved = await setEconomyData(bot, guild.id, String(userId), data);
      if (!saved) return res.status(500).json({ error: 'Could not save the balance change.' });
      const logKey = 'global:economy:dashboard_transactions';
      const existing = await bot.db.get(logKey, []);
      const entries = Array.isArray(existing) ? existing : [];
      entries.unshift({ userId: String(userId), account, action, amount: value, before, after, at: Date.now() });
      await bot.db.set(logKey, entries.slice(0, 200));
      return res.json({ ok: true, userId: String(userId), account, before, after });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not adjust the member balance.' });
    }
  });

  app.get('/api/dashboard/games-activities', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const games = await bot.db.get(`guild:${guild.id}:games:config`, {});
      const counting = await getCountingGameConfig(bot, guild.id);
      const leveling = await getLevelingConfig(bot, guild.id);
      const channels = guild.channels.cache.filter(ch => ch.isTextBased?.() && !ch.isThread?.()).map(ch => ({ id: ch.id, name: ch.name })).sort((a,b)=>a.name.localeCompare(b.name));
      return res.json({
        games: { dotaEnabled: games.dotaEnabled !== false, dotaReward: Number(games.dotaReward) || 1000, pokemonEnabled: games.pokemonEnabled !== false, pokemonReward: Number(games.pokemonReward) || 1000 },
        counting: { enabled: counting.enabled, channelId: counting.channelId, system: counting.system, nextNumber: counting.nextNumber, currentStreak: counting.currentStreak, bestStreak: counting.bestStreak },
        leveling: { enabled: leveling.enabled, xpMin: Number(leveling.xpRange?.min ?? leveling.xpPerMessage?.min ?? 15), xpMax: Number(leveling.xpRange?.max ?? leveling.xpPerMessage?.max ?? 25), xpCooldown: Number(leveling.xpCooldown ?? 60), xpMultiplier: Number(leveling.xpMultiplier ?? 1), voiceXpEnabled: leveling.voiceXpEnabled !== false, voiceXpPerMinute: Number(leveling.voiceXpPerMinute ?? 5) },
        channels
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not load games and activities.' });
    }
  });

  app.put('/api/dashboard/games-activities', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const body = req.body || {};
    try {
      if (body.games !== undefined) {
        const current = await bot.db.get(`guild:${guild.id}:games:config`, {});
        const next = { ...current };
        for (const key of ['dotaEnabled', 'pokemonEnabled']) {
          if (body.games[key] !== undefined) {
            if (typeof body.games[key] !== 'boolean') return res.status(400).json({ error: key + ' must be true or false.' });
            next[key] = body.games[key];
          }
        }
        for (const key of ['dotaReward', 'pokemonReward']) {
          if (body.games[key] !== undefined) {
            const amount = Number(body.games[key]);
            if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) return res.status(400).json({ error: key + ' must be from 1 to 1,000,000,000.' });
            next[key] = amount;
          }
        }
        await bot.db.set(`guild:${guild.id}:games:config`, next);
      }
      if (body.counting !== undefined) {
        const current = await getCountingGameConfig(bot, guild.id);
        const next = { ...current };
        if (body.counting.enabled !== undefined) {
          if (typeof body.counting.enabled !== 'boolean') return res.status(400).json({ error: 'Counting enabled must be true or false.' });
          next.enabled = body.counting.enabled;
        }
        if (body.counting.channelId !== undefined) {
          const id = body.counting.channelId ? String(body.counting.channelId) : null;
          const channel = id ? guild.channels.cache.get(id) : null;
          if (id && (!channel || !channel.isTextBased?.() || channel.isThread?.())) return res.status(400).json({ error: 'Select a valid text channel for counting.' });
          next.channelId = id;
        }
        if (body.counting.system !== undefined) {
          if (!['decimal','binary','hexadecimal','base36','base64','roman','math','alphabet'].includes(body.counting.system)) return res.status(400).json({ error: 'Choose a supported counting system.' });
          next.system = body.counting.system;
        }
        await saveCountingGameConfig(bot, guild.id, next);
      }
      if (body.leveling !== undefined) {
        const current = await getLevelingConfig(bot, guild.id);
        const next = { ...current };
        if (body.leveling.enabled !== undefined) {
          if (typeof body.leveling.enabled !== 'boolean') return res.status(400).json({ error: 'Leveling enabled must be true or false.' });
          next.enabled = body.leveling.enabled;
        }
        const min = Number(body.leveling.xpMin ?? next.xpRange?.min ?? next.xpPerMessage?.min ?? 15);
        const max = Number(body.leveling.xpMax ?? next.xpRange?.max ?? next.xpPerMessage?.max ?? 25);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 1000) return res.status(400).json({ error: 'Message XP must be whole numbers between 1 and 1,000, with minimum not above maximum.' });
        next.xpRange = { min, max };
        if (body.leveling.xpCooldown !== undefined) {
          const cooldown = Number(body.leveling.xpCooldown);
          if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 3600) return res.status(400).json({ error: 'Message XP cooldown must be between 0 and 3,600 seconds.' });
          next.xpCooldown = cooldown;
        }
        if (body.leveling.xpMultiplier !== undefined) {
          const multiplier = Number(body.leveling.xpMultiplier);
          if (!Number.isFinite(multiplier) || multiplier < 0.1 || multiplier > 10) return res.status(400).json({ error: 'XP multiplier must be between 0.1 and 10.' });
          next.xpMultiplier = multiplier;
        }
        if (body.leveling.voiceXpEnabled !== undefined) {
          if (typeof body.leveling.voiceXpEnabled !== 'boolean') return res.status(400).json({ error: 'Voice XP enabled must be true or false.' });
          next.voiceXpEnabled = body.leveling.voiceXpEnabled;
        }
        if (body.leveling.voiceXpPerMinute !== undefined) {
          const amount = Number(body.leveling.voiceXpPerMinute);
          if (!Number.isInteger(amount) || amount < 1 || amount > 100) return res.status(400).json({ error: 'Voice XP per minute must be between 1 and 100.' });
          next.voiceXpPerMinute = amount;
        }
        await saveLevelingConfig(bot, guild.id, next);
      }
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not save games and activities settings.' });
    }
  });

  app.post('/api/dashboard/games-activities/counting/reset', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const current = await getCountingGameConfig(bot, guild.id);
    await saveCountingGameConfig(bot, guild.id, { ...current, nextNumber: 1, lastUserId: null, currentStreak: 0 });
    return res.json({ ok: true });
  });


  app.get('/api/dashboard/leveling', async (req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});try{const c=await getLevelingConfig(bot,guild.id);const availableRoles=await guild.roles.fetch();return res.json({config:{enabled:c.enabled,xpMin:Number(c.xpRange?.min??c.xpPerMessage?.min??15),xpMax:Number(c.xpRange?.max??c.xpPerMessage?.max??25),xpCooldown:Number(c.xpCooldown??60),xpMultiplier:Number(c.xpMultiplier??1),announceLevelUp:c.announceLevelUp!==false,levelUpChannel:c.levelUpChannel||null,levelUpContent:c.levelUpContent??c.levelUpMessage??'',levelUpMessages:c.levelUpMessages||{},levelUpEmbed:c.levelUpEmbed||{},voiceXpEnabled:c.voiceXpEnabled!==false,voiceXpPerMinute:Number(c.voiceXpPerMinute??5),ignoredChannels:c.ignoredChannels||[],ignoredRoles:c.ignoredRoles||[],roleXpMultipliers:c.roleXpMultipliers||{}},channels:(await guild.channels.fetch()).filter(x=>x&&x.isTextBased?.()&&!x.isThread?.()).sort((a,b)=>a.rawPosition-b.rawPosition).map(x=>({id:x.id,name:x.name})),roles:availableRoles.filter(x=>x.id!==guild.id).sort((a,b)=>b.position-a.position).map(x=>({id:x.id,name:x.name,position:x.position,managed:x.managed}))});}catch(e){return res.status(500).json({error:e.message||'Could not load leveling settings.'});}});
  app.put('/api/dashboard/leveling',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const b=req.body||{};const min=Number(b.xpMin),max=Number(b.xpMax),cool=Number(b.xpCooldown),mult=Number(b.xpMultiplier),voice=Number(b.voiceXpPerMinute);if(!Number.isInteger(min)||!Number.isInteger(max)||min<1||max<min||max>1000||!Number.isInteger(cool)||cool<0||cool>3600||!Number.isFinite(mult)||mult<.1||mult>10||!Number.isInteger(voice)||voice<1||voice>100)return res.status(400).json({error:'Check XP range, cooldown, multiplier, and voice XP values.'});if(b.levelUpChannel&&!guild.channels.cache.get(String(b.levelUpChannel)))return res.status(400).json({error:'Invalid level-up channel.'});for(const id of [...(b.ignoredChannels||[]),...(b.ignoredRoles||[])])if(!guild.channels.cache.has(String(id))&&!guild.roles.cache.has(String(id)))return res.status(400).json({error:'An ignored channel or role is invalid.'});const roleXpMultipliers={};if(b.roleXpMultipliers!==undefined){if(!b.roleXpMultipliers||typeof b.roleXpMultipliers!=='object'||Array.isArray(b.roleXpMultipliers))return res.status(400).json({error:'Role XP multipliers must be a role-to-multiplier object.'});for(const [roleId,rawMultiplier] of Object.entries(b.roleXpMultipliers)){const role=guild.roles.cache.get(String(roleId)),roleMultiplier=Number(rawMultiplier);if(!role||role.id===guild.id)return res.status(400).json({error:'A configured XP multiplier role is invalid.'});if(!Number.isFinite(roleMultiplier)||roleMultiplier<0.1||roleMultiplier>10)return res.status(400).json({error:'Role XP multipliers must be between 0.1 and 10.'});roleXpMultipliers[roleId]=roleMultiplier;}}try{const c=await getLevelingConfig(bot,guild.id);await saveLevelingConfig(bot,guild.id,{...c,enabled:Boolean(b.enabled),xpRange:{min,max},xpPerMessage:{min,max},xpCooldown:cool,xpMultiplier:mult,announceLevelUp:Boolean(b.announceLevelUp),levelUpChannel:b.levelUpChannel||null,levelUpContent:String(b.levelUpContent??b.levelUpMessage??'{user}').slice(0,2000),levelUpMessages:{template:String(b.levelUpMessages?.template??'').slice(0,2000)},levelUpEmbed:{color:/^#[0-9a-fA-F]{6}$/.test(String(b.levelUpEmbed?.color||''))?String(b.levelUpEmbed.color):'#36393f',authorName:String(b.levelUpEmbed?.authorName||'').slice(0,256),title:String(b.levelUpEmbed?.title||'').slice(0,256),thumbnailUrl:String(b.levelUpEmbed?.thumbnailUrl||'').slice(0,500),imageUrl:String(b.levelUpEmbed?.imageUrl||'').slice(0,500),description:String(b.levelUpEmbed?.description||'').slice(0,4096),footerText:String(b.levelUpEmbed?.footerText||'').slice(0,2048),footerIconUrl:String(b.levelUpEmbed?.footerIconUrl||'').slice(0,500)},voiceXpEnabled:Boolean(b.voiceXpEnabled),voiceXpPerMinute:voice,ignoredChannels:[...(b.ignoredChannels||[])],ignoredRoles:[...(b.ignoredRoles||[])],roleXpMultipliers});return res.json({ok:true});}catch(e){return res.status(500).json({error:e.message||'Could not save leveling settings.'});}});
  app.get('/api/dashboard/boosters', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      // Fetch members through Discord's REST List Guild Members endpoint in
      // pages. This includes members absent from the gateway cache and avoids
      // Gateway Opcode 8 member chunk requests on every dashboard refresh.
      const now = Date.now();
      let snapshot = boosterMemberSnapshots.get(guild.id);
      if (!snapshot || now - snapshot.createdAt > BOOSTER_SNAPSHOT_TTL_MS) {
        if (!snapshot?.pending) {
          const pending = (async () => {
            const allMembers = new Map();
            let after;
            while (true) {
              const page = await guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
              for (const [id, member] of page) allMembers.set(id, member);
              if (page.size < 1000) break;
              const lastId = [...page.keys()].at(-1);
              if (!lastId || lastId === after) break;
              after = lastId;
            }
            const result = { createdAt: Date.now(), members: allMembers };
            boosterMemberSnapshots.set(guild.id, result);
            return result;
          })();
          boosterMemberSnapshots.set(guild.id, { ...(snapshot || {}), pending });
        }
        snapshot = boosterMemberSnapshots.get(guild.id);
        snapshot = await snapshot.pending;
      }
      const boosters = [...snapshot.members.values()].filter(member => member.premiumSince).map(member => {
        const boostStartedAt = member.premiumSince;
        const now = new Date();
        const monthDifference = (now.getUTCFullYear() - boostStartedAt.getUTCFullYear()) * 12
          + now.getUTCMonth() - boostStartedAt.getUTCMonth();
        const addMonthsClamped = months => {
          const monthIndex = boostStartedAt.getUTCMonth() + months;
          const year = boostStartedAt.getUTCFullYear() + Math.floor(monthIndex / 12);
          const month = ((monthIndex % 12) + 12) % 12;
          const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
          const day = Math.min(boostStartedAt.getUTCDate(), lastDayOfMonth);
          return new Date(Date.UTC(
            year, month, day,
            boostStartedAt.getUTCHours(),
            boostStartedAt.getUTCMinutes(),
            boostStartedAt.getUTCSeconds(),
            boostStartedAt.getUTCMilliseconds()
          ));
        };
        let monthsUntilNextRenewal = Math.max(1, monthDifference);
        let estimatedExpiresAt = addMonthsClamped(monthsUntilNextRenewal);
        if (estimatedExpiresAt <= now) {
          monthsUntilNextRenewal += 1;
          estimatedExpiresAt = addMonthsClamped(monthsUntilNextRenewal);
        }
        return {
          displayName: member.displayName || member.user.globalName || member.user.username,
          userId: member.id,
          boostStartedAt: boostStartedAt.toISOString(),
          estimatedExpiresAt: estimatedExpiresAt.toISOString()
        };
      }).sort((a, b) => new Date(a.estimatedExpiresAt) - new Date(b.estimatedExpiresAt));
      const activity = await getFromDb(`guild:${guild.id}:boost_activity`, []);
      const boostStartCountsRaw = await getFromDb(`guild:${guild.id}:boost_start_counts`, {});
      const boostStartCounts = boostStartCountsRaw && typeof boostStartCountsRaw === 'object' && !Array.isArray(boostStartCountsRaw) ? boostStartCountsRaw : {};
      for (const member of boosters) member.boostActivityCount = Number(boostStartCounts[member.userId] || 0);
      return res.json({
        boosters,
        total: boosters.length,
        serverBoostCount: guild.premiumSubscriptionCount ?? 0,
        serverBoostLevel: guild.premiumTier ?? 0,
        expiryIsEstimate: true,
        membersScanned: snapshot.members.size,
        activity: Array.isArray(activity) ? activity.slice(0, 50) : [],
        snapshotUpdatedAt: new Date(snapshot.createdAt).toISOString()
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not load current server boosters.' });
    }
  });

  app.get('/api/dashboard/roles-channels',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const tagRoleConfig=await bot.db.get('guild:'+guild.id+':tag-role-config',{enabled:false,roleId:''});return res.json({tagRoleConfig,roles:guild.roles.cache.filter(x=>x.id!==guild.id).sort((a,b)=>b.position-a.position).map(x=>({id:x.id,name:x.name,color:x.hexColor,position:x.position,managed:x.managed})),channels:guild.channels.cache.sort((a,b)=>a.rawPosition-b.rawPosition).map(x=>({id:x.id,name:x.name,type:x.type===4?'category':x.isVoiceBased?.()?'voice':'text',parentId:x.parentId||null,position:x.rawPosition}))});});
  app.put('/api/dashboard/roles-channels/tag-role',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const enabled=req.body?.enabled===true,roleId=String(req.body?.roleId||'').trim();if(enabled&&!roleId)return res.status(400).json({error:'Choose a role before enabling Tag Role.'});const role=roleId?guild.roles.cache.get(roleId):null;if(enabled&&(!role||role.managed||!role.editable))return res.status(400).json({error:'Choose a valid role that the bot can manage.'});try{const config={enabled,roleId:enabled?roleId:''};await bot.db.set('guild:'+guild.id+':tag-role-config',config);if(enabled){const members=await guild.members.fetch();const {syncTagRoleForMember}=await import('../services/tagRoleService.js');for(const member of members.values()){await syncTagRoleForMember(member).catch(error=>console.warn('[TAG_ROLE] Could not sync member '+member.id+': '+error.message));}}return res.json({ok:true,config});}catch(error){return res.status(500).json({error:error?.message||'Could not save Tag Role settings.'});}});
  app.post('/api/dashboard/roles-channels/role',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const name=String(req.body?.name||'').trim(),color=String(req.body?.color||'#c3f36b');if(!name||name.length>100||!/^#[0-9a-fA-F]{6}$/.test(color))return res.status(400).json({error:'Enter a valid role name and color.'});try{const role=await guild.roles.create({name,color,reason:'Created from Barracks dashboard'});return res.json({ok:true,id:role.id,name:role.name});}catch(e){return res.status(500).json({error:e.message||'Could not create role.'});}});
  app.post('/api/dashboard/roles-channels/channel',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const name=String(req.body?.name||'').trim().toLowerCase().replace(/[^a-z0-9-_]/g,'-').replace(/-+/g,'-').slice(0,100),type=String(req.body?.type||'text');if(!name||!['text','voice','category'].includes(type))return res.status(400).json({error:'Enter a valid channel name and type.'});try{const channel=await guild.channels.create({name,type:type==='category'?4:type==='voice'?2:0,reason:'Created from Barracks dashboard'});return res.json({ok:true,id:channel.id,name:channel.name});}catch(e){return res.status(500).json({error:e.message||'Could not create channel.'});}});
  app.get('/api/dashboard/tickets',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const config=await bot.db.get('guild:'+guild.id+':tickets:dashboard-config',{});return res.json({config,roles:guild.roles.cache.filter(x=>x.id!==guild.id&&!x.managed).map(x=>({id:x.id,name:x.name})),channels:guild.channels.cache.map(x=>({id:x.id,name:x.name,type:x.type===4?'category':x.isVoiceBased?.()?'voice':'text'}))});});
  app.put('/api/dashboard/tickets',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const b=req.body||{};const prefix=String(b.prefix||'ticket').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,20);if(!prefix||!String(b.title||'').trim()||String(b.title).length>200||String(b.message||'').length>1800)return res.status(400).json({error:'Check ticket prefix, title, and message.'});if(b.categoryId&&guild.channels.cache.get(String(b.categoryId))?.type!==4)return res.status(400).json({error:'Choose a valid category.'});if(b.logChannelId&&!guild.channels.cache.get(String(b.logChannelId))?.isTextBased?.())return res.status(400).json({error:'Choose a valid text log channel.'});if((b.supportRoleIds||[]).some(id=>!guild.roles.cache.has(String(id))))return res.status(400).json({error:'One or more support roles are invalid.'});try{await bot.db.set('guild:'+guild.id+':tickets:dashboard-config',{categoryId:b.categoryId||null,logChannelId:b.logChannelId||null,supportRoleIds:[...(b.supportRoleIds||[])],prefix,title:String(b.title).trim(),message:String(b.message||'').trim()});return res.json({ok:true});}catch(e){return res.status(500).json({error:e.message||'Could not save ticket settings.'});}});


  app.get('/api/dashboard/birthdays', async (req, res) => {
    const guild = requireDashboardGuild(req, res); if (!guild) return;
    try {
      const config = await getGuildConfig(bot, guild.id);
      const entries = await getAllBirthdays(bot, guild.id);
      const ids = entries.map(entry => entry.userId);
      const members = ids.length ? await guild.members.fetch({ user: ids }).catch(() => null) : null;
      const birthdays = entries.filter(entry => !members || members.has(entry.userId)).map(entry => {
        const member = members?.get(entry.userId);
        return { userId: entry.userId, username: member?.user?.username || member?.displayName || 'Unknown member',
          displayName: member?.displayName || member?.user?.username || 'Unknown member',
          month: entry.month, day: entry.day, monthName: entry.monthName, year: entry.year ?? null };
      });
      const channels = guild.channels.cache.filter(channel => channel.isTextBased?.() && !channel.isThread?.())
        .map(channel => ({ id: channel.id, name: channel.name })).sort((x,y) => x.name.localeCompare(y.name));
      const roles = guild.roles.cache.filter(role => role.id !== guild.id && !role.managed)
        .sort((x,y) => y.position - x.position).map(role => ({ id: role.id, name: role.name }));
      return res.json({ config: { birthdayChannelId: config.birthdayChannelId || null,
        birthdayRoleId: config.birthdayRoleId === undefined ? '1557466630991388744' : config.birthdayRoleId,
        birthdayEmbed: config.birthdayEmbed || {} },
        birthdays, channels, roles });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not load birthdays.' }); }
  });
  app.post('/api/dashboard/birthdays/announce-now', async (req, res) => {
    const guild = requireDashboardGuild(req, res); if (!guild) return;
    const channel = await guild.channels.fetch(String(req.body?.channelId || '')).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isThread?.() || typeof channel.send !== 'function') return res.status(400).json({ error: 'Choose a valid destination text channel.' });
    const raw=req.body?.embed||{},cleanUrl=value=>{const text=String(value||'').trim();if(!text)return null;try{const url=new URL(text);return ['http:','https:'].includes(url.protocol)?url.toString():null;}catch{return null;}};
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Manila',month:'numeric',day:'numeric'}).formatToParts(new Date()),month=Number(parts.find(p=>p.type==='month')?.value),day=Number(parts.find(p=>p.type==='day')?.value);
    const entries=await getAllBirthdays(bot,guild.id),today=entries.filter(entry=>entry.month===month&&entry.day===day),birthdayMembers=(await Promise.all(today.map(entry=>guild.members.fetch(entry.userId).catch(()=>null)))).filter(Boolean),mentions=birthdayMembers.map(member=>member.toString()),ids=birthdayMembers.map(member=>member.id);
    const resolveText=value=>String(value||'').replaceAll('{server}',guild.name).replaceAll('{count}',String(birthdayMembers.length)).replaceAll('{members}',mentions.join(', '));
    const color=/^#[0-9a-fA-F]{6}$/.test(String(raw.color||''))?parseInt(String(raw.color).slice(1),16):0x5865F2,embed=new EmbedBuilder().setColor(color);
    if(raw.title)embed.setTitle(resolveText(raw.title).slice(0,256));
    if(raw.description)embed.setDescription(resolveText(raw.description).slice(0,4096));
    const au=cleanUrl(raw.authorUrl),ai=cleanUrl(raw.authorIconUrl),fi=cleanUrl(raw.footerIconUrl);
    if(raw.author)embed.setAuthor({name:String(raw.author).slice(0,256),url:au||undefined,iconURL:ai||undefined});
    if(raw.footer)embed.setFooter({text:String(raw.footer).slice(0,2048),iconURL:fi||undefined});
    const image=cleanUrl(raw.imageUrl),thumb=cleanUrl(raw.thumbnailUrl);if(image)embed.setImage(image);if(thumb)embed.setThumbnail(thumb);
    const fields=Array.isArray(raw.fields)?raw.fields.slice(0,25).filter(f=>String(f?.name||'').trim()&&String(f?.value||'').trim()).map(f=>({name:resolveText(f.name).slice(0,256),value:resolveText(f.value).slice(0,1024),inline:!!f.inline})):[];
    if(fields.length)embed.addFields(fields);if(raw.timestamp!==false)embed.setTimestamp();
    try{await channel.send({embeds:[embed],allowedMentions:{users:ids}});return res.json({ok:true});}catch(error){return res.status(500).json({error:error?.message||'Could not send birthday announcement.'});}
  });

  app.put('/api/dashboard/birthdays', async (req, res) => {
    const guild = requireDashboardGuild(req, res); if (!guild) return;
    const channelId = req.body?.birthdayChannelId ? String(req.body.birthdayChannelId) : null;
    const roleId = req.body?.birthdayRoleId ? String(req.body.birthdayRoleId) : null;
    if (channelId) { const channel = guild.channels.cache.get(channelId); if (!channel || !channel.isTextBased?.() || channel.isThread?.()) return res.status(400).json({ error: 'Choose a valid announcement text channel.' }); }
    if (roleId && (!guild.roles.cache.has(roleId) || roleId === guild.id || guild.roles.cache.get(roleId)?.managed)) return res.status(400).json({ error: 'Choose a valid birthday role.' });
    try {
      const rawEmbed = req.body?.birthdayEmbed || {};
      const color = /^#[0-9a-fA-F]{6}$/.test(String(rawEmbed.color || '')) ? String(rawEmbed.color) : '#5865F2';
      const cleanUrl = value => { const text = String(value || '').trim(); if (!text) return null; try { const url = new URL(text); return ['http:','https:'].includes(url.protocol) ? url.toString() : null; } catch { return null; } };
      const embed = {
        title: String(rawEmbed.title || '').trim().slice(0, 256), description: String(rawEmbed.description || '').trim().slice(0, 4096), color,
        author: String(rawEmbed.author || '').trim().slice(0, 256), authorUrl: cleanUrl(rawEmbed.authorUrl), authorIconUrl: cleanUrl(rawEmbed.authorIconUrl),
        footer: String(rawEmbed.footer || '').trim().slice(0, 2048), footerIconUrl: cleanUrl(rawEmbed.footerIconUrl),
        imageUrl: cleanUrl(rawEmbed.imageUrl), thumbnailUrl: cleanUrl(rawEmbed.thumbnailUrl),
        fields: Array.isArray(rawEmbed.fields) ? rawEmbed.fields.slice(0,25).map(f=>({name:String(f?.name||'').trim().slice(0,256),value:String(f?.value||'').trim().slice(0,1024),inline:!!f?.inline})).filter(f=>f.name&&f.value) : [],
        timestamp: rawEmbed.timestamp !== false
      };
      for (const key of ['authorUrl','authorIconUrl','footerIconUrl']) if (rawEmbed[key] && !embed[key]) return res.status(400).json({ error: key+' must be a valid HTTP or HTTPS URL.' });
      if (rawEmbed.imageUrl && !embed.imageUrl) return res.status(400).json({ error: 'Image URL must be a valid HTTP or HTTPS URL.' });
      if (rawEmbed.thumbnailUrl && !embed.thumbnailUrl) return res.status(400).json({ error: 'Thumbnail URL must be a valid HTTP or HTTPS URL.' });
      if (!embed.title && !embed.description) return res.status(400).json({ error: 'Add an embed title or description.' });
      const saved = await updateGuildConfig(bot, guild.id, { birthdayChannelId: channelId, birthdayRoleId: roleId, birthdayEmbed: embed });
      if (!saved) return res.status(500).json({ error: 'Could not save birthday settings.' });
      return res.json({ ok: true, birthdayChannelId: channelId, birthdayRoleId: roleId });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not save birthday settings.' }); }
  });

  // Keep dashboard-created clans in the same registry used by Discord clan commands.
  const clanStorageKey = guildId => 'guild:' + guildId + ':clans';
  const legacyClanStorageKey = guildId => 'dashboard:clans:' + guildId;
  const registerClanAutoNick = async (guild, role, tag, format = 'TAG {username}') => {
    const key = 'guild:' + guild.id + ':autonick_roles';
    const stored = await getFromDb(key, []);
    const entries = Array.isArray(stored) ? stored.filter(entry => entry && typeof entry.roleId === 'string') : [];
    const safeFormat = String(format || 'TAG {username}').trim().slice(0, 32);
    const existing = entries.find(entry => entry.roleId === role.id);
    if (existing) Object.assign(existing, { prefix: '', format: safeFormat, tag: String(tag), priority: 50 });
    else entries.push({ roleId: role.id, prefix: '', format: safeFormat, tag: String(tag), priority: 50 });
    entries.sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0));
    await setInDb(key, entries);
  };
  const applyClanAutoNick = async (member) => {
    const stateKey = `guild:${member.guild.id}:autonick_member:${member.id}`;
    const previous = await getFromDb(stateKey, null);
    const stored = await getFromDb(`guild:${member.guild.id}:autonick_roles`, []);
    const configs = (Array.isArray(stored) ? stored : [])
      .filter(entry => entry && typeof entry.roleId === 'string')
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
    const active = configs.find(entry => member.roles.cache.has(entry.roleId));
    let base = typeof previous?.originalNickname === 'string'
      ? previous.originalNickname
      : (member.nickname ?? member.user.globalName ?? member.user.username);
    base = String(base).replace(/^\[AFK\]\s*/u, '').trimStart();
    for (const entry of configs) {
      for (const marker of [String(entry.tag || '').trim(), String(entry.prefix || '').trim()].filter(Boolean).sort((a,b)=>b.length-a.length)) {
        while (base.toLowerCase().startsWith(marker.toLowerCase())) {
          base = base.slice(marker.length).replace(/^[-_|:：\s]+/, '');
        }
      }
    }
    if (!base.trim()) base = member.user.globalName || member.user.username;
    let desired = base || null;
    if (active) {
      const template = typeof active.format === 'string' && active.format.includes('{username}')
        ? active.format : `${String(active.prefix || '').trim()} {username}`;
      const taggedTemplate = active.tag && !/\bTAG\b/i.test(template) ? `TAG ${template}` : template;
      desired = taggedTemplate.replace(/\bTAG\b/gi, String(active.tag || ''))
        .replace(/\{username\}/gi, base).replace(/\s+/g, ' ').trim().slice(0, 32);
      await setInDb(stateKey, { originalNickname: base, hadNickname: previous?.hadNickname ?? member.nickname != null, savedAt: previous?.savedAt || Date.now() });
    } else if (previous) {
      desired = previous.hadNickname === false ? null : (base || null);
      await bot.db?.delete?.(stateKey).catch(() => {});
    }
    if (member.nickname !== desired && member.manageable) {
      await member.setNickname(desired, 'Recalculate highest-priority AutoNick after clan tag edit');
    }
  };
  const loadDashboardClans = async guildId => {
    const [currentStored, legacyStored] = await Promise.all([
      getFromDb(clanStorageKey(guildId), []),
      getFromDb(legacyClanStorageKey(guildId), [])
    ]);
    const current = Array.isArray(currentStored) ? currentStored : [];
    const legacy = Array.isArray(legacyStored) ? legacyStored : [];
    const merged = [...current];
    for (const oldClan of legacy) {
      const exists = merged.some(clan =>
        String(clan.id || clan.roleId) === String(oldClan.id || oldClan.roleId) ||
        String(clan.roleId || '') === String(oldClan.roleId || oldClan.id)
      );
      if (!exists) merged.push(oldClan);
    }
    const normalized = merged.map(clan => ({
      ...clan,
      status: clan.status || 'approved',
      memberIds: Array.isArray(clan.memberIds) ? clan.memberIds : [],
      joinRequests: Array.isArray(clan.joinRequests) ? clan.joinRequests : []
    }));
    if (normalized.length) await setInDb(clanStorageKey(guildId), normalized);
    return normalized;
  };
  app.get('/api/dashboard/clans', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const clans = await loadDashboardClans(guild.id);
      const results = await Promise.all(clans.map(async clan => {
        const ids = [...new Set([clan.leaderId, clan.viceLeaderId, ...(Array.isArray(clan.memberIds) ? clan.memberIds : [])].filter(Boolean).map(String))];
        const members = await Promise.all(ids.map(async id => {
          const member = await guild.members.fetch(id).catch(() => null);
          if (!member) return null;
          const role = String(clan.roleId || clan.id || '');
          return { id: member.id, username: member.user.username, displayName: member.displayName || member.user.username,
            avatar: member.user.displayAvatarURL({ size: 64 }), isLeader: String(clan.leaderId) === member.id,
            isViceLeader: String(clan.viceLeaderId || '') === member.id,
            hasClanRole: role ? member.roles.cache.has(role) : false };
        }));
        const roster = members.filter(Boolean).sort((a,b) => Number(b.isLeader)-Number(a.isLeader) || Number(b.isViceLeader)-Number(a.isViceLeader) || a.displayName.localeCompare(b.displayName));
        return { ...clan, leaderName: roster.find(member => member.isLeader)?.displayName || clan.leaderName || clan.leaderId, members: roster, memberCount: roster.length };
      }));
      return res.json({ clans: results });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not load clans.' }); }
  });


  app.delete('/api/dashboard/clans/:clanId', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });

    const clanId = String(req.params.clanId || '');
    const mode = String(req.body?.mode || '');
    if (!['record', 'resources'].includes(mode)) return res.status(400).json({ error: 'Choose a valid clan deletion option.' });
    const me = guild.members.me;
    if (!me || !me.permissions.has(['ManageRoles', 'ManageChannels'])) {
      return res.status(403).json({ error: 'Barracks-Bot needs Manage Roles and Manage Channels permissions to delete a clan.' });
    }

    let clans;
    try { clans = await loadDashboardClans(guild.id); }
    catch { return res.status(500).json({ error: 'Could not read saved clan records.' }); }
    const index = clans.findIndex(c => String(c.roleId || c.id) === clanId);
    if (index < 0) return res.status(404).json({ error: 'Clan not found.' });
    const clan = clans[index];
    const role = guild.roles.cache.get(String(clan.roleId || clan.id));
    const category = guild.channels.cache.get(String(clan.categoryId));
    const channelIds = [clan.textChannelId, clan.voiceChannelId].filter(Boolean).map(String);
    const channels = channelIds.map(id => guild.channels.cache.get(id)).filter(Boolean);
    if (role && !role.editable) return res.status(403).json({ error: 'Barracks-Bot cannot manage this clan role. Move the bot role above the clan role.' });
    if (mode === 'resources') {
      if (category && !category.manageable) return res.status(403).json({ error: 'Barracks-Bot cannot manage the clan category. Check its role hierarchy and Manage Channels permission.' });
      if (channels.some(channel => !channel.manageable)) return res.status(403).json({ error: 'Barracks-Bot cannot manage one or more clan channels. Check its role hierarchy and Manage Channels permission.' });
    }

    const memberIds = new Set([
      ...(Array.isArray(clan.memberIds) ? clan.memberIds : []),
      clan.leaderId,
      clan.viceLeaderId
    ].filter(Boolean).map(String));
    if (role) for (const member of role.members.values()) memberIds.add(member.id);

    try {
      const members = await Promise.all([...memberIds].map(id => guild.members.fetch(id).catch(() => null)));
      for (const member of members.filter(Boolean)) {
        if (role && member.roles.cache.has(role.id)) {
          if (!member.manageable) throw new Error('Cannot remove the clan role from ' + member.user.tag + '. Move the bot role above that member and retry.');
          await member.roles.remove(role, 'Clan deleted from Barracks dashboard');
        }

        // Restore the pre-clan nickname saved by the AutoNick system.
        const stateKey = 'guild:' + guild.id + ':autonick_member:' + member.id;
        const nicknameState = await getFromDb(stateKey, null);
        const savedOrCurrentName = typeof nicknameState?.originalNickname === 'string'
          ? nicknameState.originalNickname
          : (member.nickname || member.user.globalName || member.user.username);
        const clanTagPrefix = String(clan.tag || '') + ' ';
        const originalName = savedOrCurrentName.startsWith(clanTagPrefix)
          ? savedOrCurrentName.slice(clanTagPrefix.length).trim()
          : savedOrCurrentName;
        const autoNickEntries = await getFromDb('guild:' + guild.id + ':autonick_roles', []);
        const remainingRules = (Array.isArray(autoNickEntries) ? autoNickEntries : [])
          .filter(entry => String(entry.roleId) !== String(role?.id || clan.roleId || clan.id));
        const activeRule = remainingRules
          .filter(entry => member.roles.cache.has(String(entry.roleId)))
          .sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0))[0];
        let restoredName = originalName;
        if (activeRule) {
          const template = typeof activeRule.format === 'string' && activeRule.format.includes('{username}')
            ? activeRule.format
            : `${String(activeRule.prefix || '').trim()} {username}`;
          restoredName = template
            .replace(/\bTAG\b/gi, String(activeRule.tag || ''))
            .replace(/\{username\}/gi, originalName)
            .replace(/\s+/g, ' ')
            .trim();
        }
        if (member.nickname !== restoredName) {
          await member.setNickname(restoredName.slice(0, 32) || null, 'Restore nickname after clan deletion');
        }
        await setInDb(stateKey, null);
      }

      for (const channel of [...channels, ...(category ? [category] : [])]) {
        for (const id of memberIds) {
          await channel.permissionOverwrites.delete(id, 'Clan deleted from Barracks dashboard').catch(() => {});
        }
      }

      if (mode === 'resources') {
        for (const channel of channels) {
          if (category && channel.parentId !== category.id) {
            throw new Error('A saved clan channel is no longer inside its recorded clan category. No unrelated channel was deleted.');
          }
          await channel.delete('Clan and Discord resources deleted from Barracks dashboard');
        }
        if (category) await category.delete('Clan and Discord resources deleted from Barracks dashboard');
        if (role) await role.delete('Clan and Discord resources deleted from Barracks dashboard');
      }

      // Remove the deleted clan role from AutoNick so /autonick list has no stale entry.
      const autoNickKey = 'guild:' + guild.id + ':autonick_roles';
      const autoNickEntries = await getFromDb(autoNickKey, []);
      await setInDb(
        autoNickKey,
        (Array.isArray(autoNickEntries) ? autoNickEntries : [])
          .filter(entry => String(entry.roleId) !== String(clan.roleId || clan.id)),
      );

      // Remove the clan from both registries. The dashboard loader merges the
      // legacy registry into the current one, so leaving a stale legacy record
      // would make a deleted clan reappear after the next dashboard refresh.
      clans.splice(index, 1);
      const legacyKey = legacyClanStorageKey(guild.id);
      const legacyClans = await getFromDb(legacyKey, []);
      const remainingLegacyClans = (Array.isArray(legacyClans) ? legacyClans : []).filter(oldClan =>
        String(oldClan.roleId || oldClan.id) !== clanId &&
        String(oldClan.id || oldClan.roleId) !== clanId
      );
      await Promise.all([
        setInDb(clanStorageKey(guild.id), clans),
        setInDb(legacyKey, remainingLegacyClans)
      ]);
      return res.json({
        ok: true,
        mode,
        deleted: { clan: true, role: mode === 'resources' && !!role, category: mode === 'resources' && !!category, channels: mode === 'resources' ? channels.length : 0 },
        keptDiscordResources: mode === 'record'
      });
    } catch (error) {
      return res.status(500).json({
        error: error?.message || 'Could not fully delete the clan. Check Discord permissions and inspect the clan resources before retrying.',
        partial: true
      });
    }
  });

  app.patch('/api/dashboard/clans/:clanId', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });

    const clanId = String(req.params.clanId || '');
    const name = String(req.body?.name || '').trim();
    const tag = String(req.body?.tag || '').trim().normalize('NFC').toUpperCase();
    const roleHexInput = String(req.body?.roleHex || '').trim();
    const roleHexMatch = roleHexInput.match(/^#?([0-9a-fA-F]{6})$/);
    const roleHex = roleHexMatch ? `#${roleHexMatch[1].toUpperCase()}` : null;
    const leaderId = String(req.body?.leaderId || '').trim();
    const viceLeaderId = String(req.body?.viceLeaderId || '').trim();
    const description = String(req.body?.description || '').trim();
    const rules = String(req.body?.rules || '').trim();
    if (!name || name.length > 60) return res.status(400).json({ error: 'Clan name must be between 1 and 60 characters.' });
    if (!tag) return res.status(400).json({ error: 'Please enter a Clan Tag.' });
    if (/<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>/.test(tag)) return res.status(400).json({ error: 'Use a Unicode emoji (such as ⚔️ or 🔥). Custom Discord server emojis cannot display in member nicknames.' });
    const autoNickFormat = 'TAG {username}';
    const fixedAutoNickFormat = 'TAG ⚔ ★ {username}';
    if (!roleHex) return res.status(400).json({ error: 'Role Hex Code must be a valid six-digit color, such as #5865F2.' });
    if (description.length > 300) return res.status(400).json({ error: 'Clan description must be 300 characters or fewer.' });
    if (rules.length > 1000) return res.status(400).json({ error: 'Clan Rules must be 1,000 characters or fewer.' });

    const me = guild.members.me;
    if (!me || !me.permissions.has('ManageRoles')) return res.status(403).json({ error: 'Barracks-Bot needs Manage Roles permission.' });
    let clans;
    try { clans = await loadDashboardClans(guild.id); }
    catch { return res.status(500).json({ error: 'Could not read saved clan records.' }); }
    const index = clans.findIndex(c => String(c.roleId || c.id) === clanId);
    if (index < 0) return res.status(404).json({ error: 'Clan not found.' });
    const current = clans[index];
    if (clans.some((c, i) => i !== index && String(c.tag).toUpperCase() === tag)) return res.status(409).json({ error: 'That clan tag is already in use.' });
    if (clans.some((c, i) => i !== index && String(c.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A clan with that name already exists.' });

    const role = guild.roles.cache.get(String(current.roleId || current.id));
    const category = current.categoryId ? guild.channels.cache.get(String(current.categoryId)) : null;
    const textChannel = current.textChannelId ? guild.channels.cache.get(String(current.textChannelId)) : null;
    const voiceChannel = current.voiceChannelId ? guild.channels.cache.get(String(current.voiceChannelId)) : null;
    if (!role) return res.status(409).json({ error: 'The clan role is missing from Discord. Restore the clan role before editing this clan.' });
    if (!role.editable || [category, textChannel, voiceChannel].some(channel => channel && !channel.manageable)) return res.status(403).json({ error: 'Barracks-Bot cannot edit this clan role or its existing channels. Check its role hierarchy and Manage Roles/Channels permissions.' });

    // Blank leader fields mean "keep the existing leaders" when editing other clan details.
    const effectiveLeaderId = leaderId || String(current.leaderId || '').trim();
    const effectiveViceLeaderId = viceLeaderId || String(current.viceLeaderId || '').trim();
    const leaderUnchanged = effectiveLeaderId === String(current.leaderId || '');
    const viceUnchanged = effectiveViceLeaderId === String(current.viceLeaderId || '');
    if (!leaderUnchanged && (!/^\\d{17,20}$/.test(effectiveLeaderId) || effectiveLeaderId === effectiveViceLeaderId)) {
      return res.status(400).json({ error: 'Enter a valid Discord ID for the new clan leader. It must be different from the vice clan leader.' });
    }
    if (!viceUnchanged && (!/^\\d{17,20}$/.test(effectiveViceLeaderId) || effectiveViceLeaderId === effectiveLeaderId)) {
      return res.status(400).json({ error: 'Enter a valid Discord ID for the new vice clan leader. It must be different from the clan leader.' });
    }
    const leader = effectiveLeaderId ? await guild.members.fetch(effectiveLeaderId).catch(() => null) : null;
    const viceLeader = effectiveViceLeaderId ? await guild.members.fetch(effectiveViceLeaderId).catch(() => null) : null;
    if (!leaderUnchanged && (!leader || leader.user.bot)) return res.status(404).json({ error: 'New clan leader must be a real member of Barracks.' });
    if (!viceUnchanged && (!viceLeader || viceLeader.user.bot)) return res.status(404).json({ error: 'New vice clan leader must be a real member of Barracks.' });
    if ((!leaderUnchanged && !leader.manageable) || (!viceUnchanged && !viceLeader.manageable)) return res.status(403).json({ error: 'Barracks-Bot cannot assign roles to one of these members. Move the bot role above their highest role.' });

    const oldLeader = leaderUnchanged ? null : await guild.members.fetch(String(current.leaderId)).catch(() => null);
    const oldVice = viceUnchanged ? null : await guild.members.fetch(String(current.viceLeaderId)).catch(() => null);
    const slug = (tag + '-' + name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 85) || 'clan';
    const voiceName = (tag + '-' + name + '-vc').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'clan-vc';
    try {
      await role.edit({ name: tag + ' ' + name, color: roleHex, reason: 'Clan details updated from Barracks dashboard' });
      const levelsRole = await guild.roles.fetch('1564159581825933353').catch(() => null);
      if (levelsRole && role.editable) await role.setPosition(levelsRole.position + 1, { reason: 'Keep Barracks clan roles above the Levels separator' });
      if (category) await category.edit({ name: tag + ' | ' + name, reason: 'Clan details updated from Barracks dashboard' });
      if (textChannel) await textChannel.edit({ name: slug + '-chat', reason: 'Clan details updated from Barracks dashboard' });
      if (voiceChannel) await voiceChannel.edit({ name: voiceName, reason: 'Clan details updated from Barracks dashboard' });

      if (!leaderUnchanged && oldLeader) {
        await Promise.all([
          category?.permissionOverwrites.delete(oldLeader.id).catch(() => {}),
          textChannel?.permissionOverwrites.delete(oldLeader.id).catch(() => {}),
          voiceChannel?.permissionOverwrites.delete(oldLeader.id).catch(() => {}),
          oldLeader.roles.remove(role, 'Clan leader changed in Barracks dashboard').catch(() => {})
        ]);
      }
      if (!viceUnchanged && oldVice) {
        await Promise.all([
          category?.permissionOverwrites.delete(oldVice.id).catch(() => {}),
          textChannel?.permissionOverwrites.delete(oldVice.id).catch(() => {}),
          voiceChannel?.permissionOverwrites.delete(oldVice.id).catch(() => {}),
          oldVice.roles.remove(role, 'Vice clan leader changed in Barracks dashboard').catch(() => {})
        ]);
      }
      for (const member of [leader, viceLeader].filter(Boolean)) {
        await Promise.all([
          category?.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, Connect: true, Speak: true }),
          textChannel?.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }),
          voiceChannel?.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true, Speak: true })
        ].filter(Boolean));
        if ((!leaderUnchanged && member.id === leader.id) || (!viceUnchanged && member.id === viceLeader.id)) {
          await member.roles.add(role, 'Assigned as clan leadership by Barracks dashboard');
        }
      }
      const updated = { ...current, name, tag, roleHex, rules, description, leaderId: effectiveLeaderId, leaderName: leader?.displayName || current.leaderName || effectiveLeaderId, viceLeaderId: effectiveViceLeaderId, viceLeaderName: viceLeader?.displayName || current.viceLeaderName || effectiveViceLeaderId, updatedAt: new Date().toISOString() };
      clans[index] = updated;
      await setInDb(clanStorageKey(guild.id), clans);

      // Clan Edit changes clan metadata only. AutoNick rules stay independent
      // so staff can manually edit the clan tag in the AutoNick dashboard.

      return res.json({ ok: true, clan: updated });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not update the clan. Check the bot permissions and try again.' });
    }
  });

  const tournamentKey = guildId => `guild:${guildId}:tournaments`;
  const readTournaments = async guildId => {
    const value = await getFromDb(tournamentKey(guildId), []);
    return Array.isArray(value) ? value : [];
  };
  const tournamentEmbed = tournament => {
    const embed = new EmbedBuilder().setColor(/^#[0-9a-f]{6}$/i.test(tournament.color || '') ? tournament.color : '#C3F36B')
      .setTitle('🏆 ' + tournament.name);
    if (tournament.author) embed.setAuthor({ name: tournament.author, ...(tournament.authorIcon ? { iconURL: tournament.authorIcon } : {}) });
    const details = [
      tournament.description || 'Join the competition and prove your skills!',
      '**Game:** ' + tournament.game,
      '**Date:** ' + new Date(tournament.date).toLocaleString(),
      '**Format:** ' + tournament.format,
      '**Players:** ' + (tournament.registrations?.length || 0) + ' / ' + tournament.limit,
      '**Registration:** ' + (tournament.status === 'registration' ? 'OPEN' : tournament.status.toUpperCase())
    ];
    if (tournament.deadline) details.push('**Registration Deadline:** ' + new Date(tournament.deadline).toLocaleString());
    if (tournament.prizePool) details.push('**Prize Pool:** ' + tournament.prizePool);
    if (tournament.entryFee) details.push('**Entry Fee:** ' + tournament.entryFee);
    if (tournament.organizer) details.push('**Organizer:** ' + tournament.organizer);
    if (tournament.waitlist && (tournament.registrations?.length || 0) >= tournament.limit) details.push('**Waitlist:** ' + (tournament.waitlistEntries?.length || 0) + ' waiting');
    embed.setDescription(details.join('\n'));
    if (tournament.thumbnail) embed.setThumbnail(tournament.thumbnail);
    if (tournament.image) embed.setImage(tournament.image);
    const fields = String(tournament.fields || '').split('\n').map(line => line.split('|').map(v => v.trim())).filter(pair => pair.length >= 2 && pair[0] && pair[1]).slice(0, 20);
    for (const [name, value] of fields) embed.addFields({ name: name.slice(0, 256), value: value.slice(0, 1024), inline: true });
    if (tournament.rules && tournament.showRules !== false) embed.addFields({ name: '📜 Tournament Rules', value: tournament.rules.slice(0, 1024) });
    if (tournament.footer) embed.setFooter({ text: tournament.footer, ...(tournament.footerIcon ? { iconURL: tournament.footerIcon } : {}) });
    if (tournament.timestamp !== false) embed.setTimestamp(new Date());
    return embed;
  };
  const tournamentComponents = tournament => {
    const buttons = [];
    if (tournament.teamMode) {
      buttons.push(new ButtonBuilder().setCustomId('tournament:teamcreate:' + tournament.id).setLabel('Create Team').setEmoji('🛡️').setStyle(ButtonStyle.Success).setDisabled(tournament.status !== 'registration'));
      buttons.push(new ButtonBuilder().setCustomId('tournament:teaminvite:' + tournament.id).setLabel('Invite Player').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(tournament.status !== 'registration'));
      buttons.push(new ButtonBuilder().setCustomId('tournament:teamleave:' + tournament.id).setLabel('Leave Team').setEmoji('🚪').setStyle(ButtonStyle.Danger));
    } else if (tournament.showJoin !== false) buttons.push(new ButtonBuilder().setCustomId('tournament:join:' + tournament.id).setLabel('Join Tournament').setEmoji('🏆').setStyle(ButtonStyle.Success).setDisabled(tournament.status !== 'registration' || (tournament.registrations?.length || 0) >= tournament.limit));
    if (tournament.showParticipants !== false) buttons.push(new ButtonBuilder().setCustomId('tournament:participants:' + tournament.id).setLabel('Participants').setEmoji('👥').setStyle(ButtonStyle.Secondary));
    if (tournament.showRules) buttons.push(new ButtonBuilder().setCustomId('tournament:rules:' + tournament.id).setLabel('Rules').setEmoji('📜').setStyle(ButtonStyle.Secondary));
    if (tournament.showCheckin) buttons.push(new ButtonBuilder().setCustomId('tournament:checkin:' + tournament.id).setLabel('Check-in').setEmoji('🎟️').setStyle(ButtonStyle.Primary).setDisabled(tournament.status !== 'live'));
    if (tournament.showLeave) buttons.push(new ButtonBuilder().setCustomId('tournament:leave:' + tournament.id).setLabel('Leave').setEmoji('❌').setStyle(ButtonStyle.Danger));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return rows;
  };

  const scheduledMessagesKey = guildId => 'guild:' + guildId + ':dashboard:scheduled-messages';
  async function processScheduledMessages() {
    if (bot.__scheduledMessageProcessing) return;
    bot.__scheduledMessageProcessing = true;
    try {
      const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
      if (!guild || !bot.db?.get || !bot.db?.set) return;
      const key = scheduledMessagesKey(guild.id);
      const items = await bot.db.get(key, []);
      if (!Array.isArray(items)) return;
      const now = Date.now();
      const resolveTemplate = (value, guild, channel, date = new Date()) => {
        const values = {
          server: guild.name || 'Barracks', 'server.id': guild.id,
          channel: channel.name || 'channel', 'channel.id': channel.id,
          memberCount: String(guild.memberCount ?? guild.members?.cache?.size ?? 0),
          date: date.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric' }),
          time: date.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }),
          timestamp: '<t:' + Math.floor(date.getTime() / 1000) + ':F>'
        };
        return String(value ?? '').replace(/\{(server(?:\.id)?|channel(?:\.id)?|memberCount|date|time|timestamp)\}/g, (token, key) => values[key] ?? token);
      };
      const resolveEmbedTemplate = (embed, guild, channel, date) => {
        if (!embed || typeof embed !== 'object') return embed;
        const walk = value => {
          if (typeof value === 'string') return resolveTemplate(value, guild, channel, date);
          if (Array.isArray(value)) return value.map(walk);
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
          return value;
        };
        return walk(JSON.parse(JSON.stringify(embed)));
      };
      let changed = false;
      for (const item of items) {
        if (item.status !== 'active' || Date.parse(item.runAt) > now) continue;
        let sentAny = false;
        for (const channelId of item.channelIds || []) {
          const channel = await guild.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased?.() || channel.isThread?.() || typeof channel.send !== 'function') continue;
          try {
            const payload = { allowedMentions: { parse: [] } };
            const sendAt = new Date(now);
            if (item.content) payload.content = resolveTemplate(item.content, guild, channel, sendAt);
            if (Array.isArray(item.embeds) && item.embeds.length) payload.embeds = item.embeds.map(embed => resolveEmbedTemplate(embed, guild, channel, sendAt));
            await channel.send(payload);
            sentAny = true;
          } catch (error) {
            console.warn('[MESSAGE_SCHEDULE] Send failed in channel ' + channelId + ': ' + (error?.message || error));
          }
        }
        item.lastRunAt = new Date(now).toISOString();
        item.lastRunOk = sentAny;
        changed = true;
        if (item.repeat === 'daily' || item.repeat === 'weekly') {
          const next = new Date(item.runAt);
          const intervalDays = item.repeat === 'daily' ? 1 : 7;
          do { next.setUTCDate(next.getUTCDate() + intervalDays); } while (next.getTime() <= now);
          if (item.repeatUntil && next.toISOString().slice(0, 10) > item.repeatUntil) item.status = 'completed';
          else item.runAt = next.toISOString();
        } else item.status = 'completed';
      }
      if (changed) await bot.db.set(key, items);
    } catch (error) {
      console.error('[MESSAGE_SCHEDULE] Processor error:', error?.message || error);
    } finally {
      bot.__scheduledMessageProcessing = false;
    }
  }
  if (!bot.__scheduledMessageCronStarted) {
    bot.__scheduledMessageCronStarted = true;
    cron.schedule('* * * * *', processScheduledMessages, { timezone: 'Asia/Manila' });
    setTimeout(processScheduledMessages, 5000);
  }

  app.get('/api/dashboard/scheduled-messages', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const items = await bot.db.get(scheduledMessagesKey(guild.id), []);
    return res.json({ messages: Array.isArray(items) ? items : [] });
  });

  app.post('/api/dashboard/scheduled-messages', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const body = req.body || {};
    const channelIds = [...new Set((Array.isArray(body.channelIds) ? body.channelIds : []).map(String))];
    const runAt = Date.parse(body.runAt);
    const repeat = String(body.repeat || 'none');
    if (!channelIds.length || channelIds.length > 20 || !Number.isFinite(runAt) || runAt <= Date.now() ||
        !['none', 'daily', 'weekly'].includes(repeat) || (body.repeatUntil && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.repeatUntil)))) {
      return res.status(400).json({ error: 'Choose channels, a future date/time, and a valid repeat option.' });
    }
    const content = String(body.content || '');
    const embeds = Array.isArray(body.embeds) ? body.embeds.slice(0, 1) : [];
    if (content.length > 2000 || (!content.trim() && !embeds.length)) return res.status(400).json({ error: 'Add message content (maximum 2,000 characters).' });
    for (const channelId of channelIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased?.() || channel.isThread?.() || typeof channel.send !== 'function') return res.status(400).json({ error: 'One or more selected channels are invalid.' });
    }
    const item = { id: crypto.randomUUID(), channelIds, content, embeds, runAt: new Date(runAt).toISOString(), repeat, repeatUntil: body.repeatUntil || null, status: 'active', createdAt: new Date().toISOString() };
    const key = scheduledMessagesKey(guild.id), items = await bot.db.get(key, []);
    const list = Array.isArray(items) ? items : [];
    if (list.filter(x => x.status === 'active').length >= 100) return res.status(400).json({ error: 'Maximum 100 active scheduled messages reached.' });
    list.push(item);
    await bot.db.set(key, list);
    return res.status(201).json({ ok: true, message: item });
  });

  app.put('/api/dashboard/scheduled-messages/:id', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const body = req.body || {}, key = scheduledMessagesKey(guild.id);
    const items = await bot.db.get(key, []), list = Array.isArray(items) ? items : [];
    const item = list.find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Scheduled message not found.' });
    const channelIds = [...new Set((Array.isArray(body.channelIds) ? body.channelIds : []).map(String))];
    const runAt = Date.parse(body.runAt), repeat = String(body.repeat || 'none');
    if (!channelIds.length || channelIds.length > 20 || !Number.isFinite(runAt) || runAt <= Date.now() ||
        !['daily', 'weekly'].includes(repeat) || (body.repeatUntil && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.repeatUntil)))) {
      return res.status(400).json({ error: 'Choose channels, a future date/time, and a valid recurring option.' });
    }
    const content = String(body.content || ''), embeds = Array.isArray(body.embeds) ? body.embeds.slice(0, 1) : [];
    if (content.length > 2000 || (!content.trim() && !embeds.length)) return res.status(400).json({ error: 'Add message content (maximum 2,000 characters).' });
    for (const channelId of channelIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased?.() || channel.isThread?.() || typeof channel.send !== 'function') return res.status(400).json({ error: 'One or more selected channels are invalid.' });
    }
    Object.assign(item, { channelIds, content, embeds, runAt: new Date(runAt).toISOString(), repeat, repeatUntil: body.repeatUntil || null, status: item.status === 'paused' ? 'paused' : 'active' });
    await bot.db.set(key, list);
    return res.json({ ok: true, message: item });
  });

  app.patch('/api/dashboard/scheduled-messages/:id', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const key = scheduledMessagesKey(guild.id), items = await bot.db.get(key, []);
    const list = Array.isArray(items) ? items : [], item = list.find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Scheduled message not found.' });
    const status = String(req.body?.status || '');
    if (!['active', 'paused'].includes(status) || !['daily', 'weekly'].includes(item.repeat)) return res.status(400).json({ error: 'Invalid recurring message status.' });
    if (status === 'active' && Date.parse(item.runAt) <= Date.now()) {
      const next = new Date(item.runAt), days = item.repeat === 'daily' ? 1 : 7;
      do { next.setUTCDate(next.getUTCDate() + days); } while (next.getTime() <= Date.now());
      item.runAt = next.toISOString();
    }
    item.status = status;
    await bot.db.set(key, list);
    return res.json({ ok: true, message: item });
  });

  app.delete('/api/dashboard/scheduled-messages/:id', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const key = scheduledMessagesKey(guild.id), items = await bot.db.get(key, []);
    const list = Array.isArray(items) ? items : [];
    const item = list.find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Scheduled message not found.' });
    item.status = 'cancelled';
    await bot.db.set(key, list);
    return res.json({ ok: true });
  });

  const messageBuilderDraftKey = guildId => 'guild:' + guildId + ':dashboard:message-builder-draft';
  app.get('/api/dashboard/message-builder-draft', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    return res.json({ draft: await bot.db.get(messageBuilderDraftKey(guild.id), null) });
  });
  app.put('/api/dashboard/message-builder-draft', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const body = req.body || {};
    const draft = {
      content: String(body.content || '').slice(0, 2000), title: String(body.title || '').slice(0, 256),
      description: String(body.description || '').slice(0, 4096), author: String(body.author || '').slice(0, 256),
      color: /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? String(body.color).toLowerCase() : '#c3f36b',
      thumbnail: String(body.thumbnail || '').slice(0, 500), image: String(body.image || '').slice(0, 500),
      footer: String(body.footer || '').slice(0, 2048), footerIcon: String(body.footerIcon || '').slice(0, 500),
      timestamp: !!body.timestamp, channelIds: [...new Set((Array.isArray(body.channelIds) ? body.channelIds : []).map(String))].slice(0, 20),
      mode: ['now', 'schedule', 'recurring'].includes(body.mode) ? body.mode : 'now',
      scheduleAt: String(body.scheduleAt || '').slice(0, 40), repeat: ['daily', 'weekly'].includes(body.repeat) ? body.repeat : 'daily',
      repeatUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(body.repeatUntil || '')) ? String(body.repeatUntil) : ''
    };
    await bot.db.set(messageBuilderDraftKey(guild.id), draft);
    return res.json({ ok: true, draft });
  });

  app.get('/api/dashboard/message-channels', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const channels = guild.channels.cache
      .filter(channel => channel.isTextBased?.() && !channel.isThread?.() && typeof channel.send === 'function')
      .map(channel => ({ id: channel.id, name: channel.name, category: channel.parent?.name || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ channels });
  });

  app.post('/api/dashboard/send-message', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const channelIds = [...new Set((Array.isArray(req.body?.channelIds) ? req.body.channelIds : []).map(id => String(id)))];
    const content = String(req.body?.content || '');
    const rawEmbed = Array.isArray(req.body?.embeds) ? req.body.embeds[0] : null;
    if (!channelIds.length || channelIds.length > 20) return res.status(400).json({ error: 'Select between 1 and 20 channels.' });
    if (content.length > 2000) return res.status(400).json({ error: 'Message text must be 2,000 characters or fewer.' });
    if (!content.trim() && !rawEmbed) return res.status(400).json({ error: 'Add message text or embed content first.' });
    const validUrl = value => { if (!value) return true; try { return ['http:', 'https:'].includes(new URL(String(value)).protocol); } catch { return false; } };
    if (rawEmbed && ((rawEmbed.title && String(rawEmbed.title).length > 256) ||
      (rawEmbed.description && String(rawEmbed.description).length > 4096) ||
      (rawEmbed.author?.name && String(rawEmbed.author.name).length > 256) ||
      (rawEmbed.footer?.text && String(rawEmbed.footer.text).length > 2048) ||
      !validUrl(rawEmbed.image?.url) || !validUrl(rawEmbed.thumbnail?.url))) {
      return res.status(400).json({ error: 'Check embed text lengths and image URLs.' });
    }
    const resolveMessageBuilderVariables = (value, guild, channel, date = new Date()) => {
      const values = {
        server: guild.name || 'Barracks',
        'server.id': guild.id,
        channel: channel.name || 'channel',
        'channel.id': channel.id,
        memberCount: String(guild.memberCount ?? guild.members?.cache?.size ?? 0),
        date: date.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric' }),
        time: date.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }),
        timestamp: '<t:' + Math.floor(date.getTime() / 1000) + ':F>'
      };
      return String(value ?? '').replace(/\{(server(?:\.id)?|channel(?:\.id)?|memberCount|date|time|timestamp)\}/g, (token, key) => values[key] ?? token);
    };
    const resolveMessageBuilderEmbed = (embed, guild, channel, date) => {
      if (!embed || typeof embed !== 'object') return embed;
      const clone = JSON.parse(JSON.stringify(embed));
      const walk = value => {
        if (typeof value === 'string') return resolveMessageBuilderVariables(value, guild, channel, date);
        if (Array.isArray(value)) return value.map(walk);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
        return value;
      };
      return walk(clone);
    };
    const results = [];
    for (const channelId of channelIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased?.() || channel.isThread?.() || typeof channel.send !== 'function') {
        results.push({ channelId, ok: false, error: 'Invalid text channel.' });
        continue;
      }
      try {
        const sentAt = new Date();
        const payload = { allowedMentions: { parse: [] } };
        if (content) payload.content = resolveMessageBuilderVariables(content, guild, channel, sentAt);
        if (rawEmbed) payload.embeds = [resolveMessageBuilderEmbed(rawEmbed, guild, channel, sentAt)];
        const message = await channel.send(payload);
        results.push({ channelId, channelName: channel.name, ok: true, messageId: message.id });
      } catch (error) {
        results.push({ channelId, channelName: channel.name, ok: false, error: error?.message || 'Send failed.' });
      }
    }
    return res.json({ ok: results.every(result => result.ok), results });
  });

  app.get('/api/dashboard/tournaments', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try { return res.json({ tournaments: await readTournaments(guild.id) }); }
    catch (error) { return res.status(500).json({ error: error?.message || 'Could not load tournaments.' }); }
  });

  app.post('/api/dashboard/tournaments', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const body = req.body || {};
    const id = String(body.id || '').trim(), name = String(body.name || '').trim(), game = String(body.game || '').trim();
    const date = String(body.date || '').trim(), format = String(body.format || 'Single Elimination').trim();
    const channelId = String(body.channelId || '').trim(), limit = Number(body.limit), status = String(body.status || 'registration');
    const urls = ['authorIcon', 'thumbnail', 'image', 'footerIcon'];
    if (!name || name.length > 80 || !game || game.length > 50 || !Number.isFinite(Date.parse(date)) ||
      !/^\d{17,20}$/.test(channelId) || !Number.isInteger(limit) || limit < 2 || limit > 512 ||
      !['registration', 'live', 'completed', 'cancelled'].includes(status) ||
      (body.deadline && !Number.isFinite(Date.parse(body.deadline))) ||
      urls.some(key => body[key] && !/^https:\/\//i.test(String(body[key]))) ||
      (body.color && !/^#[0-9a-f]{6}$/i.test(body.color))) {
      return res.status(400).json({ error: 'Check tournament details, URLs, color, channel ID, player limit, and status.' });
    }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !channel.send) return res.status(404).json({ error: 'That Discord text channel was not found or cannot receive messages.' });
    try {
      const all = await readTournaments(guild.id), existingIndex = id ? all.findIndex(item => item.id === id) : -1;
      if (id && existingIndex < 0) return res.status(404).json({ error: 'Tournament not found.' });
      const previous = existingIndex >= 0 ? all[existingIndex] : null;
      const tournament = {
        ...previous, id: previous?.id || crypto.randomUUID(), name, game, date, format, limit, status, channelId,
        color: body.color || '#C3F36B', author: String(body.author || '').slice(0,256), authorIcon: String(body.authorIcon || ''),
        description: String(body.description || '').slice(0,3500), thumbnail: String(body.thumbnail || ''), image: String(body.image || ''),
        footer: String(body.footer || 'BARRACKS • TOURNAMENTS').slice(0,2048), footerIcon: String(body.footerIcon || ''),
        prizePool: String(body.prizePool || '').slice(0,100), entryFee: String(body.entryFee || '').slice(0,100),
        organizer: String(body.organizer || '').slice(0,100), deadline: body.deadline || null, rules: String(body.rules || '').slice(0,3000),
        fields: String(body.fields || '').slice(0,8000), showJoin: body.showJoin !== false, showParticipants: body.showParticipants !== false,
        showRules: body.showRules === true, showCheckin: body.showCheckin === true, showLeave: body.showLeave === true,
        waitlist: body.waitlist === true, teamMode: body.teamMode === true, teamMinPlayers: Number(body.teamMinPlayers || 1), teamMaxPlayers: Number(body.teamMaxPlayers || 5), teams: Array.isArray(previous?.teams) ? previous.teams : [], timestamp: body.timestamp !== false,
        registrations: Array.isArray(previous?.registrations) ? previous.registrations : [],
        waitlistEntries: Array.isArray(previous?.waitlistEntries) ? previous.waitlistEntries : [],
        checkedIn: Array.isArray(previous?.checkedIn) ? previous.checkedIn : [],
        messageId: previous?.messageId || null, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      if (tournament.registrations.length > limit) return res.status(409).json({ error: 'Player limit cannot be lower than the current registered player count.' });
      if (tournament.teamMode && (!Number.isInteger(tournament.teamMinPlayers) || !Number.isInteger(tournament.teamMaxPlayers) || tournament.teamMinPlayers < 1 || tournament.teamMaxPlayers < tournament.teamMinPlayers || tournament.teamMaxPlayers > 32)) return res.status(400).json({ error: 'Team size must be between 1 and 32 players, with maximum at least minimum.' });
      if (tournament.teamMode && tournament.teams.some(team => 1 + (team.members || []).length > tournament.teamMaxPlayers)) return res.status(409).json({ error: 'Maximum team size cannot be lower than an existing team roster.' });
      let message = tournament.messageId && previous.channelId === channelId ? await channel.messages.fetch(tournament.messageId).catch(() => null) : null;
      if (message) await message.edit({ embeds: [tournamentEmbed(tournament)], components: tournamentComponents(tournament) });
      else {
        if (tournament.messageId && previous.channelId !== channelId) {
          const oldChannel = await guild.channels.fetch(previous.channelId).catch(() => null);
          const oldMessage = oldChannel?.messages ? await oldChannel.messages.fetch(tournament.messageId).catch(() => null) : null;
          if (oldMessage) await oldMessage.delete().catch(() => {});
        }
        message = await channel.send({ embeds: [tournamentEmbed(tournament)], components: tournamentComponents(tournament) });
        tournament.messageId = message.id;
      }
      if (existingIndex >= 0) all[existingIndex] = tournament; else all.unshift(tournament);
      await setInDb(tournamentKey(guild.id), all);
      return res.json({ ok: true, tournament });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not post or save the tournament.' }); }
  });


  app.post('/api/dashboard/tournaments/:id/bracket', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const all = await readTournaments(guild.id), tournament = all.find(item => item.id === req.params.id);
      if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
      const body = req.body || {};
      if (body.action === 'generate') {
        if (tournament.status !== 'live') return res.status(409).json({ error: 'Set the tournament status to Live after registration closes before generating the bracket.' });
        if (tournament.bracket?.rounds?.length) return res.status(409).json({ error: 'A bracket has already been generated for this tournament.' });
        const participants = tournament.teamMode
          ? (tournament.teams || []).map(team => ({ id: String(team.id || team.captainId), name: String(team.name || 'Team'), rosterSize: 1 + (team.members || []).length }))
          : (tournament.registrations || []).map(player => ({ id: String(player.userId), name: String(player.username || player.userId) }));
        if (participants.length < 2) return res.status(400).json({ error: 'At least two registered teams or players are required to generate a bracket.' });
        if (tournament.teamMode && participants.some(team => team.rosterSize < Number(tournament.teamMinPlayers || 1))) return res.status(400).json({ error: 'Every registered team must meet the minimum team size before bracket generation.' });
        if (tournament.bracket?.rounds?.some(round => round.some(match => match.status === 'completed'))) return res.status(409).json({ error: 'This bracket already has completed matches. Reset it only after the tournament has been reviewed.' });
        const size = 2 ** Math.ceil(Math.log2(participants.length));
        const slots = participants.concat(Array(size - participants.length).fill(null));
        const rounds = [];
        let count = size / 2, roundIndex = 0;
        while (count >= 1) {
          const round = [];
          for (let i = 0; i < count; i++) {
            const m = { id: 'r' + (roundIndex + 1) + 'm' + (i + 1), round: roundIndex + 1, match: i + 1, team1: roundIndex === 0 ? slots[i * 2] : null, team2: roundIndex === 0 ? slots[i * 2 + 1] : null, winnerId: null, status: 'pending' };
            if (roundIndex > 0) m.sourceMatchIds = ['r' + roundIndex + 'm' + (i * 2 + 1), 'r' + roundIndex + 'm' + (i * 2 + 2)];
            round.push(m);
          }
          rounds.push(round); count /= 2; roundIndex++;
        }
        const bracket = { format: 'Single Elimination', generatedAt: new Date().toISOString(), roundNames: rounds.map((r,i)=>i===rounds.length-1?'Grand Final':i===rounds.length-2&&rounds.length>2?'Semifinals':i===rounds.length-3&&rounds.length>3?'Quarterfinals':'Round '+(i+1)), rounds, championId: null, championName: null };
        const lookup = new Map(rounds.flat().map(m=>[m.id,m]));
        for (const match of rounds[0]) {
          if (match.team1 && !match.team2) { match.winnerId=match.team1.id; match.status='bye'; }
          else if (!match.team1 && match.team2) { match.winnerId=match.team2.id; match.status='bye'; }
          else if (!match.team1 && !match.team2) match.status='empty';
        }
        const advance = (fromRound) => {
          for (let ri=fromRound+1;ri<rounds.length;ri++) {
            for (const match of rounds[ri]) {
              const sources=match.sourceMatchIds.map(id=>lookup.get(id));
              if (!sources.every(source=>source && source.status!=='pending')) continue;
              match.team1=sources[0].winnerId?sources[0].team1?.id===sources[0].winnerId?sources[0].team1:sources[0].team2:null;
              match.team2=sources[1].winnerId?sources[1].team1?.id===sources[1].winnerId?sources[1].team1:sources[1].team2:null;
              if (match.team1&&!match.team2) {match.winnerId=match.team1.id;match.status='bye';}
              else if (!match.team1&&match.team2) {match.winnerId=match.team2.id;match.status='bye';}
              else if (!match.team1&&!match.team2) {match.winnerId=null;match.status='empty';}
              else {match.winnerId=null;match.status='pending';}
            }
          }
        };
        advance(0);
        const final=rounds[rounds.length-1][0];
        if (final?.winnerId) { const w=final.team1?.id===final.winnerId?final.team1:final.team2;bracket.championId=w?.id||null;bracket.championName=w?.name||null; }
        tournament.bracket=bracket;
        tournament.updatedAt=new Date().toISOString();
        all[all.findIndex(item=>item.id===tournament.id)]=tournament;
        await setInDb(tournamentKey(guild.id),all);
        return res.json({ok:true,bracket,tournament});
      }
      if (body.action === 'result') {
        const bracket=tournament.bracket;
        if (!bracket?.rounds?.length) return res.status(400).json({error:'Generate the bracket before recording match results.'});
        const match=bracket.rounds.flat().find(item=>item.id===String(body.matchId||''));
        if (!match || match.status!=='pending' || !match.team1 || !match.team2) return res.status(409).json({error:'This match is not ready for a result.'});
        const winnerId=String(body.winnerId||'');
        if (![match.team1.id,match.team2.id].includes(winnerId)) return res.status(400).json({error:'Winner must be one of the teams or players in this match.'});
        match.winnerId=winnerId;match.status='completed';match.completedAt=new Date().toISOString();
        const lookup=new Map(bracket.rounds.flat().map(item=>[item.id,item]));
        for(let ri=1;ri<bracket.rounds.length;ri++){
          for(const next of bracket.rounds[ri]){
            const sources=(next.sourceMatchIds||[]).map(id=>lookup.get(id));
            if(!sources.length||!sources.every(source=>source&&source.status!=='pending'))continue;
            const teamFor=source=>source.winnerId?(source.team1?.id===source.winnerId?source.team1:source.team2):null;
            next.team1=teamFor(sources[0]);next.team2=teamFor(sources[1]);next.winnerId=null;
            if(next.team1&&!next.team2){next.winnerId=next.team1.id;next.status='bye';}
            else if(!next.team1&&next.team2){next.winnerId=next.team2.id;next.status='bye';}
            else if(!next.team1&&!next.team2)next.status='empty';
            else next.status='pending';
          }
        }
        const final=bracket.rounds[bracket.rounds.length-1][0];
        if(final?.status==='completed'&&final.winnerId){const w=final.team1?.id===final.winnerId?final.team1:final.team2;bracket.championId=w?.id||null;bracket.championName=w?.name||null;tournament.status='completed';}
        bracket.updatedAt=new Date().toISOString();tournament.updatedAt=bracket.updatedAt;
        all[all.findIndex(item=>item.id===tournament.id)]=tournament;
        await setInDb(tournamentKey(guild.id),all);
        return res.json({ok:true,bracket,tournament});
      }
      return res.status(400).json({error:'Unsupported bracket action.'});
    } catch (error) { return res.status(500).json({error:error?.message||'Could not update tournament bracket.'}); }
  });

  app.delete('/api/dashboard/tournaments/:id', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    try {
      const all = await readTournaments(guild.id), item = all.find(t => t.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Tournament not found.' });
      if (item.messageId && item.channelId) {
        const channel = await guild.channels.fetch(item.channelId).catch(() => null);
        const message = channel?.messages ? await channel.messages.fetch(item.messageId).catch(() => null) : null;
        if (message) await message.delete().catch(() => {});
      }
      await setInDb(tournamentKey(guild.id), all.filter(t => t.id !== item.id));
      return res.json({ ok: true });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not delete tournament.' }); }
  });

  app.post('/api/dashboard/clans', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const name = String(req.body?.name || '').trim(), tag = String(req.body?.tag || '').trim().normalize('NFC').toUpperCase();
    const leaderId = String(req.body?.leaderId || '').trim(), viceLeaderId = String(req.body?.viceLeaderId || '').trim(), description = String(req.body?.description || '').trim();
    const roleHexInput = String(req.body?.roleHex || '').trim();
    const roleHexMatch = roleHexInput.match(/^#?([0-9a-fA-F]{6})$/);
    const roleHex = roleHexMatch ? `#${roleHexMatch[1].toUpperCase()}` : null;
    if (!name || name.length > 60) return res.status(400).json({ error: 'Clan name must be between 1 and 60 characters.' });
    if (!tag) return res.status(400).json({ error: 'Please enter a Clan Tag.' });
    if (/<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>/.test(tag)) return res.status(400).json({ error: 'Use a Unicode emoji (such as ⚔️ or 🔥). Custom Discord server emojis cannot display in member nicknames.' });
    const autoNickFormat = 'TAG {username}';
    if (!/^\d{17,20}$/.test(leaderId)) return res.status(400).json({ error: 'Enter a valid Discord user ID for the clan leader.' });
    if (description.length > 300) return res.status(400).json({ error: 'Clan description must be 300 characters or fewer.' });
    const me = guild.members.me;
    if (!me || !me.permissions.has(['ManageRoles', 'ManageChannels'])) return res.status(403).json({ error: 'Barracks-Bot needs Manage Roles and Manage Channels permissions.' });
    const leader = await guild.members.fetch(leaderId).catch(() => null);
    if (!leader || leader.user.bot) return res.status(404).json({ error: 'Clan leader must be a real member of Barracks.' });
    if (!leader.manageable) return res.status(403).json({ error: 'Barracks-Bot cannot assign roles to this member. Move the bot role above the leader’s highest role.' });
    if (!/^\d{17,20}$/.test(viceLeaderId) || viceLeaderId === leaderId) return res.status(400).json({ error: 'A valid vice clan leader Discord ID is required and must be different from the clan leader.' });
    const viceLeader = await guild.members.fetch(viceLeaderId).catch(() => null);
    if (!viceLeader || viceLeader.user.bot) return res.status(404).json({ error: 'Vice clan leader must be a real member of Barracks.' });
    if (!viceLeader.manageable) return res.status(403).json({ error: 'Barracks-Bot cannot assign roles to the vice leader. Move the bot role above their highest role.' });
    let clans;
    try { clans = await loadDashboardClans(guild.id); }
    catch { return res.status(500).json({ error: 'Could not read saved clan records.' }); }
    if (clans.some(c => String(c.tag).toUpperCase() === tag)) return res.status(409).json({ error: 'That clan tag is already in use.' });
    if (clans.some(c => String(c.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A clan with that name already exists.' });
    let role = null;
    let voiceChannel = null;
    try {
      role = await guild.roles.create({ name: tag + ' ' + name, color: roleHex, hoist: true, mentionable: false, reason: 'Clan created from Barracks dashboard' });
      await registerClanAutoNick(guild, role, tag, autoNickFormat);
      const clanVoiceCategoryId = '1574641736695816334';
      const clanVoiceCategory = await guild.channels.fetch(clanVoiceCategoryId);
      if (!clanVoiceCategory || clanVoiceCategory.type !== ChannelType.GuildCategory) {
        throw new Error('The configured clan voice category was not found or is not a category.');
      }
      voiceChannel = await guild.channels.create({
        name: name.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: clanVoiceCategory.id,
        reason: 'Voice channel for clan created from Barracks dashboard',
      });
      const levelsRole = await guild.roles.fetch('1564159581825933353').catch(() => null);
      if (levelsRole && role.editable) {
        await role.setPosition(levelsRole.position + 1, {
          reason: 'Keep Barracks clan roles above the Levels separator',
        });
      }
      await leader.roles.add(role, 'Assigned as clan leader by Barracks dashboard');
      if (viceLeader) await viceLeader.roles.add(role, 'Assigned as vice clan leader by Barracks dashboard');
      await applyClanAutoNick(leader, tag, autoNickFormat);
      if (viceLeader) await applyClanAutoNick(viceLeader, tag, autoNickFormat);
      const record = { id: role.id, name, tag, roleHex, autoNickFormat, description, leaderId: leader.id, leaderName: leader.displayName, viceLeaderId: viceLeader?.id || '', viceLeaderName: viceLeader?.displayName || '', roleId: role.id, voiceChannelId: voiceChannel.id, status: 'approved', memberIds: [], joinRequests: [], createdAt: new Date().toISOString(), source: 'dashboard' };
      await setInDb(clanStorageKey(guild.id), [...clans, record]);
      return res.json({ ok: true, clan: record });
    } catch (error) {
      if (voiceChannel) await voiceChannel.delete('Rollback failed clan creation').catch(() => {});
      if (role && leader.roles.cache.has(role.id)) await leader.roles.remove(role, 'Rollback failed clan creation').catch(() => {});
      if (role && viceLeader?.roles.cache.has(role.id)) await viceLeader.roles.remove(role, 'Rollback failed clan creation').catch(() => {});
      if (role) await role.delete('Rollback failed clan creation').catch(() => {});
      return res.status(500).json({ error: error?.message || 'Clan creation failed. Partially created Discord resources were cleaned up.' });
    }
  });
}
