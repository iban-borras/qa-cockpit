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
//     path the pointer was moved along.
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
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.QA_VIDEO_DIR || '';
export const enabled = Boolean(DIR);
export const MODE = !enabled ? null : process.env.QA_VIDEO_MODE === 'motion' ? 'motion' : 'guide';

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
 * closes the step shows its result. In «motion», the page's animations end
 * first, and the result stays on screen a moment.
 */
export async function settleAll() {
  if (!enabled) return;
  await Promise.all(
    [...captures.values()].map(async (c) => {
      if (MODE === 'motion') await settle(c.page);
      else await twoFrames(c.page);
    }),
  );
  await sleep(MODE === 'motion' ? 450 : 120);
}

/**
 * Start capturing a person's page.
 * @param {string} id the person
 * @param {any} page their page, new and still blank
 * @param {{ name?: string, context?: any }} device
 * @param {(jpegBase64: string) => void} [onFrame] each frame, for the cockpit's live view
 */
export async function startCapture(id, page, device, onFrame) {
  if (!enabled) return null;
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
  // shows it before it is pressed.
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

/** The pointer to (x, y), eased, as a hand moves; every point is an event. */
async function glide(c, x, y) {
  const from = c.mouse;
  const distance = Math.hypot(x - from.x, y - from.y);
  if (distance < 2) return;
  const ms = Math.min(800, 300 + distance * 0.55);
  const n = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    const e = t * t * (3 - 2 * t);
    const px = from.x + (x - from.x) * e;
    const py = from.y + (y - from.y) * e;
    await c.page.mouse.move(px, py).catch(() => {});
    append(c.events, { kind: 'move', at: Date.now(), x: Math.round(px), y: Math.round(py) });
    await sleep(ms / n - 4);
  }
  c.mouse = { x: Math.round(x), y: Math.round(y) };
}
