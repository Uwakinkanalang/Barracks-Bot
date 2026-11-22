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
  for (const path of ['/api/dashboard/settings', '/api/dashboard/overview', '/api/dashboard/moderation/logs']) {
    const response = await fetch(baseUrl + path);
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
