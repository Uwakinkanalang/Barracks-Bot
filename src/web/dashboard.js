import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const COOKIE_NAME = 'barracks_dashboard_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const DASHBOARD_GUILD_ID = process.env.BARRACKS_GUILD_ID || '1137695060096471160';
const dashboardFile = fileURLToPath(new URL('../../public/dashboard/index.html', import.meta.url));

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSession(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function validSession(req, secret) {
  const cookieHeader = req.headers.cookie || '';
  const entry = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return false;
  const token = decodeURIComponent(entry.slice(COOKIE_NAME.length + 1));
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function loginPage(error = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Barracks Dashboard · Sign in</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1110;color:#edf3ef;font:15px Inter,system-ui,sans-serif;padding:24px}.panel{width:min(420px,100%);padding:36px;border:1px solid #26352e;border-radius:22px;background:#111b17;box-shadow:0 24px 80px #0008}.mark{width:48px;height:48px;border-radius:14px;background:#c3f36b;color:#17220d;display:grid;place-items:center;font-size:25px;font-weight:900}.eyebrow{margin:24px 0 8px;color:#a6bd9c;text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:800}h1{font-size:28px;margin:0 0 10px}p{color:#aab8b0;line-height:1.55;margin:0 0 24px}label{display:block;margin:0 0 8px;font-size:13px;color:#dce8df}input{width:100%;padding:14px 15px;border-radius:11px;border:1px solid #34463b;background:#0b1310;color:white;font:inherit;outline:none}input:focus{border-color:#c3f36b}button{width:100%;margin-top:14px;border:0;border-radius:11px;padding:14px;background:#c3f36b;color:#18210f;font-weight:800;font-size:14px;cursor:pointer}.error{color:#ff9a91;font-size:13px;margin:12px 0 0}.foot{margin-top:24px;font-size:11px;color:#718178;text-align:center}</style></head><body><main class="panel"><div class="mark">B</div><div class="eyebrow">Barracks · Command Center</div><h1>Welcome back, soldier.</h1><p>Sign in with your private dashboard password to manage Barracks-Bot.</p><form method="post" action="/dashboard/login"><label for="password">Dashboard password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Enter Dashboard</button>${error ? `<div class="error">${error}</div>` : ''}</form><div class="foot">AUTHORIZED PERSONNEL ONLY · BARRACKS SERVER</div></main></body></html>`;
}

export function registerDashboardRoutes(app, bot) {
  app.use('/dashboard', (req, res, next) => {
    if (req.path === '/login') return next();
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !process.env.DASHBOARD_PASSWORD) return res.status(503).send('Dashboard login is not configured.');
    if (!validSession(req, secret)) return res.status(401).type('html').send(loginPage());
    next();
  });

  app.get(['/dashboard', '/dashboard/'], (req, res) => res.sendFile(dashboardFile));

  app.post('/dashboard/login', (req, res) => {
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!expectedPassword || !secret) return res.status(503).send('Dashboard login is not configured.');
    const origin = req.get('origin');
    const requestProtocol = req.get('x-forwarded-proto') || req.protocol;
    if (origin && origin !== `${requestProtocol}://${req.get('host')}`) return res.status(403).send('Invalid request origin.');
    if (!safeEqual(req.body?.password || '', expectedPassword)) {
      return res.status(401).type('html').send(loginPage('Incorrect password. Please try again.'));
    }
    res.cookie(COOKIE_NAME, makeSession(secret), {
      httpOnly: true,
      secure: req.secure || req.get('x-forwarded-proto') === 'https',
      sameSite: 'strict',
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/'
    });
    return res.redirect(303, '/dashboard');
  });

  app.post('/dashboard/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    res.redirect(303, '/dashboard');
  });

  app.get('/api/dashboard/overview', (req, res) => {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    if (!secret || !validSession(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
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
