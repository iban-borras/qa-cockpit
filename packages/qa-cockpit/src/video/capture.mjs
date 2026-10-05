// The worker's side of a video (`qa-cockpit video`): what a demo video needs
// from a run, recorded while the recording plays. Silent unless the CLI set
// QA_VIDEO_DIR, so a replay never pays for it.
//
// Per person and browser context, in <QA_VIDEO_DIR>/people/<id>-<ms>/:
//   - frames/<ms>.jpg: the page's own CDP screencast, every frame the page
//     paints, named by the wall-clock instant it was painted. Playwright's
//     trace keeps its screencast at 800×450 and its video at 1 Mbit/s VP8,
//     neither of which can be changed; this one comes at the page's size, in
//     CSS pixels, at JPEG quality 92.
//   - events.jsonl: every real click and the first keystroke in a field, as
//     the page saw them (viewport pixels, wall clock), and in «motion» the
//     path the pointer was moved along; and for each page loaded, when it
//     first painted, and first painted content (`paint`), so that the
//     frames before, a blank page or its bare background, are never shown
//     (plan.mjs).
// And <QA_VIDEO_DIR>/steps.jsonl: each step of the recording, its test, and
// when it began and ended, on the same clock as the frames.
//
// Two qualities (QA_VIDEO_MODE):
//   - «guide»: the run as it always plays. A target out of view is scrolled
//     to before Playwright acts on it, so the frame before a click shows
//     what is clicked (without it, Playwright scrolls inside the click and
//     no frame ever shows the target before it is pressed).
//   - «motion»: the app's animations on, and the people paced like people:
//     the pointer glides to a control (hover effects included), waits for
//     the page's animations to end, and types what `fill` would paste.
//     Slower, and for the video only: never a QA run.
//
// Only the tests the video shows are captured (QA_VIDEO_TESTS, when it
// shows some). The tests played before them only build their data: they
// run as in any replay, at their own pace, with nothing recorded.
import fs from 'node:fs';
import path from 'node:path';
import { testIdOf } from './script.mjs';

const DIR = process.env.QA_VIDEO_DIR || '';
export const enabled = Boolean(DIR);
export const MODE = !enabled ? null : process.env.QA_VIDEO_MODE === 'motion' ? 'motion' : 'guide';
const SHOWN = process.env.QA_VIDEO_TESTS ? new Set(process.env.QA_VIDEO_TESTS.split(',')) : null;

