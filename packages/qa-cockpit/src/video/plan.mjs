// What a video shows at every instant, from what a run captured
// (capture.mjs): the cards, each step's screens, the cursor, the ripples,
// the subtitles; and what it plays: the tics and the narration. The picture
// itself is drawn by the stage (render.mjs, stage.html).
//
// Two ways to tell a step:
//   - «guide»: a step lasts what its subtitle takes to read (or its
//     narration to say). For each click, the screen as it was just before,
//     the cursor gliding to the control, a ripple and a tic, then the screen
//     after; at the end, the step's result, held. Ideal for training.
//   - «motion»: the step plays in real time, every frame the page painted,
//     with the still moments (a server thinking, a test waiting) cut short.
//     The cursor follows the path the pointer really took.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plain, stepParts, stepsApart, testIdOf, testTitleOf } from './script.mjs';

export const W = 1280;
export const H = 720;
export const BAND = 120;

const GLIDE = 0.55; // s, the cursor's way to a control (guide)
const TOUCH_WAIT = 0.35; // s, a finger's pause before it taps (guide)
const SWITCH = 0.12; // s after the press, the screen answers (guide)
const RIPPLE = 0.45; // s, a ripple's life
const FADE = 0.3; // s, a card in or out over a step
const EXIT = 0.45; // s, a card's content leaving for another card
const SETTLED = 2.6; // s, every card's entrance is over (stage.html)
const SUBTITLE_IN = 0.6; // s, a new subtitle rising into place
const SWAP = 0.45; // s, the screens of one step fading in over another's
const LOAD = 0.25; // s, motion: a page's load until its content, however long it took

/** Which screens a picture shows, and where: a step that changes them fades the new ones in. */
const screensOf = (state) => JSON.stringify(state.panels.map((p) => [p.who, p.x, p.y, p.w, p.h]));

/**
 * The first moments of a step that shows other screens than the step before
 * (a laptop, then a phone): the new screens fade in over the old ones and
 * rise a touch into place, instead of a cut. The same screens changing is
 * the app at work, and cuts as it did.
 * @param {any} before the last picture of the step before
 * @param {any} after this step's picture
 * @param {number} k 0..1 through the swap
 */
function swapped(before, after, k) {
  if (screensOf(before) === screensOf(after)) return after;
  const c = Math.max(0, Math.min(1, k));
  // The new screens come in quickly and slow down; the old ones leave late.
  // Fading both at once would dim the picture halfway through.
  const e = 1 - (1 - c) ** 3;
  const gone = c ** 3;
  // Their labels take turns: the old one is gone by halfway, the new one
  // comes after it. Both at once, in the same place, read as one smudge
  // («Marta · Game Master» over «Laia · Player»).
  const smooth = (x) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  const oldLabel = Number((1 - smooth(c / 0.5)).toFixed(3));
  const newLabel = Number(smooth((c - 0.5) / 0.5).toFixed(3));
  return {
    ...after,
    panels: [
      ...before.panels.map((p) => ({ ...p, opacity: Number((1 - gone).toFixed(3)), labelOpacity: oldLabel })),
      ...after.panels.map((p) => ({ ...p, opacity: Number(e.toFixed(3)), labelOpacity: newLabel, dy: Number(((1 - e) * 14).toFixed(2)) })),
    ],
    cursors: after.cursors.map((cur) => ({ ...cur, opacity: Number(((cur.opacity ?? 1) * e).toFixed(3)) })),
  };
}

/** What the cover's address bar says: the page's address, without its scheme. */
function addressOf(href) {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return '';
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '';
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/** A JPEG's size, from its frame header, or null. */
function jpegSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 2; i + 8 < n; ) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      // The start of a frame (SOF0..SOF15; C4, C8 and CC are other markers).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * A page's frames, without those of another size than its own. A
 * screenshot of the whole page (the cockpit's photo of a step, a suite's
 * own) makes the screencast send the tall page squeezed into the
 * viewport's height (507×720 where the page is 1280×720), which the video
 * stretched back: the page squashed for a moment (found in CritKeep). The
 * page's own size is the one most of its frames have.
 */
function sameSizeFrames(framesDir, frames) {
  const sizes = frames.map((ms) => jpegSize(path.join(framesDir, `${ms}.jpg`)));
  const count = new Map();
  for (const s of sizes) if (s) count.set(`${s.w}x${s.h}`, (count.get(`${s.w}x${s.h}`) ?? 0) + 1);
  const own = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!own) return frames;
  return frames.filter((_, i) => !sizes[i] || `${sizes[i].w}x${sizes[i].h}` === own);
}

