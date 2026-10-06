// The worker's side of the cockpit (server/server.mjs). Silent unless
// COCKPIT_URL is set, and never allowed to fail a test: every call here
// swallows its own errors.
//
// Two things travel to the cockpit:
//   - A PHOTO when a step of a recording ends, of every person the step's
//     title names ("8 · Quim, Laia: res" is two), and of every open page when
//     the step fails. A step ends after its own assertions, so the photo is
//     the screen the suite describes, not one half loaded. It is the WHOLE
//     page, with where the person was scrolled to. Before it, a photo of each
//     ACTION the step took, the window just before it (see ACTION PHOTOS
//     below), with its click or its typing marked on it (MARKS). The images
//     go to <out>/cockpit/<run>/frames/ on disk; the cockpit gets their paths.
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

/** @type {Map<string, { actor: string, page: import('@playwright/test').Page, cdp?: any, latest?: string, lastSent: number, timer?: NodeJS.Timeout, marks: any[], requests: any[], acting: boolean, shot: any }>} */
const pages = new Map();
// The same entries by what an action is taken through: a page, its mouse,
// its keyboard (ACTION PHOTOS).
const entries = new WeakMap();
let poller = null;
// The steps of a recording now open: actions are photographed only inside one.
let openSteps = 0;
// The time this worker's photos have taken, all told: a step's own time is
// its time without them (the app's and the recording's), and theirs is said
// apart. Taken as the clock runs, photos side by side counted once.
let photosMs = 0;
let busy = 0;
let busySince = 0;

/** Run fn, its time counted as the photos'. */
async function photoTime(fn) {
  if (busy++ === 0) busySince = Date.now();
  try {
    return await fn();
  } finally {
    if (--busy === 0) photosMs += Date.now() - busySince;
  }
}

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
 * A call of the package's own on a person's page, kept out of the test's
 * trace and report: Playwright's internal calls are in neither, and a photo
 * is none of the recording's actions. Made inside a call of the recording's
 * (Playwright's `clear` fills through one), it would be traced as that
 * call: it fails instead. With a Playwright that has no such thing, a plain
 * call.
 * @template T
 * @param {any} page
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function quietly(page, fn) {
  if (typeof page._wrapApiCall !== 'function') return fn();
  return page._wrapApiCall(async (zone) => {
    if (zone && zone.internal === false) throw new Error('Inside a call of the recording.');
    return await fn();
  }, { internal: true });
}

const newPhotoFile = (actor) => path.join(FRAMES_DIR, `${Date.now()}-${actor}-${Math.random().toString(36).slice(2, 6)}.jpg`);
const relOut = (abs) => path.relative(OUT_DIR, abs).split(path.sep).join('/');
const forget = (shots) => shots.forEach((s) => fs.rm(s.file, { force: true }, () => {}));

/**
 * Photograph one page and tell the cockpit: its photo, and before it the
 * photos of the actions that marked something since the last one.
 * @param {{ actor: string, page: import('@playwright/test').Page, step: string, status: string, test?: string, error?: string, location?: string, outputDir?: string, marks?: any[] }} f
 */
export async function photo(f) {
  if (!enabled || !OUT_DIR) return;
  // The step's actions, numbered in the order they came. One with a photo
  // of its own goes with it (the cockpit draws it at the window's pixels,
  // `vx`, `vy`); one without (outside the actions photographed: the app's
  // own click, the mouse pressed by hand) stays on the step's.
  const marks = (f.marks ?? []).map((m, i) => ({ ...m, n: i + 1 }));
  const shots = [...new Set(marks.map((m) => m.shot).filter(Boolean))];
  const plain = ({ shot, ...m }) => m;
  if (f.page.isClosed()) return forget(shots);
  await photoTime(async () => {
    try {
      fs.mkdirSync(FRAMES_DIR, { recursive: true });
      const file = newPhotoFile(f.actor);
      const t = Date.now();
      // Where the person was looking, before the picture of the whole page.
      const scroll = await quietly(f.page, () => f.page.evaluate(() => ({ x: scrollX, y: scrollY }))).catch(() => ({ x: 0, y: 0 }));
      // Chromium takes a full page beyond the viewport without resizing it,
      // so the page under test never sees its window change.
      await quietly(f.page, () => f.page.screenshot({ path: file, type: 'jpeg', quality: 60, scale: 'css', fullPage: true, timeout: 8_000 }));
      await post('/api/frame', {
        run: RUN,
        actor: f.actor,
        test: f.test ?? '',
        step: f.step,
        status: f.status,
        error: f.error ? stripAnsi(f.error).slice(0, 4000) : null,
        url: f.page.url(),
        file: relOut(file),
        location: f.location ?? null,
        outputDir: f.outputDir ? relOut(f.outputDir) : null,
        viewport: f.page.viewportSize(),
        scroll,
        marks: marks.filter((m) => !m.shot).map(plain),
        shots: shots.map((s) => ({
          file: relOut(s.file),
          url: s.url,
          viewport: s.viewport,
          time: new Date(s.time).toISOString(),
          marks: marks.filter((m) => m.shot === s).map(plain),
        })),
        requests: f.requests ?? [],
        // The device the person plays on: its name and kind, for the card.
        device: f.device ?? null,
        // The step's start and how long it took, the photos aside: where a
        // slow screen shows up. Then theirs: the ones in the step, and this.
        began: f.began ? new Date(f.began).toISOString() : null,
        ms: Number.isFinite(f.ms) ? f.ms : null,
        photosMs: (f.photosMs ?? 0) + Date.now() - t,
        time: new Date().toISOString(),
      });
    } catch {
      // A photo that fails is a photo missing, never a red run; the photos
      // of its actions go with it.
      forget(shots);
    }
  });
}

/**
 * A step of a recording begins: its actions are photographed from now.
 * Returns the photos' clock, for its end to tell their time apart.
 */
export function stepBegan() {
  if (enabled) openSteps += 1;
  return photosMs;
}

/**
 * A step of a recording has ended.
 * @param {{ title: string, status: 'passed'|'failed', error?: unknown, began?: number, photosFrom?: number, test: string, location?: string, outputDir?: string }} s
 */
export async function stepEnded(s) {
  if (!enabled) return;
  openSteps = Math.max(0, openSteps - 1);
  const ended = Date.now();
  // The photos taken in the step: its actions', a step's within it.
  const inside = Number.isFinite(s.photosFrom) ? Math.max(0, photosMs - s.photosFrom) : 0;
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
        ms: s.began ? Math.max(0, ended - s.began - inside) : null,
        photosMs: inside,
      }),
    ),
  );
}