/** Whether the video shows this test («T4 · …»): only those are captured. */
export function shows(testTitle) {
  return enabled && (!SHOWN || SHOWN.has(testIdOf(testTitle)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Map<any, any>} page → its capture */
const captures = new Map();

function append(file, record) {
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // A lost line is a lost cursor position, never a red run.
  }
}

/** A step of the recording has ended (fixtures.mjs). */
export function stepRecorded(step) {
  if (!enabled) return;
  fs.mkdirSync(DIR, { recursive: true });
  append(path.join(DIR, 'steps.jsonl'), step);
}

/**
 * The end of a step, made visible: the last paint of every captured page
 * reaches its screencast before the step's end is noted, so the frame that
 * closes the step shows its result. Its images and fonts first: a step's
 * last frame may stay on screen for seconds (a narration longer than the
 * step), and a check that passes before the logo has arrived would hold a
 * page half drawn (found in CritKeep: a header image 1.3 s after the first
 * paint, missing through a whole step). In «motion», the page's animations
 * end too, and the result stays on screen a moment.
 */
export async function settleAll() {
  if (!enabled || captures.size === 0) return;
  await Promise.all(
    [...captures.values()].map(async (c) => {
      await loaded(c.page);
      if (MODE === 'motion') await settle(c.page);
      else await twoFrames(c.page);
    }),
  );
  await sleep(MODE === 'motion' ? 450 : 120);
}

/**
 * Until the images on screen have arrived (or failed) and the fonts are
 * ready, 1.5 s at most. Only those on screen: a lazy image below the fold
 * never loads until it is scrolled to.
 */
async function loaded(page) {
  await page
    .evaluate(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500);
          const onScreen = (img) => {
            // Not shown at all (display: none) has no box.
            if (!img.getClientRects().length) return false;
            // Where it is, not how big: an image still loading may have no
            // width yet (a logo with its height set and its width auto,
            // found in CritKeep), and it is what the step must wait for.
            const r = img.getBoundingClientRect();
            return r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth;
          };
          const waiting = [...document.images]
            .filter((img) => !img.complete && onScreen(img))
            .map(
              (img) =>
                new Promise((done) => {
                  img.addEventListener('load', done, { once: true });
                  img.addEventListener('error', done, { once: true });
                }),
            );
          Promise.all([...waiting, document.fonts.ready]).then(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
    )
    .catch(() => {});
}

/**
 * Start capturing a person's page.
 * @param {string} id the person
 * @param {any} page their page, new and still blank
 * @param {{ name?: string, context?: any }} device
 * @param {(jpegBase64: string) => void} [onFrame] each frame, for the cockpit's live view
 * @param {string} [testTitle] the test the page plays in: nothing is captured for one the video does not show
 */
export async function startCapture(id, page, device, onFrame, testTitle = '') {
  if (!shows(testTitle)) return null;
  const started = Date.now();
  const dir = path.join(DIR, 'people', `${id}-${started}`);
  const framesDir = path.join(dir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const touch = Boolean(device?.context?.hasTouch || device?.context?.isMobile);
  const c = {
    id,
    dir,
    page,
    started,
    viewport,
    touch,
    device: device?.name ?? null,
    frames: 0,
    writes: new Set(),
    events: path.join(dir, 'events.jsonl'),
    // Where the pointer is, in viewport pixels: where a glide starts from.
    mouse: { x: Math.round(viewport.width / 2), y: Math.round(viewport.height * 0.62) },
    busy: false,
    cdp: null,
  };
  captures.set(page, c);
  writeSession(c);
  installPacing(page);

  try {
    if (MODE === 'motion') await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.exposeBinding('__qaVideoEvent', (_source, e) => {
      if (e?.kind === 'click') c.mouse = { x: e.x, y: e.y };
      append(c.events, e);
    });
    await page.addInitScript(eventScript);
  } catch {
    // Without events the frames still come; the video has no cursor.
  }

  try {
    const cdp = await page.context().newCDPSession(page);
    c.cdp = cdp;
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      // When it was painted, not when it arrived: the frame is placed on the
      // same wall clock as the clicks the page reports.
      const ms = Math.round((metadata?.timestamp ?? Date.now() / 1000) * 1000);
      const write = fs.promises
        .writeFile(path.join(framesDir, `${ms}.jpg`), Buffer.from(data, 'base64'))
        .catch(() => {})
        .finally(() => c.writes.delete(write));
      c.writes.add(write);
      c.frames += 1;
      onFrame?.(data);
    });
    const dpr = device?.context?.deviceScaleFactor ?? 1;
    // Asked at the device's pixels; Chromium answers in CSS pixels anyway,
    // which is what the video shows 1:1.
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: Math.round(viewport.width * dpr),
      maxHeight: Math.round(viewport.height * dpr),
      everyNthFrame: 1,
    });
  } catch {
    c.cdp = null;
  }
  return c;
}

// ── a warm run ──
//
// Every person in every test opens a browser context of their own, with an
// empty cache: on a development server (Vite: hundreds of modules) each
// page is fetched whole again, and an image waits in line behind the
// modules (found in CritKeep). In a video's run, the files of the kinds the
// config names (`video.cache`: the app's code, styles and fonts) are kept
// in memory from the first time any context fetches them, and every
// context after gets them from there at once. The run's own: filled from
// the server as it is now, so a video never films an earlier build's code,
// and gone with the run.
/** @type {Map<string, { status: number, headers: Record<string, string>, body: Buffer }>} */
const kept = new Map();

/**
 * A person's context in a video's run, served from the run's cache.
 * Routing turns the browser's own cache off; the run's replaces it. The
 * first fetch of a file is the browser's own, as fast as without a cache,
 * and a copy of its answer is kept: fetched by Playwright instead (its
 * `route.fetch`, in Node), images made a run slower, from 3.0 to 3.7
 * minutes (measured in CritKeep).
 * @param {any} context
 * @param {string[]} kinds Playwright's resource types to keep
 */
export async function cacheFor(context, kinds) {
  if (!enabled || !kinds?.length) return;
  const keep = new Set(kinds);
  const keeps = (request) => request.method() === 'GET' && keep.has(request.resourceType());
  context.on('requestfinished', async (request) => {
    if (!keeps(request) || kept.has(request.url())) return;
    try {
      const response = await request.response();
      if (response?.status() !== 200) return;
      const body = await response.body();
      // As the browser had it once decoded, and without the cookies of
      // somebody else's request.
      const headers = Object.fromEntries(
        Object.entries(response.headers()).filter(([k]) => !/^(content-encoding|content-length|transfer-encoding|set-cookie)$/i.test(k)),
      );
      kept.set(request.url(), { status: 200, headers, body });
    } catch {
      // Not kept (its page closed first): fetched again next time.
    }
  });
  await context
    .route('**/*', (route) => {
      const request = route.request();
      const hit = keeps(request) ? kept.get(request.url()) : undefined;
      return hit ? route.fulfill(hit) : route.fallback();
    })
    .catch(() => {});
}

