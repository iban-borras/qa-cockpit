// The app's screens in its other languages (`replay --languages`, and
// `languages check` to try it first). The suite plays in its own language,
// as its recording finds things by their words; at each step's end the
// person's screen is changed to each other language, the way the project's
// agent wrote it in the config (`languages.switchTo`, with the actions a
// person takes on the app's own control), photographed, looked at, and
// changed back. What it finds, against the same screen in the suite's own
// language:
//
//   cut   a text that does not fit its box any more (cut, or spilling out)
//   wide  the page grown wider than the window
//   key   a translation key left on the screen («nav.home»)
//
// Nothing here may break the run: the change gets a short time to happen,
// and the screen must come back word for word, or the look stops for the
// rest of the run and says why.

import { languageName } from './server/public/lang-names.js';

// How long the project's change may take, each way.
export const SWITCH_MS = 4_000;

/** A language as the CLI says it: its name, the config's or Intl's, and its code («Klingon (tlh)»). */
export function langSaid(config, code) {
  const name = languageName(code, { names: config.languages?.names });
  return name === code ? code : `${name} (${code})`;
}

/**
 * In the page: the languages its browser has no name for, in English,
 * which the cockpit shows by their code unless the config names them.
 */
export function nameless(codes) {
  return codes.filter((code) => {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code);
      return !name || name.toLowerCase() === code.toLowerCase();
    } catch {
      return true;
    }
  });
}

/** In the page: its visible words, as a short print to tell two screens apart. */
export function printOf() {
  const text = document.body?.innerText ?? '';
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/**
 * In the page: what does not fit. The texts larger than their box, the
 * keys left untranslated, and whether the page is wider than the window;
 * each with where it is, at the page's pixels.
 */
export function scanTexts() {
  const sx = scrollX;
  const sy = scrollY;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // Where an element is, the same in every language: tags and positions.
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i += 1;
      parts.unshift(`${e.tagName.toLowerCase()}:${i}`);
    }
    return parts.join('/');
  };
  const cut = [];
  const keys = [];
  const KEY = /^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/;
  for (const el of document.body.querySelectorAll('*')) {
    if (cut.length >= 60) break;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own.length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.display === 'inline' || cs.visibility !== 'visible') continue;
    for (const n of own) {
      const t = n.textContent.trim();
      if (KEY.test(t) && keys.length < 30) keys.push({ path: pathOf(el), text: t, box: box(el) });
    }
    // A box its words do not fit: wider or taller inside than out.
    if (el.scrollWidth > el.clientWidth + 1 || (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1)) {
      cut.push({ path: pathOf(el), text: own.map((n) => n.textContent.trim()).join(' ').slice(0, 80), box: box(el) });
    }
  }
  // The page wider than its window: the element that reaches furthest.
  let wide = null;
  const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1) {
    let far = null;
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > W + 1 && (!far || r.right > far.r)) far = { el, r: r.right };
    }
    if (far) wide = { path: pathOf(far.el), text: (far.el.innerText ?? '').trim().slice(0, 80), box: box(far.el) };
  }
  return { cut, keys, wide };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Until the page's words pass `ok` and stand still a moment (`still` ms at
 * least, one look more by default); false when they do not in time.
 */
export async function settle(page, ok, timeout, still = 0) {
  const end = Date.now() + timeout;
  let last = null;
  let since = Date.now();
  while (Date.now() < end) {
    const now = await page.evaluate(printOf).catch(() => null);
    if (now !== last) since = Date.now();
    else if (now !== null && ok(now) && Date.now() - since >= still) return true;
    last = now;
    await sleep(120);
  }
  return false;
}

// How long a screen's words stand still before the look takes them as the
// suite's own: a step may end with its screen still moving (a list filling
// in, a «Saving…» about to say «Saved»), and a print taken then never
// comes back the same.
export const STILL_MS = 400;

/**
 * Playwright's default timeouts made the change's own while `fn` runs (the
 * project's `switchTo` and `ready`), and put back after: a control that is
 * not there fails in seconds, and no click is left waiting to land in the
 * next step. Playwright keeps them on its client side.
 */
async function withShortTimeouts(page, fn) {
  const settings = page._timeoutSettings;
  const before = settings ? [settings._defaultTimeout, settings._defaultNavigationTimeout] : null;
  page.setDefaultTimeout(SWITCH_MS);
  page.setDefaultNavigationTimeout(SWITCH_MS * 2);
  try {
    return await fn();
  } finally {
    if (settings) [settings._defaultTimeout, settings._defaultNavigationTimeout] = before;
  }
}