/**
 * A page's frames, without those before it first painted content (a text,
 * an image; capture.mjs, `paint`): Chromium's about:blank before the first
 * navigation, white, which showed whenever a person came on screen before
 * their page had painted, and the page's bare background before its
 * content, an empty screen (both found in CritKeep); and, at each later
 * navigation, the moments between the new page's arrival and its content,
 * which show the page before or nothing. The frame before them stays on
 * screen instead, as a browser does. A page that never paints content
 * counts from its first paint. A capture made before 0.6.0 says no paint,
 * and keeps every frame.
 * @returns {{ frames: number[], loads: number[] }} the frames kept, and the
 *   first of each page: the end of its load (`motion` cuts the wait for it short)
 */
function paintedFrames(frames, paints) {
  if (!paints.length) return { frames, loads: [] };
  // One per page (its start): its first content, or its first paint.
  const pages = new Map();
  for (const p of paints) {
    const had = pages.get(p.start);
    if (!had || (p.contentful && !had.contentful)) pages.set(p.start, p);
  }
  // The frame that shows a paint is the one nearest to it: the page's clock
  // and the frames' differ by a few milliseconds (1 to 4, measured), and on
  // a page that loads fast the blank frame comes only 27 ms before.
  const shownAt = (at) => {
    let best = null;
    for (const ms of frames) if (Math.abs(ms - at) <= 40 && (best === null || Math.abs(ms - at) < Math.abs(best - at))) best = ms;
    return best ?? at - 5;
  };
  const shown = [...pages.values()].map((p) => ({ start: p.start, from: shownAt(p.at) }));
  const first = Math.min(...shown.map((p) => p.from));
  const between = shown.filter((p) => Number.isFinite(p.start) && p.start < p.from).map((p) => [p.start, p.from]);
  const kept = frames.filter((ms) => ms >= first && !between.some(([a, b]) => ms >= a && ms < b));
  const loads = shown.map((p) => kept.find((ms) => ms >= p.from)).filter((ms) => ms !== undefined);
  return { frames: kept, loads };
}

/**
 * How long each page a person loaded took, from its response to its first
 * content (its first paint, when it painted no content), in ms.
 * @param {{ start: number, at: number, contentful?: boolean }[]} paints
 */
export function pageLoads(paints) {
  const pages = new Map();
  for (const p of paints) {
    if (!Number.isFinite(p.start)) continue;
    const had = pages.get(p.start);
    if (!had || (p.contentful && !had.contentful)) pages.set(p.start, p);
  }
  return [...pages.values()].map((p) => Math.max(0, p.at - p.start));
}

/** A run's capture, as the video reads it. */
export function loadCapture(dir) {
  const metaFile = path.join(dir, 'capture.json');
  if (!fs.existsSync(metaFile)) throw new Error(`No capture in ${dir} (capture.json is missing).`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const steps = readJsonl(path.join(dir, 'steps.jsonl'));
  const sessions = [];
  const peopleDir = path.join(dir, 'people');
  for (const name of fs.existsSync(peopleDir) ? fs.readdirSync(peopleDir) : []) {
    const sdir = path.join(peopleDir, name);
    const file = path.join(sdir, 'session.json');
    if (!fs.existsSync(file)) continue;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const framesDir = path.join(sdir, 'frames');
    const frames = (fs.existsSync(framesDir) ? fs.readdirSync(framesDir) : [])
      .map((f) => Number.parseInt(f, 10))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const all = readJsonl(path.join(sdir, 'events.jsonl')).sort((a, b) => a.at - b.at);
    const paints = all.filter((e) => e.kind === 'paint' && Number.isFinite(e.at));
    const events = all.filter((e) => e.kind !== 'paint');
    const painted = paintedFrames(sameSizeFrames(framesDir, frames), paints);
    sessions.push({ ...s, ended: s.ended ?? Number.POSITIVE_INFINITY, dir: sdir, framesDir, frames: painted.frames, loads: painted.loads, paints, events });
  }
  return { dir, meta, steps, sessions };
}

/** The last frame painted at or before `t` (ms), or null. */
export function frameAt(session, t) {
  const f = session.frames;
  let lo = 0;
  let hi = f.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid] <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === -1 ? null : { ms: f[best], index: best, file: path.join(session.framesDir, `${f[best]}.jpg`) };
}

/**
 * What a person's screen shows at `t`: the last frame painted, or, before
 * their page painted at all, its first one (never an empty box).
 */
function screenAt(session, t) {
  const f = frameAt(session, t);
  if (f || !session.frames.length) return f;
  return { ms: session.frames[0], index: 0, file: path.join(session.framesDir, `${session.frames[0]}.jpg`) };
}

/**
 * The cover a script asks for: «T5/3» or «T5/3 end» (the step's end),
 * «T5/3 press 2» (half a second after its second press: what it did, a
 * second press of the same, an effect), «T5/3 press 2 +0.8» (that long
 * after it), «T5/3 2.4» (seconds after the step began, as it played); or
 * the same as `{ "step": "T5/3", "at": "press 2", "people": [...] }`.
 */
