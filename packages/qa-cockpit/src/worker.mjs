// The worker's side of the cockpit (server/server.mjs). Silent unless
// COCKPIT_URL is set, and never allowed to fail a test: every call here
// swallows its own errors.
//
// Two things travel to the cockpit:
//   - A PHOTO when a step of a recording ends, of every person the step's
//     title names ("8 · Quim, Laia: res" is two), and of every open page when
//     the step fails. A step ends after its own assertions, so the photo is
//     the screen the suite describes, not one half loaded. It is the WHOLE
//     page, with where the person was scrolled to, and the clicks and the
//     typing the step did on it (see MARKS below). The image goes to
//     <out>/cockpit/<run>/frames/ on disk; the cockpit gets its path.
//   - A LIVE picture, only while somebody watches that person in the
//     cockpit: a CDP screencast of their page, about four frames a second.
//     The cockpit says who is watched (GET /api/watch); nobody watching costs
//     nothing. Chromium only.
//
// It learns the project from `configure(config)`, which the fixtures and
// the sessions call before anything else here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_BASE = process.env.COCKPIT_URL || '';
export const enabled = Boolean(URL_BASE);
const RUN = (process.env.COCKPIT_RUN || 'adhoc').replace(/[^\w.-]/g, '_');
const LIVE_INTERVAL_MS = 250;
// The package's own files: a step's location is the first frame outside them.
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The project, once configured: where photos go, what a location is shown
// relative to, and the people a step title can name.
let OUT_DIR = null;
let PROJECT_DIR = process.cwd();
let FRAMES_DIR = null;
/** @type {{ id: string, words: string[] }[]} */
let PEOPLE = [];

/** The words a title may use for each person: the id, and the name folded. */
export function peopleWords(cast) {
  return cast.map((p) => ({ id: p.id, words: [...new Set([p.id, fold(p.name)])] }));
}

/** Tell the worker which project it serves (a resolved config). */
export function configure(config) {
  OUT_DIR = config.paths.out;
  PROJECT_DIR = config.paths.project;
  FRAMES_DIR = path.join(OUT_DIR, 'cockpit', RUN, 'frames');
  PEOPLE = peopleWords(config.cast);
}

/** @type {Map<string, { page: import('@playwright/test').Page, cdp?: any, latest?: string, lastSent: number, timer?: NodeJS.Timeout }>} */
const pages = new Map();
let poller = null;

/** Lowercase, no accents: «Ningú» and «ningu» are one word. */
function fold(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The people a step title names before its colon: «3 · Alice: picks Bob» → alice.
 * @param {string} title
 * @param {{ id: string, words: string[] }[]} [people] the configured cast by default
 */
export function peopleIn(title, people = PEOPLE) {
  const head = fold(title).split(':')[0];
  return people.filter((p) => p.words.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(head))).map((p) => p.id);
}

