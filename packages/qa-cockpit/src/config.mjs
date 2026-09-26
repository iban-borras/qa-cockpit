// A project meets QA Cockpit through one file, `qa-cockpit.config.mjs`, next
// to its tests. It says where the suites live, who the cast is, how the app
// under test starts, resets and signs a person in. Everything else in the
// package reads the RESOLVED config this file makes: every path absolute,
// every default filled, the cast as a list.
//
// The config is JavaScript, not JSON, because its hooks are code. Paths in it
// are relative to the config file itself, which it names with
// `base: import.meta.url`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONFIG_FILE = 'qa-cockpit.config.mjs';

/** Identity: gives an editor the config's shape through the JSDoc below. */
export function defineConfig(config) {
  return config;
}

/**
 * @typedef {{ id: string, name: string, email: string | null, badge: string | null, [key: string]: unknown }} Person
 */

// A person's id is a word: it names a fixture, a saved session file and the
// person in a step title («3 · Alice: sends a message»).
const PERSON_ID = /^[a-z][a-z0-9_]*$/;

const resolved = new WeakMap();

/**
 * The config with every path absolute and every default filled. The same raw
 * object always gives the same resolved one.
 * @param {any} raw what qa-cockpit.config.mjs exports
 * @param {string} [file] the config file, when `raw.base` does not say it
 */
export function resolveConfig(raw, file) {
  if (!raw || typeof raw !== 'object') throw new Error('The QA Cockpit config must export an object.');
  if (raw.raw && raw.paths?.project) return raw; // resolved already
  if (resolved.has(raw)) return resolved.get(raw);
  const baseDir = dirOf(raw.base) ?? (file ? path.dirname(file) : null);
  if (!baseDir) {
    throw new Error('The QA Cockpit config has no `base`: add `base: import.meta.url` to it.');
  }
  const at = (p, fallback) => (p === null ? null : path.resolve(baseDir, p ?? fallback));
  const p = raw.paths ?? {};
  const paths = {
    // Where the config, package.json and node_modules are; Playwright runs here.
    project: baseDir,
    // The repository's root: paths shown to people and agents are relative to it.
    root: at(raw.root, '.'),
    suites: at(p.suites, 'suites'),
    recordings: at(p.recordings, 'recordings'),
    setups: at(p.setups, 'setups'),
    sessionsSetup: p.sessionsSetup ? at(p.sessionsSetup) : null,
    smoke: p.smoke ? at(p.smoke) : null,
    out: at(p.out, '.qa-cockpit/out'),
    state: at(p.state, '.qa-cockpit/state'),
    skill: p.skill ? at(p.skill) : null,
    playwrightConfig: p.playwrightConfig ? at(p.playwrightConfig) : null,
  };

  const cast = Object.entries(raw.cast ?? {}).map(([id, person]) => {
    if (!PERSON_ID.test(id)) throw new Error(`Cast: «${id}» is not a usable id (lowercase letters, digits, _).`);
    return {
      ...person,
      id,
      name: person?.name ?? id.charAt(0).toUpperCase() + id.slice(1),
      email: person?.email ?? null,
      badge: person?.badge ?? null,
    };
  });

  const stack = raw.stack ?? {};
  if (typeof stack.urls !== 'function') {
    throw new Error('The QA Cockpit config needs `stack.urls()`: where the app (and its API, if any) answer.');
  }

  const suites = raw.suites ?? {};
  const config = Object.freeze({
    raw,
    file: file ?? path.join(baseDir, CONFIG_FILE),
    name: raw.name ?? path.basename(paths.root),
    paths,
    cast,
    people: cast.map((c) => c.id),
    stack: {
      name: stack.name ?? raw.name ?? 'app',
      ...stack,
    },
    signIn: raw.signIn ?? null,
    sessions: {
      freshFor: raw.sessions?.freshFor ?? 5 * 60_000,
      who: raw.sessions?.who ?? null,
    },
    helpers: raw.helpers ?? {},
    browser: {
      locale: raw.browser?.locale ?? 'en-GB',
      timezoneId: raw.browser?.timezoneId ?? undefined,
      reducedMotion: raw.browser?.reducedMotion ?? 'reduce',
      landing: raw.browser?.landing ?? '/',
    },
    suiteFormat: {
      castHeading: suites.castHeading ?? 'Cast',
      runsHeading: suites.runsHeading ?? 'Runs',
      testHeading: suites.testHeading ?? /^#{3,4} [A-Z]{1,2}\d+[a-z]? · /gm,
      index: suites.index === null ? null : (suites.index ?? 'README.md'),
      extensions: suites.recordingExtensions ?? ['.spec.ts', '.spec.mjs', '.spec.js'],
      setupExtensions: suites.setupExtensions ?? ['.setup.ts', '.setup.mjs', '.setup.js'],
    },
    cockpit: {
      port: Number(process.env.QA_COCKPIT_PORT) || raw.cockpit?.port || 3150,
      language: raw.cockpit?.language ?? null,
      keepRuns: raw.cockpit?.keepRuns ?? 6,
    },
    // How a person runs the CLI in this project, for the messages that tell them.
    cli: raw.cli?.command ?? 'npx qa-cockpit',
    commands: raw.commands ?? {},
    report: { notes: raw.report?.notes ?? [] },
    playwright: raw.playwright ?? {},
  });
  resolved.set(raw, config);
  return config;
}

function dirOf(base) {
  if (!base) return null;
  const s = String(base);
  if (s.startsWith('file:')) {
    const p = fileURLToPath(s);
    return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
  }
  return path.resolve(s);
}

/**
 * Find and load a project's config: the file given, or qa-cockpit.config.mjs
 * in `from` or its nearest parent that has one.
 * @param {string} [fileOrDir]
 */
export async function loadConfig(fileOrDir = process.cwd()) {
  let file = path.resolve(fileOrDir);
  if (!file.endsWith('.mjs') && !file.endsWith('.js')) {
    let dir = file;
    for (;;) {
      const candidate = path.join(dir, CONFIG_FILE);
      if (fs.existsSync(candidate)) {
        file = candidate;
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) throw new Error(`No ${CONFIG_FILE} here or above ${fileOrDir}. Run: npx qa-cockpit init`);
      dir = up;
    }
  }
  const mod = await import(pathToFileURL(file).href);
  return resolveConfig(mod.default, file);
}

/** A path as people and agents read it: relative to the repo, forward slashes. */
export function shown(config, abs) {
  return path.relative(config.paths.root, abs).split(path.sep).join('/') || '.';
}

/** The recording of a suite, when it exists (any of the known extensions). */
export function recordingOf(config, suite) {
  for (const ext of config.suiteFormat.extensions) {
    const f = path.join(config.paths.recordings, `${suite}${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** The setup of a suite, when it exists. */
export function setupOf(config, suite) {
  for (const ext of config.suiteFormat.setupExtensions) {
    const f = path.join(config.paths.setups, `${suite}${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Where a new recording of a suite goes (the first extension). */
export function newRecordingPath(config, suite) {
  return path.join(config.paths.recordings, `${suite}${config.suiteFormat.extensions[0]}`);
}