// MARKS: every real click and the first keystroke in a field, as the page
// sees them, told to this worker through a binding (it outlives the
// page's navigations, which a variable in the page would not). Positions
// in the document, the frame of the full-page photo, and in the window,
// the frame of an action's photo; a click that navigated away keeps the
// URL it happened on.
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
      window.__qaCockpitMark?.({
        kind,
        x: Math.round(x + scrollX),
        y: Math.round(y + scrollY),
        vx: Math.round(x),
        vy: Math.round(y),
        url: location.href,
        label: label(el),
      });
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

// ACTION PHOTOS: the window just before each action of a step (a click, a
// field filled, a key pressed), so that the action's mark lies on what it
// was done to. The step's own photo comes after the step's checks: a modal
// opened and closed in between is gone from it, and its clicks drawn there
// point at nothing (found in CritKeep: five clicks in three modals,
// floating over the list behind them). The target is brought into view as
// the action itself would (else the photo shows the screen before that
// scroll), and the action then has nothing left to scroll. All of it as
// Playwright's internal calls: no trace and no report shows them. A photo
// whose action marked nothing (Escape, Tab) is deleted.
//
// The recordings stay as they are: Playwright's own actions are wrapped,
// once per worker, at the Frame, which a Locator's and a Page's go
// through, and at the keyboard and the mouse.

// How long the target may take to come before its action's photo is given
// up: the action then waits on its own, and fails with its own error if it
// never comes. An action with a timeout of its own waits no longer than it.
const BEFORE_MS = 5_000;
// The actions wrapped, and what their target must be first: «seen»
// (visible, as Playwright's pointer actions and `fill` wait for) or only
// «there» (a key pressed on it).
const FRAME_ACTIONS = { click: 'seen', dblclick: 'seen', tap: 'seen', check: 'seen', uncheck: 'seen', fill: 'seen', press: 'there', type: 'there' };
let photographing = false;