function coverWanted(cover) {
  const spec = typeof cover === 'string' ? { step: cover } : (cover ?? {});
  if (!spec.step) return { people: spec.people };
  const [step, ...rest] = String(spec.step).trim().split(/\s+/);
  const at = spec.at !== undefined ? String(spec.at) : rest.join(' ');
  const m = /^(?:(end)|press(?:\s+(\d+))?(?:\s*\+\s*(\d+(?:\.\d+)?))?|(\d+(?:\.\d+)?))?$/.exec(at.trim());
  if (!m) throw new Error(`The video script's cover is ${JSON.stringify(cover)}: a step ("T5/3"), and "end", "press", "press 2", "press 2 +0.8" or seconds into it ("T5/3 2.4").`);
  if (m[4] !== undefined) return { step, people: spec.people, seconds: Number(m[4]) };
  if (at.trim().startsWith('press')) return { step, people: spec.people, press: Number(m[2] ?? 1), after: m[3] !== undefined ? Number(m[3]) : 0.5 };
  return { step, people: spec.people };
}

/**
 * When a step's narration starts (its script's `voiceAt`): a number of
 * seconds into the step, or one of its presses («press», «press 2»).
 * @returns {number | null} seconds into the step, or null when the step has no such press
 */
function voiceStart(key, voiceAt, presses) {
  if (typeof voiceAt === 'number' && Number.isFinite(voiceAt) && voiceAt >= 0) return voiceAt;
  const m = /^press(?:\s+(\d+))?$/.exec(String(voiceAt).trim());
  if (!m) throw new Error(`The video script's step ${key} says "voiceAt": ${JSON.stringify(voiceAt)}: seconds into the step, "press" or "press 2".`);
  return presses[Number(m[1] ?? 1) - 1] ?? null;
}

/** The session of a person that was open at `t`. */
function sessionAt(sessions, id, t) {
  const own = sessions.filter((s) => s.id === id);
  return own.find((s) => s.started <= t && t <= s.ended) ?? own.sort((a, b) => Math.abs(a.started - t) - Math.abs(b.started - t))[0] ?? null;
}

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Where each screen goes: one 1280×720 screen fills the picture; others share it, scaled, each with its label. */
export function layout(viewports) {
  const n = viewports.length;
  if (n === 1 && viewports[0].width === W && viewports[0].height === H) return [{ x: 0, y: 0, w: W, h: H, bleed: true }];
  const PAD = 28;
  const GAP = 28;
  const LABEL = 34;
  const totalW = viewports.reduce((a, v) => a + v.width, 0);
  const maxH = Math.max(...viewports.map((v) => v.height));
  const room = H - 2 * PAD - LABEL;
  const s = Math.min(1, (W - 2 * PAD - GAP * (n - 1)) / totalW, room / maxH);
  const rowW = totalW * s + GAP * (n - 1);
  let x = (W - rowW) / 2;
  const top = PAD + LABEL + (room - maxH * s) / 2;
  return viewports.map((v) => {
    const w = Math.round(v.width * s);
    const h = Math.round(v.height * s);
    const box = { x: Math.round(x), y: Math.round(top + (maxH * s - h) / 2), w, h, bleed: false };
    x += v.width * s + GAP;
    return box;
  });
}

const smooth = (t) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/**
 * The whole video, as shots on one clock.
 * @param {object} o
 * @param {any} o.config resolved config
 * @param {ReturnType<typeof loadCapture>} o.capture
 * @param {{ title: string, tests: Map<string, any> }} o.suite readSuite()
 * @param {{ data: any }} o.script readScript()
 * @param {'guide'|'motion'} o.mode
 * @param {(key: string) => { file: string, duration: number } | null} o.voice the narration of a card or step
 * @param {number} [o.fps] the video's frames per second: its first frame is the poster
 */