/**
 * Before a video's run films anything: the pages the config names
 * (`video.warm`), opened and left, to fill the run's cache, so that the
 * first screen filmed loads as fast as the rest.
 * @param {any} context a person's, signed in
 * @param {string[]} urls
 * @param {string[]} kinds `video.cache`
 */
export async function warm(context, urls, kinds) {
  if (!enabled || !urls.length || !kinds?.length) return;
  await cacheFor(context, kinds);
  const page = await context.newPage();
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      await loaded(page);
      // The code a page imports once it runs.
      await sleep(500);
    } catch {
      // A page that does not open warms nothing; the run goes on.
    }
  }
  await page.close().catch(() => {});
  console.log(`qa-cockpit: the video's cache is warm (${kept.size} files from ${urls.length} page${urls.length === 1 ? '' : 's'}).`);
}

/** Where each captured person is: the cover's address bar shows it. */
export function pageUrls() {
  const urls = {};
  for (const c of captures.values()) {
    try {
      urls[c.id] = c.page.url();
    } catch {
      // A page closing: no address.
    }
  }
  return urls;
}

/** Whether this page's frames come from a capture (the cockpit's live view then uses them). */
export function capturing(page) {
  return Boolean(captures.get(page)?.cdp);
}

/** Stop capturing a page, after its last paint has arrived. */
export async function stopCapture(page) {
  const c = captures.get(page);
  if (!c) return;
  captures.delete(page);
  // The screencast closes with the page: what the test painted last would
  // be lost. Two frames and a moment, for the capture, not for the test.
  await twoFrames(page);
  await sleep(250);
  try {
    await c.cdp?.send('Page.stopScreencast');
    await c.cdp?.detach();
  } catch {
    // The page may be gone already.
  }
  await Promise.all([...c.writes]);
  c.ended = Date.now();
  writeSession(c);
}

function writeSession(c) {
  const session = {
    id: c.id,
    started: c.started,
    ended: c.ended ?? null,
    viewport: c.viewport,
    touch: c.touch,
    device: c.device,
    mode: MODE,
    frames: c.frames,
  };
  fs.writeFileSync(path.join(c.dir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
}

async function twoFrames(page) {
  await page
    .evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    .catch(() => {});
}

/** Until the page's finite animations end (1.5 s at most), then two frames. */
async function settle(page) {
  await page
    .evaluate(
      () =>
        new Promise((resolve) => {
          const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
          const running = document.getAnimations().filter((a) => {
            const end = a.effect?.getComputedTiming?.().endTime;
            // A spinner never ends: it is not waited for.
            return a.playState === 'running' && Number.isFinite(end);
          });
          const timer = setTimeout(done, 1500);
          Promise.all(running.map((a) => a.finished.catch(() => {}))).then(() => {
            clearTimeout(timer);
            done();
          });
        }),
    )
    .catch(() => {});
}

// What the page tells about its clicks and typing, through the binding: it
// outlives navigations, which a variable in the page would not. Viewport
// pixels, the frame's own, and the page's clock, the frames' own.
function eventScript() {
  const send = (e) => {
    try {
      window.__qaVideoEvent?.(e);
    } catch {
      // The video is a luxury.
    }
  };
  const recent = new WeakMap();
  addEventListener(
    'click',
    (e) => {
      let x = e.clientX;
      let y = e.clientY;
      // A click from the keyboard carries no position: the element's centre.
      if (e.detail === 0 || (x === 0 && y === 0)) {
        const r = e.target?.getBoundingClientRect?.();
        if (!r) return;
        x = r.left + r.width / 2;
        y = r.top + r.height / 2;
      }
      send({ kind: 'click', at: Date.now(), x: Math.round(x), y: Math.round(y) });
    },
    true,
  );
  // When this document first painted, and first painted content (a text,
  // an image), and when it replaced the one before (the first byte of its
  // response): the frames before its content show a blank page (Chromium's
  // about:blank before the first navigation, white), or its bare background
  // (a dark app paints its html's colour first: an empty screen, both found
  // in CritKeep), or hold the page before. The top document's only: a frame
  // inside paints into its picture.
  if (window.top === window) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (location.href === 'about:blank') continue;
          const contentful = e.name === 'first-contentful-paint';
          if (!contentful && e.name !== 'first-paint') continue;
          const origin = performance.timeOrigin;
          const nav = performance.getEntriesByType('navigation')[0];
          send({ kind: 'paint', start: Math.round(origin + (nav?.responseStart || 0)), at: Math.round(origin + e.startTime), contentful });
        }
      }).observe({ type: 'paint', buffered: true });
    } catch {
      // Without it, a page's first frames may show it blank.
    }
  }
  addEventListener(
    'input',
    (e) => {
      const el = e.target;
      const now = Date.now();
      // A checkbox, a radio or a select fires `input` too, after its click.
      const typing =
        el?.isContentEditable ||
        el?.tagName === 'TEXTAREA' ||
        (el?.tagName === 'INPUT' && !/^(checkbox|radio|range|color|file|button|submit|reset|image)$/i.test(el.type));
      if (!typing || now - (recent.get(el) ?? 0) < 3000) return;
      recent.set(el, now);
      const r = el.getBoundingClientRect();
      send({ kind: 'type', at: now, x: Math.round(r.left + Math.min(28, r.width / 2)), y: Math.round(r.top + r.height / 2) });
    },
    true,
  );
}

