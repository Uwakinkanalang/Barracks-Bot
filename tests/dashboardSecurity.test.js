import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { registerDashboardRoutes } from '../src/web/dashboard.js';

const app = express();
app.use(express.json());
const bot = {
  guilds: { cache: new Map() },
  config: { bot: { clientId: '' } },
  db: { getStatus: () => ({ isDegraded: true }) }
};
registerDashboardRoutes(app, bot);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

test('dashboard APIs reject requests without an authenticated Discord session', async () => {
  for (const path of ['/api/dashboard/settings', '/api/dashboard/overview', '/api/dashboard/moderation/logs', '/api/dashboard/logout']) {
    const response = await fetch(baseUrl + path, { method: path.endsWith('/logout') ? 'POST' : 'GET' });
    assert.equal(response.status, 401, path + ' must reject unauthenticated requests');
  }
});

test('legacy shared-password login is permanently retired', async () => {
  const response = await fetch(baseUrl + '/api/dashboard/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'not-a-real-password' })
  });
  assert.equal(response.status, 410);
});

test('OAuth start fails closed when required server configuration is missing', async () => {
  const keys = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DASHBOARD_OAUTH_REDIRECT_URI', 'DASHBOARD_SESSION_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const response = await fetch(baseUrl + '/api/dashboard/oauth/start', { redirect: 'manual' });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Discord OAuth is not configured/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('OAuth callback rejects an invalid or expired state before contacting Discord', async () => {
  const response = await fetch(baseUrl + '/api/dashboard/oauth/callback?state=invalid&code=fake', { redirect: 'manual' });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Sign-in expired or invalid/);
});

test('dashboard frontend offers Discord OAuth and contains no password form', async () => {
  const html = await readFile(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
  assert.match(html, /Continue with Discord/);
  assert.match(html, /\/api\/dashboard\/oauth\/start/);
  assert.doesNotMatch(html, /dashboardPassword|\/api\/dashboard\/login/);
  assert.match(html, /sessionStorage\.setItem\(TOKEN_KEY,token\)/);
});

test('OAuth implementation requires PKCE, server-side sessions, and live Manager Role checks', async () => {
  const source = await readFile(new URL('../src/web/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /code_challenge_method: 'S256'/);
  assert.match(source, /dashboard:sessions:/);
  assert.match(source, /guild\.members\.fetch\(\{ user: String\(userId\), force: true \}\)/);
  assert.match(source, /Only the Barracks server owner can change Manager Roles/);
  assert.match(source, /revoked: true/);
});

test('all dashboard endpoints are registered behind the shared authorization middleware', async () => {
  const source = await readFile(new URL('../src/web/dashboard.js', import.meta.url), 'utf8');
  const middlewareIndex = source.indexOf("app.use('/api/dashboard'");
  assert.notEqual(middlewareIndex, -1, 'shared dashboard middleware must exist');
  const routePattern = /app\.(?:get|post|put|patch|delete)\(\s*['"]\/api\/dashboard\//g;
  const routeIndexes = [...source.matchAll(routePattern)].map(match => match.index);
  assert.ok(routeIndexes.length > 10, 'expected dashboard API routes to be covered');
  assert.ok(routeIndexes.every(index => index > middlewareIndex), 'every dashboard API route must be registered after shared authorization middleware');
});

test('OAuth state cookie uses HttpOnly and SameSite protections', async () => {
  const source = await readFile(new URL('../src/web/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /barracks_oauth_state=.*HttpOnly; SameSite=Lax; Path=\/api\/dashboard\/oauth\/callback; Max-Age=600/);
  assert.match(source, /process\.env\.NODE_ENV === 'production' \? '; Secure' : ''/);
});

test('only the intended login bootstrap endpoints bypass dashboard authorization', async () => {
  const source = await readFile(new URL('../src/web/dashboard.js', import.meta.url), 'utf8');
  const middlewareStart = source.indexOf("app.use('/api/dashboard'");
  assert.notEqual(middlewareStart, -1);
  const middlewareEnd = source.indexOf("\n  });", middlewareStart);
  assert.notEqual(middlewareEnd, -1);
  const middleware = source.slice(middlewareStart, middlewareEnd);
  const bypassMatch = middleware.match(/if \(req\.path === ['"]([^'"]+)['"] \|\| req\.path === ['"]([^'"]+)['"] \|\| req\.path === ['"]([^'"]+)['"]\) return next\(\)/);
  assert.ok(bypassMatch, 'the authorization bypass list must remain explicit and reviewable');
  assert.deepEqual(bypassMatch.slice(1), ['/login', '/oauth/start', '/oauth/callback']);
  assert.match(source, /app\.post\(['"]\/api\/dashboard\/login['"],\s*\(req, res\) => res\.status\(410\)/);
});

test('OAuth state is one-time and cannot be completed without its matching HttpOnly cookie', async () => {
  const keys = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DASHBOARD_OAUTH_REDIRECT_URI', 'DASHBOARD_SESSION_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.DISCORD_CLIENT_ID = '123456789012345678';
    process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
    process.env.DASHBOARD_OAUTH_REDIRECT_URI = 'https://barracks.example/api/dashboard/oauth/callback';
    process.env.DASHBOARD_SESSION_SECRET = 'test-session-secret';
    const start = await fetch(baseUrl + '/api/dashboard/oauth/start', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get('location'));
    const state = location.searchParams.get('state');
    const cookie = start.headers.get('set-cookie');
    assert.ok(state);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const missingCookie = await fetch(baseUrl + '/api/dashboard/oauth/callback?state=' + encodeURIComponent(state) + '&code=fake', { redirect: 'manual' });
    assert.equal(missingCookie.status, 400);

    const source = await readFile(new URL('../src/web/dashboard.js', import.meta.url), 'utf8');
    const callbackStart = source.indexOf("app.get('/api/dashboard/oauth/callback'");
    const callbackEnd = source.indexOf("\n  });", callbackStart);
    const callback = source.slice(callbackStart, callbackEnd);
    const cookieCheck = callback.indexOf("const cookieMatches = safeEqual(state, cookieValue(req.headers.cookie))");
    const clearCookie = callback.indexOf("if (cookieMatches) res.setHeader('Set-Cookie'");
    const rejectInvalid = callback.indexOf("if (!pending || pending.expiresAt <= Date.now() || !cookieMatches)");
    const consumeState = callback.indexOf("pendingOAuth.delete(state)");
    assert.ok(cookieCheck !== -1 && clearCookie > cookieCheck && rejectInvalid > clearCookie && consumeState > rejectInvalid,
      'OAuth state and its cookie must only be consumed after the matching cookie is validated');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
