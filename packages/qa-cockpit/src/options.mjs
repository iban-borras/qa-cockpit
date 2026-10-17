// The run options, the cockpit's own (`qa-cockpit options`, the page's
// options menu, `/api/options`): visible windows, a container, and the
// looks a run takes (accessibility, the other languages, real time, the
// changes since the last green run, a search for races). One set for the
// cockpit, kept beside its runs (<out>/cockpit/options.json), as they were
// left: the same in every page, and an agent changes them as a person does.
// Each change is kept with who made it, so a page shows what somebody else
// changed until a person has seen it.
//
// They are what the page's run button plays with. A run asked for with
// options of its own (`replay --languages`, `/api/action`) takes those, and
// changes nothing here.
import fs from 'node:fs';
import path from 'node:path';

/** The rounds a search for races can play (the page's select). */
export const CHAOS_ROUNDS = [3, 5, 10, 20];

/** Every option, off: a cockpit nobody has set yet. */
export const DEFAULTS = {
  headed: false,
  docker: false,
  a11y: false,
  languages: false,
  languageList: null, // the languages looked at; null, the config's priority ones
  realtime: false,
  changes: false,
  chaos: false,
  chaosRounds: 3,
};

/** The changes kept, newest last, for a page to tell which it has not seen. */
const KEPT = 20;

export const optionsFile = (config) => path.join(config.paths.out, 'cockpit', 'options.json');

/**
 * The options as they are: { options, rev, log: [{ rev, by, client, at, keys }] }.
 * `options` is null until somebody sets one (a page then gives its own).
 */
export function readOptions(config) {
  try {
    const x = JSON.parse(fs.readFileSync(optionsFile(config), 'utf8'));
    return { options: { ...DEFAULTS, ...pick(x.options ?? {}, config) }, rev: Number(x.rev) || 0, log: Array.isArray(x.log) ? x.log : [] };
  } catch {
    return { options: null, rev: 0, log: [] };
  }
}

/**
 * What a change may say, checked: unknown keys left out, each value of its
 * kind; a language list only of the app's other languages.
 */
export function pick(patch, config) {
  const out = {};
  for (const key of ['headed', 'docker', 'a11y', 'languages', 'realtime', 'changes', 'chaos']) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key];
  }
  if (CHAOS_ROUNDS.includes(Number(patch.chaosRounds))) out.chaosRounds = Number(patch.chaosRounds);
  if (patch.languageList === null) out.languageList = null;
  else if (Array.isArray(patch.languageList)) {
    const others = config.languages?.others ?? [];
    out.languageList = [...new Set(patch.languageList.map(String))].filter((code) => others.includes(code));
  }
  return out;
}

/**
 * Change some options, by whom (an agent's name, or «page» for a person in
 * a page, with that page's own `client`). Returns the new state, and what
 * changed (nothing, when nothing did). `seed`: a page's own options, taken
 * only while the cockpit has none (the options it kept before 0.11).
 */
export function changeOptions(config, patch, { by, client = null, seed = false }) {
  const now = readOptions(config);
  if (seed && now.options) return { ...now, keys: [] };
  const before = now.options ?? { ...DEFAULTS };
  const asked = pick(patch ?? {}, config);
  const after = { ...before, ...asked };
  const keys = Object.keys(asked).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (now.options && !keys.length) return { ...now, keys };
  const rev = now.rev + 1;
  const log = seed ? now.log : [...now.log, { rev, by: String(by ?? 'someone').slice(0, 60), client, at: new Date().toISOString(), keys }].slice(-KEPT);
  const next = { options: after, rev, log };
  fs.mkdirSync(path.dirname(optionsFile(config)), { recursive: true });
  const tmp = `${optionsFile(config)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, optionsFile(config));
  return { ...next, keys };
}

/** The options as a line («accessibility, languages ca es, races ×3»), for the terminal. */
export function optionsLine(o) {
  const on = [
    o.headed && 'visible windows',
    o.docker && 'in a container',
    o.a11y && 'accessibility',
    o.languages && `languages${o.languageList ? ` ${o.languageList.join(' ') || '(none)'}` : ' (the priority ones)'}`,
    o.realtime && 'real time',
    o.changes && 'changes',
    o.chaos && `races ×${o.chaosRounds}`,
  ].filter(Boolean);
  return on.length ? on.join(', ') : 'none';
}
