import crypto from 'node:crypto';
import { getWelcomeConfig, saveWelcomeConfig } from '../utils/database.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const DASHBOARD_GUILD_ID = process.env.BARRACKS_GUILD_ID || '1137695060096471160';
const loginAttempts = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createAccessToken(secret) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    scope: 'barracks-dashboard'
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
  app.post('/api/dashboard/login', (req, res) => {
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!expectedPassword || !secret) {
      return res.status(503).json({ error: 'Dashboard login is not configured.' });
    }
    if (!allowLoginAttempt(req.ip)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }
    if (!safeEqual(req.body?.password || '', expectedPassword)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    return res.json({
      token: createAccessToken(secret),
      expiresIn: SESSION_TTL_SECONDS
    });
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
    for (const field of ['welcomeMessage', 'leaveMessage']) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 2000)
          return res.status(400).json({ error: field + ' must be between 1 and 2000 characters.' });
        updates[field] = body[field].trim();
      }
    }
    for (const field of ['enabled', 'welcomePing', 'goodbyeEnabled', 'goodbyePing']) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== 'boolean') return res.status(400).json({ error: field + ' must be true or false.' });
        updates[field] = body[field];
      }
    }
    for (const field of ['channelId', 'goodbyeChannelId']) {
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
}
