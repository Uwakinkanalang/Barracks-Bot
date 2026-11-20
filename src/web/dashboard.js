import crypto from 'node:crypto';
import { getWelcomeConfig, saveWelcomeConfig, getFromDb, setInDb } from '../utils/database.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { getEconomyPrefix } from '../utils/database.js';
import { getEconomyData, setEconomyData, getMaxBankCapacity } from '../utils/economy.js';
import { getLevelingConfig, saveLevelingConfig } from '../services/leveling/leveling.js';
import { getCountingGameConfig, saveCountingGameConfig } from '../services/countingGameService.js';
import { getCommandAccessSnapshot, disableCommand, enableCommand, isProtectedCommand, isCommandEnabledInConfig } from '../services/commandAccessService.js';

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
        if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 2000)
          return res.status(400).json({ error: field + ' must be between 1 and 2000 characters.' });
        updates[field] = body[field].trim();
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


  app.get('/api/dashboard/leveling', async (req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});try{const c=await getLevelingConfig(bot,guild.id);return res.json({config:{enabled:c.enabled,xpMin:Number(c.xpRange?.min??c.xpPerMessage?.min??15),xpMax:Number(c.xpRange?.max??c.xpPerMessage?.max??25),xpCooldown:Number(c.xpCooldown??60),xpMultiplier:Number(c.xpMultiplier??1),announceLevelUp:c.announceLevelUp!==false,levelUpChannel:c.levelUpChannel||null,levelUpMessage:c.levelUpMessage||'{user} has leveled up to level {level}!',voiceXpEnabled:c.voiceXpEnabled!==false,voiceXpPerMinute:Number(c.voiceXpPerMinute??5),ignoredChannels:c.ignoredChannels||[],ignoredRoles:c.ignoredRoles||[]},channels:guild.channels.cache.filter(x=>x.isTextBased?.()&&!x.isThread?.()).map(x=>({id:x.id,name:x.name})),roles:guild.roles.cache.filter(x=>x.id!==guild.id&&!x.managed).map(x=>({id:x.id,name:x.name}))});}catch(e){return res.status(500).json({error:e.message||'Could not load leveling settings.'});}});
  app.put('/api/dashboard/leveling',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const b=req.body||{};const min=Number(b.xpMin),max=Number(b.xpMax),cool=Number(b.xpCooldown),mult=Number(b.xpMultiplier),voice=Number(b.voiceXpPerMinute);if(!Number.isInteger(min)||!Number.isInteger(max)||min<1||max<min||max>1000||!Number.isInteger(cool)||cool<0||cool>3600||!Number.isFinite(mult)||mult<.1||mult>10||!Number.isInteger(voice)||voice<1||voice>100)return res.status(400).json({error:'Check XP range, cooldown, multiplier, and voice XP values.'});if(b.levelUpChannel&&!guild.channels.cache.get(String(b.levelUpChannel)))return res.status(400).json({error:'Invalid level-up channel.'});for(const id of [...(b.ignoredChannels||[]),...(b.ignoredRoles||[])])if(!guild.channels.cache.has(String(id))&&!guild.roles.cache.has(String(id)))return res.status(400).json({error:'An ignored channel or role is invalid.'});try{const c=await getLevelingConfig(bot,guild.id);await saveLevelingConfig(bot,guild.id,{...c,enabled:Boolean(b.enabled),xpRange:{min,max},xpPerMessage:{min,max},xpCooldown:cool,xpMultiplier:mult,announceLevelUp:Boolean(b.announceLevelUp),levelUpChannel:b.levelUpChannel||null,levelUpMessage:String(b.levelUpMessage||'{user} has leveled up to level {level}!').slice(0,1800),voiceXpEnabled:Boolean(b.voiceXpEnabled),voiceXpPerMinute:voice,ignoredChannels:[...(b.ignoredChannels||[])],ignoredRoles:[...(b.ignoredRoles||[])]});return res.json({ok:true});}catch(e){return res.status(500).json({error:e.message||'Could not save leveling settings.'});}});
  app.get('/api/dashboard/roles-channels',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});return res.json({roles:guild.roles.cache.filter(x=>x.id!==guild.id).map(x=>({id:x.id,name:x.name})),channels:guild.channels.cache.map(x=>({id:x.id,name:x.name,type:x.type===4?'category':x.isVoiceBased?.()?'voice':'text'}))});});
  app.post('/api/dashboard/roles-channels/role',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const name=String(req.body?.name||'').trim(),color=String(req.body?.color||'#c3f36b');if(!name||name.length>100||!/^#[0-9a-fA-F]{6}$/.test(color))return res.status(400).json({error:'Enter a valid role name and color.'});try{const role=await guild.roles.create({name,color,reason:'Created from Barracks dashboard'});return res.json({ok:true,id:role.id,name:role.name});}catch(e){return res.status(500).json({error:e.message||'Could not create role.'});}});
  app.post('/api/dashboard/roles-channels/channel',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const name=String(req.body?.name||'').trim().toLowerCase().replace(/[^a-z0-9-_]/g,'-').replace(/-+/g,'-').slice(0,100),type=String(req.body?.type||'text');if(!name||!['text','voice','category'].includes(type))return res.status(400).json({error:'Enter a valid channel name and type.'});try{const channel=await guild.channels.create({name,type:type==='category'?4:type==='voice'?2:0,reason:'Created from Barracks dashboard'});return res.json({ok:true,id:channel.id,name:channel.name});}catch(e){return res.status(500).json({error:e.message||'Could not create channel.'});}});
  app.get('/api/dashboard/tickets',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const config=await bot.db.get('guild:'+guild.id+':tickets:dashboard-config',{});return res.json({config,roles:guild.roles.cache.filter(x=>x.id!==guild.id&&!x.managed).map(x=>({id:x.id,name:x.name})),channels:guild.channels.cache.map(x=>({id:x.id,name:x.name,type:x.type===4?'category':x.isVoiceBased?.()?'voice':'text'}))});});
  app.put('/api/dashboard/tickets',async(req,res)=>{const secret=process.env.DASHBOARD_SESSION_SECRET;if(!secret||!validAccessToken(req,secret))return res.status(401).json({error:'Unauthorized'});const guild=bot.guilds.cache.get(DASHBOARD_GUILD_ID);if(!guild)return res.status(503).json({error:'Barracks server is not available.'});const b=req.body||{};const prefix=String(b.prefix||'ticket').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,20);if(!prefix||!String(b.title||'').trim()||String(b.title).length>200||String(b.message||'').length>1800)return res.status(400).json({error:'Check ticket prefix, title, and message.'});if(b.categoryId&&guild.channels.cache.get(String(b.categoryId))?.type!==4)return res.status(400).json({error:'Choose a valid category.'});if(b.logChannelId&&!guild.channels.cache.get(String(b.logChannelId))?.isTextBased?.())return res.status(400).json({error:'Choose a valid text log channel.'});if((b.supportRoleIds||[]).some(id=>!guild.roles.cache.has(String(id))))return res.status(400).json({error:'One or more support roles are invalid.'});try{await bot.db.set('guild:'+guild.id+':tickets:dashboard-config',{categoryId:b.categoryId||null,logChannelId:b.logChannelId||null,supportRoleIds:[...(b.supportRoleIds||[])],prefix,title:String(b.title).trim(),message:String(b.message||'').trim()});return res.json({ok:true});}catch(e){return res.status(500).json({error:e.message||'Could not save ticket settings.'});}});


  // Keep dashboard-created clans in the same registry used by Discord clan commands.
  const clanStorageKey = guildId => 'guild:' + guildId + ':clans';
  const legacyClanStorageKey = guildId => 'dashboard:clans:' + guildId;
  const registerClanAutoNick = async (guild, role, tag) => {
    const key = 'guild:' + guild.id + ':autonick_roles';
    const stored = await getFromDb(key, []);
    const entries = Array.isArray(stored) ? stored.filter(entry => entry && typeof entry.roleId === 'string' && typeof entry.prefix === 'string') : [];
    const existing = entries.find(entry => entry.roleId === role.id);
    if (existing) {
      existing.prefix = String(tag) + '|';
      existing.priority = 1000;
    } else {
      entries.push({ roleId: role.id, prefix: String(tag) + '|', priority: 1000 });
    }
    entries.sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0));
    await setInDb(key, entries);
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
      return res.json({ clans: clans.map(clan => ({ ...clan, leaderName: guild.members.cache.get(clan.leaderId)?.displayName || clan.leaderName || clan.leaderId })) });
    } catch (error) { return res.status(500).json({ error: error?.message || 'Could not load clans.' }); }
  });


  app.patch('/api/dashboard/clans/:clanId', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });

    const clanId = String(req.params.clanId || '');
    const name = String(req.body?.name || '').trim();
    const tag = String(req.body?.tag || '').trim().toUpperCase();
    const leaderId = String(req.body?.leaderId || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!name || name.length > 60) return res.status(400).json({ error: 'Clan name must be between 1 and 60 characters.' });
    if (Array.from(tag).length < 1 || Array.from(tag).length > 5) return res.status(400).json({ error: 'Clan tag must be 1–5 characters. Letters, numbers, symbols, and emoji are accepted.' });
    if (!/^\d{17,20}$/.test(leaderId)) return res.status(400).json({ error: 'Enter a valid Discord user ID for the clan leader.' });
    if (description.length > 300) return res.status(400).json({ error: 'Clan description must be 300 characters or fewer.' });

    const me = guild.members.me;
    if (!me || !me.permissions.has(['ManageRoles', 'ManageChannels'])) return res.status(403).json({ error: 'Barracks-Bot needs Manage Roles and Manage Channels permissions.' });
    let clans;
    try {
      clans = await loadDashboardClans(guild.id);
    } catch { return res.status(500).json({ error: 'Could not read saved clan records.' }); }

    const index = clans.findIndex(c => String(c.roleId || c.id) === clanId);
    if (index < 0) return res.status(404).json({ error: 'Clan not found.' });
    const current = clans[index];
    if (clans.some((c, i) => i !== index && String(c.tag).toUpperCase() === tag)) return res.status(409).json({ error: 'That clan tag is already in use.' });
    if (clans.some((c, i) => i !== index && String(c.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A clan with that name already exists.' });

    const role = guild.roles.cache.get(String(current.roleId || current.id));
    const category = guild.channels.cache.get(String(current.categoryId));
    const textChannel = guild.channels.cache.get(String(current.textChannelId));
    const voiceChannel = guild.channels.cache.get(String(current.voiceChannelId));
    if (!role || !category || !textChannel || !voiceChannel) return res.status(409).json({ error: 'One or more Discord clan resources are missing. Please check the clan channels and role.' });
    if (!role.editable || !category.manageable || !textChannel.manageable || !voiceChannel.manageable) return res.status(403).json({ error: 'Barracks-Bot cannot edit this clan role or channels. Check its role hierarchy and Manage Roles/Channels permissions.' });

    const leaderUnchanged = String(current.leaderId || '') === leaderId;
    const leader = leaderUnchanged
      ? (guild.members.cache.get(leaderId) || null)
      : await guild.members.fetch(leaderId).catch(() => null);
    if (!leaderUnchanged && (!leader || leader.user.bot)) return res.status(404).json({ error: 'Clan leader must be a real member of Barracks.' });
    if (!leaderUnchanged && !leader.manageable) return res.status(403).json({ error: 'Barracks-Bot cannot assign roles to this member. Move the bot role above the leader’s highest role.' });

    const oldLeader = leaderUnchanged ? leader : await guild.members.fetch(String(current.leaderId)).catch(() => null);
    const slug = (tag + '-' + name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 85) || 'clan';
    const voiceName = (tag + '-' + name + '-vc').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'clan-vc';
    try {
      await role.edit({ name: tag + ' ' + name, reason: 'Clan details updated from Barracks dashboard' });
      const levelsRole = await guild.roles.fetch('1564159581825933353').catch(() => null);
      if (levelsRole && role.editable) {
        await role.setPosition(levelsRole.position + 1, {
          reason: 'Keep Barracks clan roles above the Levels separator',
        });
      }
      await category.edit({ name: '⚔️ ' + tag + ' | ' + name, reason: 'Clan details updated from Barracks dashboard' });
      await textChannel.edit({ name: slug + '-chat', reason: 'Clan details updated from Barracks dashboard' });
      await voiceChannel.edit({ name: voiceName, reason: 'Clan details updated from Barracks dashboard' });

      if (!leaderUnchanged) {
        if (oldLeader) {
          await category.permissionOverwrites.delete(oldLeader.id).catch(() => {});
          await textChannel.permissionOverwrites.delete(oldLeader.id).catch(() => {});
          await voiceChannel.permissionOverwrites.delete(oldLeader.id).catch(() => {});
          await oldLeader.roles.remove(role, 'Clan leader changed in Barracks dashboard').catch(() => {});
        }
        await Promise.all([
          category.permissionOverwrites.edit(leader.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, Connect: true, Speak: true }),
          textChannel.permissionOverwrites.edit(leader.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }),
          voiceChannel.permissionOverwrites.edit(leader.id, { ViewChannel: true, Connect: true, Speak: true })
        ]);
        await leader.roles.add(role, 'Assigned as clan leader by Barracks dashboard');
      }
      const updated = { ...current, name, tag, description, leaderId, leaderName: leader?.displayName || current.leaderName || leaderId, updatedAt: new Date().toISOString() };
      clans[index] = updated;
      await setInDb(clanStorageKey(guild.id), clans);
      return res.json({ ok: true, clan: updated });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Could not update the clan. Check the bot permissions and try again.' });
    }
  });

  app.post('/api/dashboard/clans', async (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validAccessToken(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
    const guild = bot.guilds.cache.get(DASHBOARD_GUILD_ID);
    if (!guild) return res.status(503).json({ error: 'Barracks server is not available.' });
    const name = String(req.body?.name || '').trim(), tag = String(req.body?.tag || '').trim().toUpperCase();
    const leaderId = String(req.body?.leaderId || '').trim(), description = String(req.body?.description || '').trim();
    if (!name || name.length > 60) return res.status(400).json({ error: 'Clan name must be between 1 and 60 characters.' });
    if (Array.from(tag).length < 1 || Array.from(tag).length > 5) return res.status(400).json({ error: 'Clan tag must be 1–5 characters. Letters, numbers, symbols, and emoji are accepted.' });
    if (!/^\d{17,20}$/.test(leaderId)) return res.status(400).json({ error: 'Enter a valid Discord user ID for the clan leader.' });
    if (description.length > 300) return res.status(400).json({ error: 'Clan description must be 300 characters or fewer.' });
    const me = guild.members.me;
    if (!me || !me.permissions.has(['ManageRoles', 'ManageChannels'])) return res.status(403).json({ error: 'Barracks-Bot needs Manage Roles and Manage Channels permissions.' });
    const leader = await guild.members.fetch(leaderId).catch(() => null);
    if (!leader || leader.user.bot) return res.status(404).json({ error: 'Clan leader must be a real member of Barracks.' });
    if (!leader.manageable) return res.status(403).json({ error: 'Barracks-Bot cannot assign roles to this member. Move the bot role above the leader’s highest role.' });
    let clans;
    try { clans = await loadDashboardClans(guild.id); }
    catch { return res.status(500).json({ error: 'Could not read saved clan records.' }); }
    if (clans.some(c => String(c.tag).toUpperCase() === tag)) return res.status(409).json({ error: 'That clan tag is already in use.' });
    if (clans.some(c => String(c.name).toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'A clan with that name already exists.' });
    const slug = (tag + '-' + name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 85);
    let role = null, category = null, textChannel = null, voiceChannel = null;
    try {
      role = await guild.roles.create({ name: tag + ' ' + name, color: '#c3f36b', hoist: true, mentionable: false, reason: 'Clan created from Barracks dashboard' });
      await registerClanAutoNick(guild, role, tag);
      const levelsRole = await guild.roles.fetch('1564159581825933353').catch(() => null);
      if (levelsRole && role.editable) {
        await role.setPosition(levelsRole.position + 1, {
          reason: 'Keep Barracks clan roles above the Levels separator',
        });
      }
      const overwrites = [
        { id: guild.id, deny: ['ViewChannel'] },
        { id: role.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks', 'Connect', 'Speak', 'UseVAD'] },
        { id: leader.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak'] },
        { id: me.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak'] }
      ];
      category = await guild.channels.create({ name: '⚔️ ' + tag + ' | ' + name, type: 4, permissionOverwrites: overwrites, reason: 'Private clan category created from Barracks dashboard' });
      textChannel = await guild.channels.create({ name: slug + '-chat', type: 0, parent: category.id, permissionOverwrites: overwrites, reason: 'Private clan text channel created from Barracks dashboard' });
      voiceChannel = await guild.channels.create({ name: (tag + '-' + name + '-vc').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100), type: 2, parent: category.id, permissionOverwrites: overwrites, reason: 'Private clan voice channel created from Barracks dashboard' });
      await leader.roles.add(role, 'Assigned as clan leader by Barracks dashboard');
      const record = { id: role.id, name, tag, description, leaderId: leader.id, leaderName: leader.displayName, roleId: role.id, categoryId: category.id, textChannelId: textChannel.id, voiceChannelId: voiceChannel.id, status: 'approved', memberIds: [], joinRequests: [], createdAt: new Date().toISOString(), source: 'dashboard' };
      await setInDb(clanStorageKey(guild.id), [...clans, record]);
      return res.json({ ok: true, clan: record });
    } catch (error) {
      if (role && leader.roles.cache.has(role.id)) await leader.roles.remove(role, 'Rollback failed clan creation').catch(() => {});
      await Promise.allSettled([voiceChannel, textChannel, category, role].filter(Boolean).map(resource => resource.delete('Rollback failed clan creation')));
      return res.status(500).json({ error: error?.message || 'Clan creation failed. Partially created Discord resources were cleaned up.' });
    }
  });
}