// ── pacing ──
//
// The recordings stay as they are: the package wraps Playwright's Locator
// actions instead, once per worker, and only for pages it captures. A
// locator on any other page (a setup's, a guest's) acts as it always did.
const POINTER_ACTIONS = ['click', 'dblclick', 'tap', 'check', 'uncheck', 'setChecked', 'hover', 'selectOption', 'fill'];
let paced = false;

function installPacing(page) {
  if (paced) return;
  paced = true;
  const proto = Object.getPrototypeOf(page.locator('html'));
  for (const name of POINTER_ACTIONS) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = async function paced(...args) {
      const c = captures.get(this.page());
      // Nested (a paced `fill` types through Playwright again): straight through.
      if (!c || c.busy) return original.apply(this, args);
      c.busy = true;
      try {
        return await act(c, this, name, original, args);
      } finally {
        c.busy = false;
      }
    };
  }
}

async function act(c, locator, name, original, args) {
  // The lesson that cost most: bring the target into view first, so a frame
  // shows it before it is pressed. In «motion» the way a person does, with
  // a scroll: Playwright's own jumps there in one frame, and a page that
  // leaps reads as the app's fault (found in CritKeep, on a phone). Then
  // Playwright's, which has nothing left to do.
  if (MODE === 'motion') await scrollSmoothly(locator);
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await twoFrames(c.page);
  if (MODE !== 'motion') return original.apply(locator, args);

  await settle(c.page);
  const box = await locator.boundingBox({ timeout: 5_000 }).catch(() => null);
  if (box && !c.touch) await glide(c, box.x + box.width / 2, box.y + box.height / 2);
  // A beat on the control: its hover state shows, as a person's would.
  await sleep(name === 'hover' ? 450 : c.touch ? 250 : 170);
  let result;
  const text = name === 'fill' ? args[0] : null;
  if (typeof text === 'string' && text.length > 0) {
    try {
      await original.call(locator, '', args[1]);
      await locator.pressSequentially(text, { delay: text.length > 60 ? 18 : 55, timeout: args[1]?.timeout });
    } catch {
      result = await original.apply(locator, args);
    }
  } else {
    result = await original.apply(locator, args);
  }
  await settle(c.page);
  await sleep(300);
  return result;
}

/**
 * A target out of view, brought into it by a smooth scroll, which the
 * browser eases (motion turns reduced motion off, so the page does not cut
 * it short); until it stands still for six frames, 1.5 s at most. Nothing
 * when it is in view already.
 */
async function scrollSmoothly(locator) {
  await locator
    .evaluate(
      (el) =>
        new Promise((done) => {
          const r = el.getBoundingClientRect();
          if (r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth) return done();
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          const began = performance.now();
          let last = null;
          let still = 0;
          const tick = () => {
            const top = el.getBoundingClientRect().top;
            still = last !== null && Math.abs(top - last) < 0.5 ? still + 1 : 0;
            last = top;
            if (still >= 6 || performance.now() - began > 1500) done();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {});
}

/**
 * The pointer to (x, y), eased, as a hand moves; every point is an event.
 * By the clock, not by a count of steps: each move is a round trip to the
 * browser (30 to 45 ms, measured), and steps planned at 16 ms took a long
 * way 1.7 to 2.5 s (found in CritKeep). Now under 0.7 s.
 */
async function glide(c, x, y) {
  const from = c.mouse;
  const distance = Math.hypot(x - from.x, y - from.y);
  if (distance < 2) return;
  const ms = Math.min(650, 250 + distance * 0.45);
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms);
    const e = t * t * (3 - 2 * t);
    const px = from.x + (x - from.x) * e;
    const py = from.y + (y - from.y) * e;
    await c.page.mouse.move(px, py).catch(() => {});
    append(c.events, { kind: 'move', at: Date.now(), x: Math.round(px), y: Math.round(py) });
    if (t >= 1) break;
    await sleep(8);
  }
  c.mouse = { x: Math.round(x), y: Math.round(y) };
}
