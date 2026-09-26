// Two-person chat: the example app for QA Cockpit.
// Plain Node 20+, zero dependencies, all state in memory. Start it with `node server.mjs`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 4310;
const HOST = '127.0.0.1';
const TEST_HOOKS = process.env.DEMO_TEST_HOOKS === '1';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_BODY = 16 * 1024;
const MAX_TEXT = 500;
const HISTORY = 100;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Public demo fixtures, not secrets: the README and every example test sign in with them.
const SEED = [
  { username: 'alice', displayName: 'Alice', password: 'demo-pass-1' },
  { username: 'bob', displayName: 'Bob', password: 'demo-pass-1' },
];

// accounts: username -> account; sessions: session id -> username; messages: the last HISTORY, oldest first.
let accounts, sessions, messages, nextId;
const clients = new Set(); // open SSE streams: { res, sid, username, displayName }

function resetState() {
  accounts = new Map(SEED.map((account) => [account.username, { ...account }]));
  sessions = new Map();
  messages = [];
  nextId = 1;
}
resetState();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store', ...headers });
  res.end(json);
}

// Reads a JSON object body of at most MAX_BODY bytes; anything else is a 400 or a 413.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) return chunks.push(chunk);
      req.pause();
      reject(new HttpError(413, 'The request body is over 16 KB.'));
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body && typeof body === 'object' && !Array.isArray(body)) return resolve(body);
      } catch {}
      reject(new HttpError(400, 'Send a JSON object.'));
    });
    req.on('error', reject);
  });
}

function sessionId(req) {
  const match = /(?:^|;\s*)session=([^;]*)/.exec(req.headers.cookie ?? '');
  return match?.[1] || null;
}

function requireUser(req) {
  const username = sessions.get(sessionId(req));
  const user = username && accounts.get(username);
  if (!user) throw new HttpError(401, 'Sign in first.');
  return user;
}

const publicUser = ({ username, displayName }) => ({ username, displayName });

function emit(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.res.write(frame);
}

// One entry per connected user, however many tabs they have open.
function emitPresence() {
  const here = new Map([...clients].map((client) => [client.username, client.displayName]));
  const users = [...here].sort((a, b) => a[0].localeCompare(b[0]));
  emit('presence', users.map(([username, displayName]) => ({ username, displayName })));
}

function closeStreams(match) {
  const closing = [...clients].filter(match);
  for (const client of closing) { clients.delete(client); client.res.end(); }
  if (closing.length) emitPresence();
}

const routes = {
  'GET /health': (req, res) => send(res, 200, { status: 'ok' }),
  'GET /api/me': (req, res) => send(res, 200, publicUser(requireUser(req))),
  'GET /api/messages': (req, res) => send(res, 200, { messages }),

  'POST /api/login': async (req, res) => {
    const { username, password } = await readJson(req);
    const account = accounts.get(String(username ?? '').trim().toLowerCase());
    if (!account || account.password !== password) throw new HttpError(401, 'Wrong username or password.');
    const sid = randomBytes(24).toString('base64url');
    sessions.set(sid, account.username);
    send(res, 200, publicUser(account), { 'Set-Cookie': `session=${sid}; HttpOnly; SameSite=Lax; Path=/` });
  },

  'POST /api/logout': (req, res) => {
    const sid = sessionId(req);
    if (sid) { sessions.delete(sid); closeStreams((client) => client.sid === sid); }
    send(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  },

  'POST /api/messages': async (req, res) => {
    const user = requireUser(req);
    const { text } = await readJson(req);
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) throw new HttpError(400, 'Write something first.');
    if (clean.length > MAX_TEXT) throw new HttpError(400, `A message can be at most ${MAX_TEXT} characters.`);
    const message = { id: nextId++, username: user.username, displayName: user.displayName, text: clean, at: new Date().toISOString() };
    messages.push(message);
    if (messages.length > HISTORY) messages.shift();
    emit('message', message);
    send(res, 201, message);
  },

  'GET /api/events': (req, res) => {
    const user = requireUser(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const client = { res, sid: sessionId(req), username: user.username, displayName: user.displayName };
    clients.add(client);
    res.on('error', () => clients.delete(client));
    res.on('close', () => clients.delete(client) && emitPresence());
    emitPresence();
  },
};

// Test-only: wipes messages, sessions and live streams, and restores the seed accounts.
if (TEST_HOOKS) {
  routes['POST /api/test/reset'] = (req, res) => {
    resetState();
    closeStreams(() => true);
    send(res, 200, { ok: true });
  };
}

const safeDecode = (path) => { try { return decodeURIComponent(path); } catch { return ''; } };

async function serveStatic(req, res, pathname) {
  const notFound = new HttpError(404, 'Not found.');
  if (req.method !== 'GET' && req.method !== 'HEAD') throw notFound;
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : safeDecode(pathname)));
  const type = TYPES[extname(file)];
  if (!type || !file.startsWith(PUBLIC_DIR)) throw notFound;
  const data = await readFile(file).catch(() => { throw notFound; });
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${pathname}`];
    if (route) await route(req, res);
    else if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
    else await serveStatic(req, res, pathname);
  } catch (err) {
    if (!err.status) console.error(err);
    if (res.headersSent) return res.end();
    const headers = err.status === 413 ? { Connection: 'close' } : {};
    send(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong.' }, headers);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`two-person-chat on http://${HOST}:${PORT}${TEST_HOOKS ? ' (test hooks on)' : ''}`);
});
