// What a video says. By default, the suite's own words: a step's subtitle is
// its row («Who», «Does», «Must see»), so the suite is the test and the
// script at once. A video script (paths.videos/<name>.json) says the rest:
// which tests, the cards' titles, a subtitle reworded, a step left out, and
// the narration, as text and as the audio made from it.
//
//   {
//     "suite": "chat",
//     "quality": "guide",              // or "motion"
//     "language": "en-GB",             // the narration's; the config's browser.locale by default
//     "title": "The chat",             // the opening card; the suite's title by default
//     "subtitle": "Two people, one room, live",
//     "tests": ["T1", "T3"],           // which it shows, in the suite's order; all by default
//     "run": "through",                // which run: every test through the last one shown
//                                      // (default: they build its data), "picked" (only the
//                                      // ones shown), or a list of its own
//     "cover": "T1/2 press 2",         // the moment the cover shows, rising in a flat
//                                      // browser: a step's end ("T1/2"), half a second
//                                      // after one of its presses ("T1/2 press 2", and
//                                      // "+0.8" for longer), seconds into it ("T1/2 2.4");
//                                      // or { "step", "at", "people" }, or false. By
//                                      // default, the end of the step that shows most of
//                                      // the app
//     "cards": {
//       "intro": { "narration": "...", "audio": "chat/intro.mp3" },
//       "T1": { "title": "A message, live", "narration": "...", "audio": "chat/t1.mp3" },
//       "outro": { "title": "...", "subtitle": "...", "narration": "...", "audio": "..." }
//     },
//     "steps": {
//       "T1/2": { "subtitle": "...", "sees": "...", "narration": "...", "audio": "chat/t1-2.mp3" },
//       "T1/3": { "narration": "...", "audio": "chat/t1-3.mp3", "voiceAt": "press" },
//                                      // when the voice starts: seconds into the step, or
//                                      // "press" (its first), "press 2"...; with the step
//                                      // by default
//       "T3/4": { "skip": true }
//     },
//     "music": "generated",            // a file (relative to this script), "generated", or
//                                      // null for none; left out, the config's video.music
//     "musicVolume": 1,                // 0..1, over the default level
//     "pace": { "min": 2.8, "max": 6.5, "charsPerSecond": 18 },
//     "idle": 0.8,                     // motion: a still moment longer than this is cut to it
//     "speed": 1                       // motion: 1 is real time
//   }
//
// Paths in it are relative to the script. The narration's text is what the
// voice says; the package plays the audio, it never calls a voice service.
import fs from 'node:fs';
import path from 'node:path';

/** «T1 · A message reaches…» → T1 */
export function testIdOf(title) {
  return /^([A-Z]{1,2}\d+[a-z]?)\s+·/.exec(String(title))?.[1] ?? null;
}

/** «T1 · A message reaches…» → «A message reaches…» */
export function testTitleOf(title) {
  return String(title).replace(/^[A-Z]{1,2}\d+[a-z]?\s+·\s+/, '');
}

/** «2 · Alice: writes «Hello»» → { n: '2', who: 'Alice', text: 'writes «Hello»' } */
export function stepParts(title) {
  const m = /^(\d+[a-z]?)\s+·\s+(.*)$/.exec(String(title));
  if (!m) return null;
  const colon = m[2].indexOf(':');
  return {
    n: m[1],
    who: colon === -1 ? '' : m[2].slice(0, colon).trim(),
    text: (colon === -1 ? m[2] : m[2].slice(colon + 1)).trim(),
  };
}

