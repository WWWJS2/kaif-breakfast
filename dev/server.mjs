// Local preview server: static files + a tiny Supabase-compatible API
// (POST /rest/v1/rpc/:fn, /auth/v1/token, /auth/v1/user, /auth/v1/logout)
// backed by PGlite running the real supabase/schema.sql.
// Usage: node dev/server.mjs [port]
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createDb, rpc } from './db.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 5173);
const usersFile = join(root, 'dev/dev-users.json');

// local test admin (credentials live only in dev/dev-users.json)
if (!existsSync(usersFile)) {
  const password = randomBytes(9).toString('base64url');
  writeFileSync(usersFile, JSON.stringify([{ id: randomUUID(), email: 'admin@kaif.test', password }], null, 2));
}
const users = JSON.parse(readFileSync(usersFile, 'utf8'));
const sessions = new Map(); // token -> user

const db = await createDb();
for (const u of users) {
  await db.query('insert into auth.users (id,email) values ($1,$2) on conflict do nothing', [u.id, u.email]);
  await db.query('insert into public.admins (user_id) values ($1) on conflict do nothing', [u.id]);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS', ...headers });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json' });
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
const eq = (a, b) => { const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest(); return timingSafeEqual(x, y); };
const userOf = (req) => sessions.get((req.headers.authorization || '').replace(/^Bearer\s+/i, '')) || null;
const sessionFor = (u) => {
  const access_token = randomBytes(24).toString('hex');
  sessions.set(access_token, u);
  const user = { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: randomBytes(16).toString('hex'), user };
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (url.pathname.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
      const fn = url.pathname.split('/').pop();
      const u = userOf(req);
      const out = await rpc(db, fn, await readBody(req), u ? { role: 'authenticated', sub: u.id } : {});
      return out === null ? send(res, 204, '') : json(res, 200, out);
    }
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const { email = '', password = '' } = await readBody(req);
      const u = users.find((x) => x.email === String(email).toLowerCase());
      if (!u || !eq(u.password, String(password))) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(res, 200, sessionFor(u));
    }
    if (url.pathname === '/auth/v1/user') {
      const u = userOf(req);
      return u ? json(res, 200, { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated' }) : json(res, 401, { msg: 'invalid token' });
    }
    if (url.pathname === '/auth/v1/logout') { sessions.delete((req.headers.authorization || '').slice(7)); return send(res, 204, ''); }

    // static
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    if (p === '/admin') p = '/admin.html';
    const file = join(root, p);
    if (!file.startsWith(root) || p.includes('node_modules') || p.startsWith('/dev') || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found');
    send(res, 200, readFileSync(file), { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  } catch (e) {
    const notAdmin = /not_admin|permission denied/.test(e.message);
    json(res, notAdmin ? 403 : 400, { message: e.message, code: e.code || 'error' });
  }
}).listen(port, () => console.log(`KAIF preview → http://localhost:${port}  (admin: /admin.html)`));