function installActionPhotos(page) {
  if (photographing) return;
  photographing = true;
  const optionsIn = (args) => args.slice(1).find((a) => a && typeof a === 'object' && !Array.isArray(a)) ?? {};
  const frame = Object.getPrototypeOf(page.mainFrame());
  for (const [name, need] of Object.entries(FRAME_ACTIONS)) {
    wrapAction(frame, name, (f) => entries.get(f.page?.()), (entry, f, args) =>
      ready(entry, f, f.locator(args[0]).first(), need, optionsIn(args)),
    );
  }
  // A Locator's `clear` fills inside a call of Playwright's own, where no
  // photo can be taken unseen (`quietly`): it is photographed here, before
  // that call, and its fill goes straight through. So is the mouse's
  // `dblclick`, which clicks inside one.
  wrapAction(Object.getPrototypeOf(page.locator('html')), 'clear', (l) => entries.get(l.page?.()), (entry, l, args) =>
    ready(entry, l._frame, l.first(), 'seen', args[0] ?? {}),
  );
  for (const name of ['click', 'dblclick']) wrapAction(Object.getPrototypeOf(page.mouse), name, (m) => entries.get(m));
  for (const name of ['press', 'type', 'insertText']) wrapAction(Object.getPrototypeOf(page.keyboard), name, (k) => entries.get(k));
}

/**
 * One of Playwright's actions, photographed first when it is taken on a
 * person's page inside a step: the photo is `entry.shot` while it lasts,
 * and the marks that come meanwhile are on it.
 */
function wrapAction(proto, name, entryOf, prepare) {
  const original = proto?.[name];
  if (typeof original !== 'function') return;
  proto[name] = async function photographed(...args) {
    const entry = entryOf(this);
    // Nobody's page, outside a step, or inside another action (a
    // `setChecked` checks through `check`): as Playwright takes it.
    if (!entry || entry.acting || openSteps === 0) return original.apply(this, args);
    entry.acting = true;
    try {
      entry.shot = await shoot(entry, () => prepare?.(entry, this, args));
      return await original.apply(this, args);
    } finally {
      const shot = entry.shot;
      entry.shot = null;
      entry.acting = false;
      if (shot && !shot.marked) forget([shot]);
    }
  };
}

/**
 * An action's target as the action itself will have it: visible when it
 * waits for that, and scrolled into view. Throws when it is not, in time:
 * no photo then. False: an action that is not taken (a trial).
 */
async function ready(entry, frame, target, need, options) {
  if (options.trial) return false;
  const limit = timeoutOf(frame, options);
  const timeout = limit > 0 ? Math.min(limit, BEFORE_MS) : BEFORE_MS;
  const seen = need === 'seen' && !options.force;
  await quietly(entry.page, async () => {
    // The target as it is now, without waiting: most often there, seen and
    // in view, and this one look is all the photo asks of it.
    let where = await photoTime(() => target.evaluateAll(whereIs));
    // Not there yet, or not seen: the action would wait for it all the
    // same, and that wait is the app's time, not the photo's.
    if (where === 'absent' || (seen && where === 'hidden')) {
      await target.waitFor({ state: seen ? 'visible' : 'attached', timeout });
      where = await photoTime(() => target.evaluateAll(whereIs));
    }
    // Where Playwright's own scroll would bring it, so that it scrolls no
    // more. That scroll first waits for the target to stand still for two
    // frames (33 ms, twice the photo): only when the target is not wholly
    // in view already. A target nobody can see (a key pressed on a hidden
    // field) is not scrolled to.
    if (where === 'out' && options.scroll !== 'none') await target.scrollIntoViewIfNeeded({ timeout });
  });
}

/**
 * In the page, the target's element: its whole box in view («in»), or not
 * («out»); «hidden» when nobody sees it, as Playwright tells (no box,
 * `visibility`, a closed `<details>`...), and «absent» when there is none.
 */