/** The project's own change of language, with a short time for each of its actions. */
export async function switchTo(config, page, lang, person) {
  await withShortTimeouts(page, () => config.languages.switchTo({ page, lang, person, config, timeout: SWITCH_MS }));
}

/**
 * The project's own word on whether this screen can be changed now
 * (`languages.ready`), asked before anything is touched: it may wait for
 * the screen to stand still, or say why not (a dialog open, a field being
 * typed in, «Saving…»), and then the screen is left as it was.
 * @returns {Promise<string | null>} why not, or null to go on
 */
export async function notReady(config, page, person) {
  const ready = config.languages.ready;
  if (!ready) return null;
  try {
    const said = await withShortTimeouts(page, () => ready({ page, person, config, timeout: SWITCH_MS }));
    if (said === undefined || said === null || said === true) return null;
    return `the project's ready said not now${said === false ? '' : `: ${String(said).split('\n')[0].slice(0, 160)}`}`;
  } catch (e) {
    return `the project's ready said not now: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`;
  }
}

/** What a language's screen has that the suite's own did not, as findings; each told once a run. */
export function compare(base, scan, lang, told, where) {
  const fits = new Set(base.cut.map((c) => c.path));
  const found = [];
  const tell = (rule, x) => {
    const key = `${lang}|${rule}|${x.path}|${x.text}|${where}`;
    if (told.has(key)) return;
    told.add(key);
    found.push({ kind: 'lang', rule, lang, text: x.text, box: x.box });
  };
  for (const c of scan.cut) if (!fits.has(c.path)) tell('cut', c);
  if (scan.wide && !base.wide) tell('wide', scan.wide);
  for (const k of scan.keys) tell('key', k);
  return found;
}

/**
 * A person's screen in each other language, and back. `shoot(lang)` takes
 * the photo of the screen in that language: { file, scroll }.
 * @returns {Promise<{ shots: any[], skipped: string | null, broken: string | null }>}
 */
export async function lookInLanguages({ config, page, person, langs, shoot, told }) {
  const base = config.languages.base;
  // The project's no, before anything is touched: this step is skipped,
  // and the look goes on at the next one.
  const why = await notReady(config, page, person);
  if (why) return { shots: [], skipped: why, broken: null, baseKeys: [] };
  // A screen still moving at the step's end is given a moment; one that
  // never stands still (a clock) is taken as it is.
  await settle(page, () => true, 2_000, STILL_MS);
  const before = await page.evaluate(printOf);
  const baseScan = await page.evaluate(scanTexts);
  let where = '';
  try {
    where = new URL(page.url()).pathname;
  } catch {
    // A page without an address.
  }
  // The suite's own language has its keys too.
  const shots = [];
  let skipped = null;
  let touched = false;
  for (const lang of langs) {
    const at = await page.evaluate(printOf);
    try {
      touched = true;
      await switchTo(config, page, lang, person);
    } catch (e) {
      skipped = `${lang}: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`;
      break;
    }
    // Its words changed, then stood still; or nothing moved (a screen
    // without words of the app's, or the same words).
    const changed = await settle(page, (p) => p !== at, 3_000);
    if (!changed) await settle(page, () => true, 600);
    const shot = await shoot(lang);
    const scan = await page.evaluate(scanTexts);
    shots.push({ lang, ...shot, changed, findings: compare(baseScan, scan, lang, told, where) });
  }
  // Back to the suite's own language, and to the very same screen.
  let broken = null;
  if (touched && (await page.evaluate(printOf).catch(() => null)) !== before) {
    try {
      await switchTo(config, page, base, person);
    } catch (e) {
      broken = `back to ${base}: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`;
    }
    let same = await settle(page, (p) => p === before, 4_000);
    if (!same) {
      // A menu of the change left open, most likely.
      await page.keyboard.press('Escape').catch(() => {});
      same = await settle(page, (p) => p === before, 1_500);
    }
    if (!same) broken ??= `the screen did not come back the same in ${base}`;
  }
  return { shots, skipped, broken, baseKeys: compare({ cut: [], keys: [], wide: null }, { cut: [], keys: baseScan.keys, wide: null }, base, told, where) };
}