function stripAnsi(s) {
  return String(s ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

async function post(route, body, headers = { 'Content-Type': 'application/json' }) {
  try {
    await fetch(`${URL_BASE}${route}`, {
      method: 'POST',
      headers,
      body: headers['Content-Type'] === 'application/json' ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The cockpit may be gone; the run goes on.
  }
}

/**
 * Photograph one page and tell the cockpit.
 * @param {{ actor: string, page: import('@playwright/test').Page, step: string, status: string, test?: string, error?: string, location?: string, outputDir?: string }} f
 */
export async function photo(f) {
  if (!enabled || !OUT_DIR || f.page.isClosed()) return;
  try {
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    const name = `${Date.now()}-${f.actor}-${Math.random().toString(36).slice(2, 6)}.jpg`;
    const file = path.join(FRAMES_DIR, name);
    // Where the person was looking, before the picture of the whole page.
    const scroll = await f.page.evaluate(() => ({ x: scrollX, y: scrollY })).catch(() => ({ x: 0, y: 0 }));
    // Chromium takes a full page beyond the viewport without resizing it,
    // so the page under test never sees its window change.
    await f.page.screenshot({ path: file, type: 'jpeg', quality: 60, scale: 'css', fullPage: true, timeout: 8_000 });
    await post('/api/frame', {
      run: RUN,
      actor: f.actor,
      test: f.test ?? '',
      step: f.step,
      status: f.status,
      error: f.error ? stripAnsi(f.error).slice(0, 4000) : null,
      url: f.page.url(),
      file: path.relative(OUT_DIR, file).split(path.sep).join('/'),
      location: f.location ?? null,
      outputDir: f.outputDir ? path.relative(OUT_DIR, f.outputDir).split(path.sep).join('/') : null,
      viewport: f.page.viewportSize(),
      scroll,
      marks: f.marks ?? [],
      requests: f.requests ?? [],
      // The device the person plays on: its name and kind, for the card.
      device: f.device ?? null,
      // The step's start and how long it took, the photo aside: where a
      // slow screen shows up.
      began: f.began ? new Date(f.began).toISOString() : null,
      ms: Number.isFinite(f.ms) ? f.ms : null,
      time: new Date().toISOString(),
    });
  } catch {
    // A photo that fails is a photo missing, never a red run.
  }
}

/**
 * A step of a recording has ended.
 * @param {{ title: string, status: 'passed'|'failed', error?: unknown, began?: number, test: string, location?: string, outputDir?: string }} s
 */
export async function stepEnded(s) {
  if (!enabled) return;
  const ended = Date.now();
  const named = peopleIn(s.title).filter((p) => pages.has(p));
  const who = s.status === 'failed' ? [...pages.keys()] : named;
  const error = s.error instanceof Error ? s.error.message : s.error ? String(s.error) : undefined;
  await Promise.all(
    who.map((actor) =>
      photo({
        actor,
        page: pages.get(actor).page,
        device: pages.get(actor).device,
        // What this person clicked and typed since their last photo, and
        // the requests their page made meanwhile.
        marks: pages.get(actor).marks.splice(0),
        requests: pages.get(actor).requests.splice(0),
        step: s.title,
        // Somebody the failed step does not name is photographed as context.
        status: named.includes(actor) ? s.status : 'context',
        test: s.test,
        error,
        location: s.location,
        outputDir: s.outputDir,
        began: s.began,
        ms: s.began ? ended - s.began : null,
      }),
    ),
  );
}

// MARKS: every real click and the first keystroke in a field, as the page
// sees them, told to this worker through a binding (it outlives the
// page's navigations, which a variable in the page would not). Positions
// are in the document, the frame of the full-page photo; a click that
// navigated away keeps the URL it happened on.
function markScript() {
  const recent = new WeakMap();
  const label = (el) => {
    const t =
      el?.closest?.('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], label, summary, input, select, textarea') ??
      el;
    // A field is named by its label, never by what was typed in it (a
    // password would travel otherwise).
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '');
    const text = field
      ? t.getAttribute('aria-label') || t.labels?.[0]?.innerText || t.placeholder || t.name || t.id || t.type
      : t?.getAttribute?.('aria-label') || t?.innerText || t?.tagName || '';
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
  };
  const tell = (kind, el, x, y) => {
    try {
      window.__qaCockpitMark?.({ kind, x: Math.round(x + scrollX), y: Math.round(y + scrollY), url: location.href, label: label(el) });
    } catch {
      // The cockpit is a luxury.
    }
  };
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  addEventListener(
    'click',
    (e) => {
      // A click from the keyboard carries no position: the element's centre.
      const [x, y] = e.detail === 0 || (e.clientX === 0 && e.clientY === 0) ? centre(e.target) : [e.clientX, e.clientY];
      tell('click', e.target, x, y);
    },
    true,
  );
  addEventListener(
    'input',
    (e) => {
      const el = e.target;
      const now = Date.now();
      // A radio, a checkbox or a select fires `input` too, but it was a
      // click, and the click is marked already: typing is text only.
      const typing = el?.isContentEditable || el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && !/^(checkbox|radio|range|color|file|button|submit|reset|image)$/i.test(el.type));
      if (!typing || !el.getBoundingClientRect || now - (recent.get(el) ?? 0) < 3000) return;
      recent.set(el, now);
      const r = el.getBoundingClientRect();
      tell('type', el, r.left + Math.min(28, r.width / 2), r.top + r.height / 2);
    },
    true,
  );
}

/**
 * A person's page exists: it can now be photographed, marked and watched.
 * @param {string} actor
 * @param {any} page
 * @param {{ name: string, kind: string, width?: number, height?: number } | null} [device]
 */
export async function register(actor, page, device = null) {
  if (!enabled) return;
  const entry = { page, device, lastSent: 0, marks: [], requests: [] };
  pages.set(actor, entry);
  // The page's own requests (the app's API calls and its page loads), with
  // how long each took: a step slow because of the app, not because of the
  // recording's own waits, shows here.
  const keep = (request, status) => {
    const type = request.resourceType();
    if (type !== 'fetch' && type !== 'xhr' && type !== 'document') return;
    const t = request.timing();
    let where = request.url();
    try {
      const u = new URL(where);
      where = u.pathname + u.search;
    } catch {
      // Kept as it came.
    }
    if (entry.requests.length < 200) {
      entry.requests.push({
        // A page load is the front's own server (a dev server under test,
        // static files in production); `api` is the app's backend.
        kind: type === 'document' ? 'page' : 'api',
        method: request.method(),
        path: where.slice(0, 200),
        status,
        ms: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
        at: t.startTime > 0 ? Math.round(t.startTime) : Date.now(),
      });
    }
  };
  page.on('requestfinished', (request) => {
    request
      .response()
      .then((response) => keep(request, response?.status() ?? 0))
      .catch(() => {});
  });
  page.on('requestfailed', (request) => keep(request, 0));
  try {
    await page.context().exposeBinding('__qaCockpitMark', (_source, mark) => {
      // When it came, from this clock: the step's start is on it too.
      if (entry.marks.length < 100) entry.marks.push({ ...mark, at: Date.now() });
    });
    await page.context().addInitScript(markScript);
  } catch {
    // Without marks the photos still come.
  }
  page.once('close', () => void unregister(actor));
  if (!poller) {
    poller = setInterval(() => void pollWatch(), 1_000);
    poller.unref();
  }
}

export async function unregister(actor) {
  const entry = pages.get(actor);
  if (!entry) return;
  pages.delete(actor);
  await stopLive(entry);
  if (pages.size === 0 && poller) {
    clearInterval(poller);
    poller = null;
  }
}

async function pollWatch() {
  let watched = [];
  try {
    const r = await fetch(`${URL_BASE}/api/watch`, { signal: AbortSignal.timeout(2_000) });
    watched = (await r.json()).actors ?? [];
  } catch {
    return;
  }
  for (const [actor, entry] of pages) {
    const want = watched.includes(actor);
    if (entry.shared) {
      // A video's capture paints this person already: its frames, not a
      // screencast of our own (two on one page starve each other).
      if (want && !entry.watched && entry.lastShared) {
        entry.latest = entry.lastShared;
        sendLive(actor, entry);
      }
      entry.watched = want;
      continue;
    }
    if (want && !entry.cdp) await startLive(actor, entry);
    else if (!want && entry.cdp) await stopLive(entry);
  }
}

async function startLive(actor, entry) {
  try {
    const cdp = await entry.page.context().newCDPSession(entry.page);
    entry.cdp = cdp;
    cdp.on('Page.screencastFrame', (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      entry.latest = f.data;
      const wait = LIVE_INTERVAL_MS - (Date.now() - entry.lastSent);
      if (wait <= 0) sendLive(actor, entry);
      else if (!entry.timer) entry.timer = setTimeout(() => sendLive(actor, entry), wait);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 900 });
    // A screencast only sends when the page paints: a person standing still
    // would show nothing. One picture now, so the watcher sees them at once.
    const now = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
    entry.latest ??= now.data;
    if (!entry.timer) sendLive(actor, entry);
  } catch {
    entry.cdp = undefined;
  }
}

/** This person's frames come from a video's capture (fixtures.mjs). */
export function sharedFrames(actor) {
  const entry = pages.get(actor);
  if (entry) entry.shared = true;
}

/** A frame of the video's capture: the live view's, while somebody watches. */
export function liveFrame(actor, frame) {
  const entry = pages.get(actor);
  if (!entry) return;
  entry.lastShared = frame;
  if (!entry.watched) return;
  entry.latest = frame;
  const wait = LIVE_INTERVAL_MS - (Date.now() - entry.lastSent);
  if (wait <= 0) sendLive(actor, entry);
  else if (!entry.timer) entry.timer = setTimeout(() => sendLive(actor, entry), wait);
}

function sendLive(actor, entry) {
  entry.timer = undefined;
  if (!entry.latest) return;
  const frame = Buffer.from(entry.latest, 'base64');
  entry.latest = undefined;
  entry.lastSent = Date.now();
  void post(`/api/live/${actor}`, frame, { 'Content-Type': 'image/jpeg' });
}

async function stopLive(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  const cdp = entry.cdp;
  entry.cdp = undefined;
  if (!cdp) return;
  try {
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
  } catch {
    // The page may already be closed.
  }
}

/**
 * Where a step was written: the first frame of the stack outside this
 * package, so a wrapped `test.step` still reports the recording's line and
 * not the fixtures'.
 * @returns {{ file: string, line: number, column: number } | undefined}
 */
export function callerLocation() {
  const lines = (new Error().stack ?? '').split('\n').slice(1);
  for (const line of lines) {
    // «at fn (C:\x\y.ts:12:3)», «at /x/y.ts:12:3» or a file:// URL (spaces as %20).
    const m = /((?:file:\/\/\/?)?(?:[A-Za-z]:)?[\\/][^():]*?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!m) continue;
    const file = m[1].startsWith('file:') ? fileURLToPath(m[1]) : m[1];
    if (/node_modules|^node:/.test(file) || path.resolve(file).startsWith(PACKAGE_DIR + path.sep)) continue;
    return { file, line: Number(m[2]), column: Number(m[3]) };
  }
  return undefined;
}

/** A location as the cockpit shows it: relative to the project, forward slashes. */
export function showLocation(loc) {
  if (!loc) return undefined;
  return `${path.relative(PROJECT_DIR, loc.file).split(path.sep).join('/')}:${loc.line}`;
}