function whereIs([el]) {
  if (!el) return 'absent';
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height || getComputedStyle(el).visibility !== 'visible' || el.checkVisibility?.() === false) return 'hidden';
  // In a frame, Playwright scrolls the frame too: its own way, always.
  if (window.top !== window) return 'out';
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return 'out';
  // Inside every box that clips it (a modal's scrolling body), not under its edge.
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (!/auto|scroll|hidden|clip/.test(s.overflowX + s.overflowY)) continue;
    const b = p.getBoundingClientRect();
    const top = b.top + p.clientTop;
    const left = b.left + p.clientLeft;
    if (r.top < top || r.left < left || r.bottom > top + p.clientHeight || r.right > left + p.clientWidth) return 'out';
  }
  return 'in';
}

/** An action's own timeout, as Playwright works it out: 0 for none (Playwright Test's default). */
function timeoutOf(frame, options) {
  if (typeof options.timeout === 'number') return options.timeout;
  try {
    const t = frame?._timeout?.(options);
    const ms = typeof t === 'number' ? t : t?.timeout;
    if (Number.isFinite(ms)) return ms;
  } catch {
    // Another Playwright's: none, then.
  }
  return 0;
}

/** The window now, for the action about to be taken; null when there is none. */
async function shoot(entry, prepare) {
  try {
    if ((await prepare()) === false || entry.page.isClosed()) return null;
    fs.mkdirSync(FRAMES_DIR, { recursive: true });
    const file = newPhotoFile(entry.actor);
    // The window as it is: not even the caret hidden, which a photo of
    // Playwright's does by touching every field's style.
    await photoTime(() =>
      quietly(entry.page, () => entry.page.screenshot({ path: file, type: 'jpeg', quality: 60, scale: 'css', caret: 'initial', timeout: BEFORE_MS })),
    );
    return { file, url: entry.page.url(), viewport: entry.page.viewportSize(), time: Date.now(), marked: false };
  } catch {
    // No photo for this action: its mark stays on the step's.
    return null;
  }
}

/**
 * A person's page exists: it can now be photographed, marked and watched.
 * @param {string} actor
 * @param {any} page
 * @param {{ name: string, kind: string, width?: number, height?: number } | null} [device]
 */
export async function register(actor, page, device = null) {
  if (!enabled) return;
  const entry = { actor, page, device, lastSent: 0, marks: [], requests: [], acting: false, shot: null };
  pages.set(actor, entry);
  for (const by of [page, page.mouse, page.keyboard]) entries.set(by, entry);
  installActionPhotos(page);
  // The page's own requests (the app's API calls and its page loads), with
  // how long each took: a step slow because of the app, not because of the
  // recording's own waits, shows here.
  const kept = (request) => ['fetch', 'xhr', 'document'].includes(request.resourceType());
  const keep = (request, status) => {
    const type = request.resourceType();
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
    // Its status is one more call to the browser: only for the ones kept,
    // not for each of a development server's hundreds of modules.
    if (!kept(request)) return;
    request
      .response()
      .then((response) => keep(request, response?.status() ?? 0))
      .catch(() => {});
  });
  page.on('requestfailed', (request) => {
    if (kept(request)) keep(request, 0);
  });
  try {
    await page.context().exposeBinding('__qaCockpitMark', (_source, mark) => {
      if (entry.marks.length >= 100) return;
      // One click, one mark: a label clicked clicks its field too, and a
      // double click is two, at the same point within a moment, in the
      // same action (two of the recording's, on one button, are two).
      const last = entry.marks.at(-1);
      const again = last?.kind === 'click' && last.shot === entry.shot && last.vx === mark.vx && last.vy === mark.vy;
      if (mark.kind === 'click' && again && Date.now() - last.at < 300) return;
      // Made by the action being photographed: on its photo. Playwright
      // delivers it before the action returns.
      const shot = entry.shot;
      if (shot) shot.marked = true;
      // When it came, from this clock: the step's start is on it too.
      entry.marks.push({ ...mark, at: Date.now(), shot });
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
  // Photos of actions that no step's photo took along: nobody sees them.
  forget([...new Set(entry.marks.map((m) => m.shot).filter(Boolean))]);
  entry.marks = [];
  await stopLive(entry);
  // Nobody's page left: the test is over, and no step of it is open (one
  // cut short by a timeout never said it ended).
  if (pages.size === 0) openSteps = 0;
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
