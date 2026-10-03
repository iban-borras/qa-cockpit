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
//     "tests": ["T1", "T3"],           // which, in the suite's order; all by default
//     "cover": "T1/2",                 // the step whose end the cover shows, rising in a
//                                      // flat browser (or { "step", "people" }, or false);
//                                      // the one that shows most of the app by default
//     "cards": {
//       "intro": { "narration": "...", "audio": "chat/intro.mp3" },
//       "T1": { "title": "A message, live", "narration": "...", "audio": "chat/t1.mp3" },
//       "outro": { "title": "...", "subtitle": "...", "narration": "...", "audio": "..." }
//     },
//     "steps": {
//       "T1/2": { "subtitle": "...", "sees": "...", "narration": "...", "audio": "chat/t1-2.mp3" },
//       "T3/4": { "skip": true }
//     },
//     "music": "generated",            // a file (relative to this script), or null for none
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
    music: 'generated',
  };
}