export function buildPlan({ config, capture, suite, script, mode, voice, fps = 25 }) {
  const data = script.data ?? {};
  const cards = data.cards ?? {};
  const stepsCfg = data.steps ?? {};
  const pace = { min: 2.8, max: 6.5, charsPerSecond: 18, ...(data.pace ?? {}) };
  const readSeconds = (chars) => Math.max(pace.min, Math.min(pace.max, 1 + chars / pace.charsPerSecond));
  const wanted = Array.isArray(data.tests) && data.tests.length ? new Set(data.tests) : null;
  const castName = (id) => config.cast.find((p) => p.id === id)?.name ?? id;
  const roleOf = (id) => config.video.roles?.[id] ?? null;
  const personByWord = (word) => config.cast.find((p) => fold(p.name) === fold(word) || p.id === fold(word));
  const url = (file) => (file ? pathToFileURL(file).href : null);

  // A capture holds only the tests its own run showed (capture.mjs): a
  // script drawn again over it cannot show one it does not have.
  if (wanted) {
    const held = new Set(capture.steps.map((s) => testIdOf(s.test)).filter(Boolean));
    const missing = [...wanted].filter((id) => !held.has(id));
    if (missing.length) {
      const has = held.size ? `it has ${[...held].join(', ')}` : 'it has no test';
      throw new Error(`This capture has no ${missing.join(', ')} (${has}): \`video ${capture.meta.suite}\` with this script makes a new one.`);
    }
  }

  // The steps of the run, grouped by test, in the order they ran.
  const tests = [];
  for (const step of capture.steps) {
    const id = testIdOf(step.test);
    const parts = stepParts(step.title);
    if (!id || !parts) continue;
    if (wanted && !wanted.has(id)) continue;
    const key = `${id}/${parts.n}`;
    if (stepsCfg[key]?.skip) continue;
    let t = tests.find((x) => x.id === id && x.title === step.test);
    if (!t) {
      t = { id, title: step.test, steps: [] };
      tests.push(t);
    }
    t.steps.push({ ...step, key, parts });
  }
  if (!tests.length) throw new Error('The capture has no step to show: are the steps named «n · Who: what they do», and the tests «T1 · …»?');

  // What the render says before it draws: what the video may get wrong.
  const notes = [];
  const apart = stepsApart(
    suite,
    capture.steps.filter((step) => !wanted || wanted.has(testIdOf(step.test))),
    { cast: config.cast, scriptSteps: stepsCfg },
  );
  if (apart.length) {
    notes.push(
      "A step's subtitle is the suite's row with its number, and these steps and rows do not match:",
      ...apart.map((line) => `  ${line}`),
      '  Number each step as its row, or give the step its own "subtitle" in the video script.',
    );
  }

  /** @type {any[]} */
  const shots = [];
  const cursorAt = new Map(); // person → last cursor position, viewport pixels

  // ── cards ──
  // A card's elements enter one after the other and settle (stage.html);
  // its clock stops once they have, so its still frames are drawn once.
  const card = (kind, content, minimum, v) => {
    const duration = Math.max(minimum, v ? v.duration + 1.0 : 0);
    const shot = {
      kind: 'card',
      card: kind,
      duration,
      voice: v ? { file: v.file, at: 0.4 } : null,
      ticks: [],
      keys: [{ u: Math.min(duration - 0.05, content.hero?.length ? SETTLED : 1.4), caption: content.title }],
    };
    shot.at = (u) => {
      const next = shots[shots.indexOf(shot) + 1];
      const left = duration - u;
      return {
        panels: [],
        cursors: [],
        ripples: [],
        subtitle: null,
        card: {
          kind,
          ...content,
          t: Number(Math.min(u, SETTLED).toFixed(3)),
          // Before another card, its content fades on the way out.
          out: next?.kind === 'card' && left < EXIT ? Number(left.toFixed(3)) : null,
          opacity: 1,
        },
        // The video ends on its last card, still: its last frame is the
        // card, what a player shows once it is over. To black only when the
        // config asks (`video.fadeOut`).
        fade: kind === 'intro' ? Math.max(0, 1 - u / 0.5) : kind === 'outro' && config.video.fadeOut ? Math.max(0, 1 - left / 0.8) : 0,
      };
    };
    shots.push(shot);
  };

  // The cover: the title over the app itself, its screens rising from below
  // in a flat browser (and a phone, when somebody plays on one).
  const logo = url(config.video.logo);
  const title = data.title ?? suite.title;
  const product = config.video.product;
  const hero = coverOf();
  const named = product && product !== title ? product : '';
  card(
    'intro',
    { title, subtitle: data.subtitle ?? '', logo, tag: hero.length ? named : '', footer: hero.length ? '' : named, hero },
    hero.length ? 3.8 : 2.8,
    voice('intro'),
  );

  for (const t of tests) {
    const c = cards[t.id] ?? {};
    card('test', { tag: t.id, title: c.title ?? suite.tests.get(t.id)?.title ?? testTitleOf(t.title) }, 1.8, voice(t.id));
    for (const step of t.steps) shots.push(stepShot(step, t.id));
  }

  const outro = cards.outro ?? {};
  card('outro', { title: outro.title ?? product, subtitle: outro.subtitle ?? '', logo }, 3, voice('outro'));

  // A step that opens on other screens than the step before fades them in
  // (SWAP): its first press waits for that, or the finger lands as the new
  // screen settles, seen whole for a tenth of a second (found in CritKeep,
  // a laptop then a phone). Its own clock starts SWAP later; its subtitle
  // rises from the start.
  for (let i = 1; i < shots.length; i += 1) {
    const s = shots[i];
    const prev = shots[i - 1];
    if (s.kind !== 'step' || prev.kind !== 'step' || !s.clicks) continue;
    if (screensOf(prev.at(prev.duration - 1e-3)) === screensOf(s.at(0))) continue;
    const inner = s.at;
    shots[i] = {
      ...s,
      duration: s.duration + SWAP,
      ticks: s.ticks.map((u) => u + SWAP),
      keys: s.keys.map((k) => ({ ...k, u: k.u + SWAP })),
      // A voice that starts on a press waits with it.
      voice: s.voice?.onPress ? { ...s.voice, at: s.voice.at + SWAP } : s.voice,
      at: (u) => {
        const state = inner(Math.max(0, u - SWAP));
        return state.subtitle ? { ...state, subtitle: { ...state.subtitle, age: Number(Math.min(u, SUBTITLE_IN).toFixed(3)) } } : state;
      },
    };
  }

  // The poster: one frame of the cover, finished, before it builds itself.
  // A player shows the first frame until somebody presses play, and the
  // cover's first frames are black (it fades in from black).
  const cover = shots[0];
  shots.unshift({
    kind: 'poster',
    duration: 1 / fps,
    voice: null,
    ticks: [],
    keys: [],
    at: () => ({ ...cover.at(SETTLED), fade: 0 }),
  });

  // ── the clock ──
  let start = 0;
  for (const s of shots) {
    s.start = start;
    start += s.duration;
  }
  const duration = start;

  function shotAt(t) {
    let lo = 0;
    let hi = shots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (shots[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The picture at `t` seconds: a card fades in over the step before it, and out over the one after. */
  function at(t) {
    const i = shotAt(t);
    const s = shots[i];
    const u = t - s.start;
    const state = s.at(u);
    const prev = shots[i - 1];
    const next = shots[i + 1];
    if (s.kind === 'step') return u < SWAP && prev?.kind === 'step' ? swapped(prev.at(prev.duration - 1e-3), state, u / SWAP) : state;
    if (s.kind !== 'card') return state;
    if (u < FADE && prev?.kind === 'step') {
      return { ...prev.at(prev.duration - 1e-3), card: { ...state.card, opacity: u / FADE }, fade: state.fade };
    }
    if (s.duration - u < FADE && next?.kind === 'step') {
      return { ...next.at(0), card: { ...state.card, opacity: (s.duration - u) / FADE }, fade: state.fade };
    }
    return state;
  }

  const ticks = shots.flatMap((s) => s.ticks.map((u) => s.start + u));
  const voices = shots.filter((s) => s.voice).map((s) => ({ file: s.voice.file, at: s.start + s.voice.at }));
  const keys = shots.flatMap((s) => s.keys.map((k) => ({ t: s.start + k.u, caption: k.caption })));
  const clicks = shots.reduce((a, s) => a + (s.clicks ?? 0), 0);
  return { duration, shots, at, ticks, voices, keys, clicks, steps: shots.filter((s) => s.kind === 'step').length, notes };

  /**
   * The cover's screens: the moment the script names (`cover`): the step
   * that, seen alone, tells what the video is about, at its end or at one
   * of its presses; or, unnamed, the end of the step that shows most of the
   * app (a computer counts more than a phone, both more than either). Of
   * equals, the last of the first test that has one: a story's result
   * rather than its empty start.
   */
  function coverOf() {
    if (data.cover === false || data.cover === null) return [];
    const want = coverWanted(data.cover);
    const all = tests.flatMap((t, ti) => t.steps.map((step) => ({ step, ti })));
    const screensOf = (step, ids, t = step.ended) => ids.map((id) => sessionAt(capture.sessions, id, t)).filter((s) => s && frameAt(s, t));
    const score = (step) => {
      const ss = screensOf(step, step.people ?? []);
      return (ss.some((s) => !s.touch) ? 2 : 0) + (ss.some((s) => s.touch) ? 1 : 0);
    };
    let pick = want.step ? all.find((x) => x.step.key === want.step) : null;
    if (want.step && !pick) notes.push(`The script's cover is ${want.step}, a step this video does not show: the cover shows the one that shows most of the app.`);
    if (!pick) {
      let best = 0;
      for (const x of all) {
        const sc = score(x.step);
        if (sc > best || (sc > 0 && sc === best && x.ti === pick.ti)) {
          best = sc;
          pick = x;
        }
      }
    }
    if (!pick) return [];
    const { step } = pick;
    const ids = want.people ?? step.people ?? [];
    // The moment: the step's end, or a while after one of its presses (the
    // press itself shows the screen before it), or seconds into the step.
    let t = step.ended;
    if (want.seconds !== undefined) t = step.began + want.seconds * 1000;
    if (want.press !== undefined) {
      const presses = ids
        .map((id) => sessionAt(capture.sessions, id, step.began))
        .filter(Boolean)
        .flatMap((s) => s.events.filter((e) => e.kind === 'click' && e.at >= step.began && e.at <= step.ended))
        .sort((a, b) => a.at - b.at);
      const press = presses[want.press - 1];
      if (press) t = press.at + want.after * 1000;
      else notes.push(`The script's cover is press ${want.press} of ${step.key}, which has ${presses.length}: the cover shows the step's end.`);
    }
    const ss = screensOf(step, ids, t);
    const screen = (s, kind) => ({
      kind,
      src: url(frameAt(s, t).file),
      vw: s.viewport.width,
      vh: s.viewport.height,
      address: kind === 'browser' ? (config.video.address ?? addressOf(step.urls?.[s.id])) : undefined,
    });
    const desk = ss.find((s) => !s.touch);
    const phone = ss.find((s) => s.touch);
    return [...(desk ? [screen(desk, 'browser')] : []), ...(phone ? [screen(phone, 'phone')] : [])];
  }

  // ── a step ──
  function stepShot(step, testId) {
    const cfg = stepsCfg[step.key] ?? {};
    const row = suite.tests.get(testId)?.rows.get(step.parts.n);
    const who = cfg.who ?? row?.who ?? step.parts.who;
    const text = cfg.subtitle ?? row?.does ?? step.parts.text;
    const sees = cfg.sees !== undefined ? cfg.sees : (row?.sees ?? '');
    const lone = personByWord(who);
    const subtitle = {
      who: lone && roleOf(lone.id) ? `${who} · ${roleOf(lone.id)}` : who,
      text: plain(text),
      sees: sees ? plain(sees) : '',
      seesLabel: config.video.labels.sees,
    };
    const v = voice(step.key);
    // When its narration starts, when the script says (`voiceAt`): then the
    // step is not stretched for the voice ahead of the action; it lasts
    // until the voice is done instead.
    const voiceAt = v && cfg.voiceAt !== undefined && cfg.voiceAt !== null ? cfg.voiceAt : null;
    const placeVoice = (D, presses, fallback) => {
      if (!v) return { D, voice: null };
      if (voiceAt === null) return { D, voice: { file: v.file, at: fallback } };
      let at = voiceStart(step.key, voiceAt, presses);
      if (at === null) {
        notes.push(`${step.key}: "voiceAt": ${JSON.stringify(voiceAt)}, and the step has ${presses.length} press${presses.length === 1 ? '' : 'es'}: its voice starts with the step.`);
        at = fallback;
      }
      return { D: Math.max(D, at + v.duration + 0.7), voice: { file: v.file, at, onPress: typeof voiceAt === 'string' } };
    };

    // The screens: the people the step names, as they were at that moment.
    let ids = (step.people ?? []).filter((id) => sessionAt(capture.sessions, id, step.began));
    if (!ids.length) {
      ids = [...new Set(capture.sessions.filter((s) => s.started <= step.ended && step.began <= s.ended).map((s) => s.id))];
    }
    const shown = ids.map((id) => sessionAt(capture.sessions, id, step.began)).filter(Boolean);
    const boxes = layout(shown.map((s) => s.viewport));
    const panelsAt = (tReal) =>
      shown.map((s, i) => ({
        ...boxes[i],
        src: url(screenAt(s, tReal)?.file ?? null),
        label: boxes[i].bleed ? null : `${castName(s.id)}${roleOf(s.id) ? ` · ${roleOf(s.id)}` : ''}`,
        // Whose screen this is: a step that shows other screens than the
        // one before fades them in (SWAP).
        who: s.id,
      }));
    const toStage = (pi, x, y) => {
      const b = boxes[pi];
      const vp = shown[pi].viewport;
      return { x: b.x + (x * b.w) / vp.width, y: b.y + (y * b.h) / vp.height };
    };
    const startOf = (s) => cursorAt.get(s.id) ?? { x: Math.round(s.viewport.width / 2), y: Math.round(s.viewport.height * 0.62) };
    const chars = `${subtitle.who}: ${subtitle.text} ${subtitle.sees}`.length;
    return mode === 'motion' ? motion() : guide();

    function guide() {
      // The clicks and the typing of the people shown, one ripple per press.
      const events = [];
      shown.forEach((s, pi) => {
        let last = null;
        for (const e of s.events) {
          if ((e.kind !== 'click' && e.kind !== 'type') || e.at < step.began || e.at > step.ended) continue;
          // A double click is one gesture.
          if (last && e.kind === 'click' && last.kind === 'click' && e.at - last.at < 600 && Math.hypot(e.x - last.x, e.y - last.y) < 8) continue;
          // Typing right after clicking the same field: the click was the way in.
          if (last && e.kind === 'type' && last.kind === 'click' && e.at - last.at < 1500 && Math.hypot(e.x - last.x, e.y - last.y) < 80) {
            last.ibeam = true;
            continue;
          }
          last = { pi, at: e.at, x: e.x, y: e.y, ibeam: e.kind === 'type', touch: Boolean(s.touch) };
          events.push(last);
        }
      });
      events.sort((a, b) => a.at - b.at);
      const k = events.length;
      let D = Math.max(readSeconds(chars), v && voiceAt === null ? v.duration + 0.7 : 0);
      const hold = 0.35 * D + 0.6;
      let S = 0;
      if (k) {
        S = Math.max(1.15, (D - hold) / k);
        D = hold + S * k;
      }
      // Each press starts from where that person's cursor was.
      const from = new Map(shown.map((s, pi) => [pi, startOf(s)]));
      for (const e of events) {
        e.from = from.get(e.pi);
        from.set(e.pi, { x: e.x, y: e.y });
      }
      for (const [pi, pos] of from) cursorAt.set(shown[pi].id, pos);
      const acting = new Set(events.map((e) => e.pi));
      const waitOf = (e) => (e.touch ? TOUCH_WAIT : GLIDE);

      // With nothing pressed, the screen before the step first, when there
      // is one worth showing (a page's first paint is blank).
      let before = 0;
      if (!k) {
        const usable = shown.some((s) => {
          const f = frameAt(s, step.began);
          const end = frameAt(s, step.ended);
          return f && f.index > 0 && end && end.ms !== f.ms;
        });
        if (usable) before = Math.min(1.2, 0.3 * D);
      }

      const at = (u) => {
        let tReal;
        if (k && u < k * S) {
          const i = Math.min(k - 1, Math.floor(u / S));
          const w = u - i * S;
          tReal = w < waitOf(events[i]) + SWITCH ? events[i].at - 1 : i + 1 < k ? events[i + 1].at - 1 : step.ended;
        } else {
          tReal = !k && u < before ? step.began : step.ended;
        }
        const cursors = [];
        const ripples = [];
        for (const pi of acting) {
          const s = shown[pi];
          const mine = events.filter((e) => e.pi === pi);
          // The press this person is on, or the last one done.
          let current = null;
          for (const e of mine) if (events.indexOf(e) * S <= u) current = e;
          if (s.touch) {
            if (current) {
              const w = u - events.indexOf(current) * S;
              const opacity = Math.min(1, Math.max(0, (w - (TOUCH_WAIT - 0.2)) / 0.15)) * Math.min(1, Math.max(0, (TOUCH_WAIT + 0.55 - w) / 0.2));
              if (opacity > 0) cursors.push({ ...toStage(pi, current.x, current.y), shape: 'touch', opacity });
            }
          } else if (!current) {
            const p = mine[0].from;
            cursors.push({ ...toStage(pi, p.x, p.y), shape: 'arrow', opacity: 1 });
          } else {
            const w = u - events.indexOf(current) * S;
            const g = smooth(w / GLIDE);
            const x = current.from.x + (current.x - current.from.x) * g;
            const y = current.from.y + (current.y - current.from.y) * g;
            cursors.push({ ...toStage(pi, x, y), shape: w >= GLIDE && current.ibeam ? 'ibeam' : 'arrow', opacity: 1 });
          }
          if (current) {
            const w = u - events.indexOf(current) * S - waitOf(current);
            if (w >= 0 && w < RIPPLE) ripples.push({ ...toStage(pi, current.x, current.y), p: w / RIPPLE });
          }
        }
        // The subtitle's age: a new one rises into place (stage.html).
        const age = Number(Math.min(u, SUBTITLE_IN).toFixed(3));
        return { panels: panelsAt(tReal), cursors, ripples, subtitle: { ...subtitle, age }, card: null, fade: 0 };
      };

      // The voice, and the result held until it is done.
      const ticks = events.map((e, i) => i * S + waitOf(e));
      const placed = placeVoice(D, ticks, 0.15);
      D = placed.D;
      return {
        kind: 'step',
        key: step.key,
        duration: D,
        clicks: k,
        voice: placed.voice,
        ticks,
        keys: [
          ...events.map((e, i) => ({ u: i * S + waitOf(e) - 0.02, caption: `${step.key} · press ${i + 1}` })),
          { u: D - 0.05, caption: `${step.key} · end` },
        ],
        at,
      };
    }

    function motion() {
      const idle = (data.idle ?? 0.8) * 1000;
      const speed = data.speed ?? 1;
      const inStep = (t) => t >= step.began && t <= step.ended;
      // The moments something happened: a paint, a pointer moving, a press.
      const times = [step.began, step.ended];
      for (const s of shown) {
        for (const f of s.frames) if (inStep(f)) times.push(f);
        for (const e of s.events) if (inStep(e.at)) times.push(e.at);
      }
      times.sort((a, b) => a - b);
      // Real time to video time: as it was, except stillness longer than
      // `idle`, which is cut to it; and a page's load until its content,
      // cut to LOAD: its screen shows that content already, or the page
      // before (paintedFrames), and a person coming on screen with a phone
      // that stays put for a second reads as the app stuck (found in
      // CritKeep, on a development server).
      const loads = new Set(shown.flatMap((s) => s.loads ?? []));
      const knots = [{ r: times[0], v: 0 }];
      for (let i = 1; i < times.length; i += 1) {
        const gap = times[i] - times[i - 1];
        if (gap <= 0) continue;
        const most = loads.has(times[i]) ? Math.min(idle, LOAD * 1000) : idle;
        knots.push({ r: times[i], v: knots.at(-1).v + Math.min(gap, most) / 1000 / speed });
      }
      const V = knots.at(-1).v;
      const tail = 0.7;
      let D = Math.max(V + tail, readSeconds(chars), v && voiceAt === null ? v.duration + 0.7 : 0);
      // A narration longer than the action: part of the wait before it, the
      // rest on the result.
      const lead = Math.min(1.5, (D - V - tail) * 0.4);
      const realAt = (u) => {
        const w = u - lead;
        if (w <= 0) return step.began;
        if (w >= V) return step.ended;
        let lo = 0;
        let hi = knots.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (knots[mid].v <= w) lo = mid;
          else hi = mid;
        }
        const a = knots[lo];
        const b = knots[hi];
        return b.v === a.v ? a.r : a.r + ((w - a.v) / (b.v - a.v)) * (b.r - a.r);
      };
      const videoAt = (r) => {
        let lo = 0;
        let hi = knots.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (knots[mid].r <= r) lo = mid;
          else hi = mid;
        }
        const a = knots[lo];
        const b = knots[hi];
        return lead + (b.r === a.r ? a.v : a.v + ((r - a.r) / (b.r - a.r)) * (b.v - a.v));
      };

      const own = shown.map((s) => s.events.filter((e) => inStep(e.at)));
      const presses = own.flatMap((evs, pi) => evs.filter((e) => e.kind === 'click').map((e) => ({ ...e, pi })));
      presses.sort((a, b) => a.at - b.at);
      const starts = shown.map((s) => startOf(s));
      shown.forEach((s, pi) => {
        const lastPos = [...own[pi]].reverse().find((e) => e.kind !== 'type');
        if (lastPos) cursorAt.set(s.id, { x: lastPos.x, y: lastPos.y });
      });

      const at = (u) => {
        const tReal = realAt(u);
        const cursors = [];
        const ripples = [];
        shown.forEach((s, pi) => {
          const evs = own[pi];
          if (!evs.length) return;
          if (s.touch) {
            for (const e of evs) {
              if (e.kind !== 'click') continue;
              const d = (tReal - e.at) / 1000;
              if (d < -0.15 || d > 0.55) continue;
              const opacity = Math.min(1, (d + 0.15) / 0.15) * Math.min(1, (0.55 - d) / 0.2);
              cursors.push({ ...toStage(pi, e.x, e.y), shape: 'touch', opacity });
            }
          } else {
            let i = -1;
            for (let j = 0; j < evs.length; j += 1) if (evs[j].at <= tReal) i = j;
            let p = starts[pi];
            let shape = 'arrow';
            if (i >= 0) {
              const e = evs[i];
              const n = evs[i + 1];
              p = { x: e.x, y: e.y };
              if (n && n.kind === 'move' && n.at - e.at < 150) {
                const f = (tReal - e.at) / (n.at - e.at);
                p = { x: e.x + (n.x - e.x) * f, y: e.y + (n.y - e.y) * f };
              }
              // After typing began, an I-beam until the pointer moves again.
              const lastMove = evs.slice(0, i + 1).findLastIndex((x) => x.kind === 'move');
              const lastType = evs.slice(0, i + 1).findLastIndex((x) => x.kind === 'type');
              if (lastType > lastMove) shape = 'ibeam';
            }
            cursors.push({ ...toStage(pi, p.x, p.y), shape, opacity: 1 });
          }
        });
        for (const e of presses) {
          const d = (tReal - e.at) / 1000;
          if (d >= 0 && d < RIPPLE) ripples.push({ ...toStage(e.pi, e.x, e.y), p: d / RIPPLE });
        }
        // The subtitle's age: a new one rises into place (stage.html).
        const age = Number(Math.min(u, SUBTITLE_IN).toFixed(3));
        return { panels: panelsAt(tReal), cursors, ripples, subtitle: { ...subtitle, age }, card: null, fade: 0 };
      };

      // The voice, and the result held until it is done.
      const placed = placeVoice(
        D,
        presses.map((e) => videoAt(e.at)),
        Math.max(0.1, lead - 0.4),
      );
      D = placed.D;
      return {
        kind: 'step',
        key: step.key,
        duration: D,
        clicks: presses.length,
        voice: placed.voice,
        ticks: presses.map((e) => videoAt(e.at)),
        keys: [
          ...presses.map((e, i) => ({ u: videoAt(e.at) - 0.04, caption: `${step.key} · press ${i + 1}` })),
          { u: D - 0.05, caption: `${step.key} · end` },
        ],
        at,
      };
    }
  }
}