/** Markdown as a subtitle shows it: no backticks, no bold, links as their text. */
export function plain(md) {
  return String(md ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The suite's title and tests, each with its rows by number: what a step's
 * subtitle says. The columns go by position (#, who, does, must see), so a
 * suite written in any language reads the same.
 * @returns {{ title: string, tests: Map<string, { id: string, title: string, rows: Map<string, { who: string, does: string, sees: string }> }> }}
 */
export function readSuite(config, suite) {
  const file = path.join(config.paths.suites, `${suite}.md`);
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const title = plain(/^# (.+)$/m.exec(text)?.[1] ?? suite);
  const tests = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^#{2,4} ([A-Z]{1,2}\d+[a-z]?) · (.+)$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: plain(heading[2]), rows: new Map() };
      tests.set(heading[1], current);
      continue;
    }
    // Another section («## Runs») ends the tests.
    if (/^#{1,2} /.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const row = /^\|\s*(\d+[a-z]?)\s*\|(.*)\|\s*$/.exec(line);
    if (!row) continue;
    const cells = row[2].split(/(?<!\\)\|/).map((c) => plain(c.replace(/\\\|/g, '|')));
    current.rows.set(row[1], { who: cells[0] ?? '', does: cells[1] ?? '', sees: cells[2] ?? '' });
  }
  return { title, tests };
}

const fold = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The tests and steps a recording names, in its order, read from its text:
 * `test('T1 · …'`, then each `test.step('1 · Who: …'` under it.
 * @param {string} file
 * @returns {{ test: string, title: string }[]}
 */
export function recordingSteps(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  let test = null;
  for (const m of text.matchAll(/\btest(\.(?:only|skip|fixme|step))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g)) {
    const title = m[3].replace(/\\(.)/g, '$1');
    if (m[1] === '.step') {
      if (test) out.push({ test, title });
    } else if (testIdOf(title)) {
      test = title;
    }
  }
  return out;
}

/**
 * Where a recording's steps and its suite's rows part ways. A step's
 * subtitle is the row with its number, so a recording numbered apart from
 * the rows (rows merged into one step, or left out) shows another step's
 * words under each step: Bernat accepting a call, under «Marta sends the
 * invitations» (found in CritKeep, 7 steps over 11 rows). A step whose
 * script gives it its own `subtitle` is left alone.
 * @param {ReturnType<typeof readSuite>} suite
 * @param {{ test: string, title: string }[]} steps the recording's, as written or as they ran
 * @param {{ cast?: { id: string, name: string }[], scriptSteps?: Record<string, any> }} [options]
 * @returns {string[]} one sentence per thing that does not match
 */
export function stepsApart(suite, steps, { cast = [], scriptSteps = {} } = {}) {
  const named = (text) => cast.filter((p) => [p.name, p.id].some((w) => w && new RegExp(`\\b${escapeRe(fold(w))}\\b`).test(fold(text)))).map((p) => p.id);
  const out = [];
  const seen = new Map();
  for (const step of steps) {
    const id = testIdOf(step.test);
    const parts = stepParts(step.title);
    const test = id ? suite.tests.get(id) : null;
    if (!test || !parts) continue;
    if (!seen.has(id)) seen.set(id, new Set());
    seen.get(id).add(parts.n);
    if (scriptSteps[`${id}/${parts.n}`]?.subtitle !== undefined) continue;
    const row = test.rows.get(parts.n);
    if (!row) {
      out.push(`${id}/${parts.n} «${step.title}»: ${id} has no row ${parts.n}, so its subtitle is its own title.`);
      continue;
    }
    // A step may name more people than its row (those it photographs too):
    // only a step and a row with nobody in common are apart.
    const mine = named(parts.who);
    const theirs = named(row.who);
    if (mine.length && theirs.length && !theirs.some((id) => mine.includes(id))) {
      out.push(`${id}/${parts.n} «${step.title}» gets row ${parts.n}'s words: «${row.who}: ${row.does}».`);
    }
  }
  for (const [id, ns] of seen) {
    const rows = suite.tests.get(id).rows.size;
    if (ns.size !== rows) out.unshift(`${id}: ${ns.size} steps in the recording, ${rows} rows in the suite.`);
  }
  return out;
}

/**
 * Which tests a video's run plays, in the suite's order, when it shows only
 * some (`shown`): by default every test through the last one shown, since a
 * suite goes in order on one database and the earlier tests build the data
 * the later ones start from (a test shown alone waits for data nobody made).
 * "picked" plays only the ones shown, for tests that stand on their own; a
 * list plays its own tests, and the shown ones with them.
 * @param {string[]} order the suite's test ids, in its order
 * @param {string[] | null} shown the tests the video shows; null for all
 * @param {'through' | 'picked' | string[]} [run]
 * @returns {string[] | null} the tests to play; null for the whole suite
 */
export function testsToRun(order, shown, run = 'through') {
  if (!shown) return null;
  const unknown = (ids) => ids.filter((id) => !order.includes(id));
  const absent = unknown(shown);
  if (absent.length) throw new Error(`The video script shows ${absent.join(', ')}, which the suite does not have (it has ${order.join(', ')}).`);
  if (Array.isArray(run)) {
    const strange = unknown(run);
    if (strange.length) throw new Error(`The video script runs ${strange.join(', ')}, which the suite does not have (it has ${order.join(', ')}).`);
    const played = new Set([...run, ...shown]);
    return order.filter((id) => played.has(id));
  }
  if (run === 'picked') return order.filter((id) => shown.includes(id));
  if (run !== 'through') throw new Error(`The video script's "run" is "through", "picked" or a list of tests, not ${JSON.stringify(run)}.`);
  return order.slice(0, Math.max(...shown.map((id) => order.indexOf(id))) + 1);
}

/**
 * A video script, or an empty one.
 * @param {string | null | undefined} file
 */
export function readScript(file) {
  if (!file) return { file: null, dir: null, data: {} };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`The video script ${file} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`The video script ${file} must be a JSON object.`);
  return { file, dir: path.dirname(file), data };
}

/** A path the script names, absolute (relative to the script itself). */
export function scriptPath(script, p) {
  if (!p) return null;
  return path.resolve(script.dir ?? process.cwd(), p);
}

/** A first script for a suite: every test, every step with the suite's words and no narration yet. */
export function starterScript(config, suite) {
  const { title, tests } = readSuite(config, suite);
  const cards = { intro: { narration: '' } };
  const steps = {};
  for (const t of tests.values()) {
    cards[t.id] = { title: t.title, narration: '' };
    for (const [n, row] of t.rows) {
      steps[`${t.id}/${n}`] = { subtitle: row.does, sees: row.sees, narration: '' };
    }
  }
  cards.outro = { title: config.video.product, subtitle: '', narration: '' };
  return {
    suite,
    quality: 'guide',
    language: config.browser.locale,
    title,
    subtitle: '',
    tests: [...tests.keys()],
    cards,
    steps,
    // No `music`: left out, the config's `video.music` plays. A script that
    // said "generated" here hid a project's own track.
  };
}
