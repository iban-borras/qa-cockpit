// The suites: one Markdown document per piece of the app, written for a
// person (or an agent) to follow, and the recording that plays it back. The
// document is the source of truth; the recording carries, in its first
// line, the hash of the document it was recorded from, so a changed suite is
// never replayed from a stale recording.
//
// What the code reads in a document (the rest is for people):
//   # Title
//   the first paragraph             what the suite is about (or the index's line)
//   ## <castHeading>                the people, in **bold** (their cast ids)
//   ### T1 · <title>                one heading per test (config.suiteFormat.testHeading)
//   ## <runsHeading>                the table of runs, left out of the hash
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recordingOf, setupOf } from './config.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function docOf(config, suite) {
  return path.join(config.paths.suites, `${suite}.md`);
}

/**
 * The hash a recording carries in its first line: sha256 of the suite's
 * document WITHOUT its runs table, which is a log of runs and not part of
 * what the recording proves. A row written after a run must not make the
 * recording look stale.
 */
export function suiteHash(config, suite) {
  const text = fs.readFileSync(docOf(config, suite), 'utf8');
  const cut = text.search(new RegExp(`^## ${escapeRe(config.suiteFormat.runsHeading)}\\s*$`, 'm'));
  const body = cut === -1 ? text : text.slice(0, cut);
  return createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex');
}

/** The first line a recording of a suite must carry. */
export function suiteHeader(config, suite) {
  return `// suite: ${suite}.md sha256:${suiteHash(config, suite)}`;
}

/**
 * What to do with a suite: `ENV <why>` when the stack is not usable,
 * `GENERATE <why>` when there is no recording or the suite has changed since
 * it was recorded, `REPLAY` otherwise.
 * @returns {{ verdict: 'REPLAY'|'GENERATE'|'ENV', why: string }}
 */
export function decide(config, suite) {
  try {
    config.stack.urls();
    config.stack.guard?.();
  } catch (e) {
    return { verdict: 'ENV', why: e instanceof Error ? e.message : String(e) };
  }
  if (!fs.existsSync(docOf(config, suite))) {
    return { verdict: 'ENV', why: `No suite named "${suite}" in ${config.paths.suites}` };
  }
  const spec = recordingOf(config, suite);
  if (!spec) return { verdict: 'GENERATE', why: 'no recording yet' };
  const first = fs.readFileSync(spec, 'utf8').split(/\r?\n/, 1)[0];
  const m = /sha256:([0-9a-f]{64})/.exec(first);
  if (!m) return { verdict: 'GENERATE', why: 'the recording has no suite hash in its first line' };
  if (m[1] !== suiteHash(config, suite)) return { verdict: 'GENERATE', why: 'the suite changed since it was recorded' };
  return { verdict: 'REPLAY', why: 'the recording matches the suite' };
}

/**
 * Append a row to the suite's runs table: every run leaves a trace.
 * @param {{ who: string, result: string, notes: string, date?: string }} row
 */
export function recordPass(config, suite, { who, result, notes, date }) {
  const heading = config.suiteFormat.runsHeading;
  const file = docOf(config, suite);
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex((l) => new RegExp(`^## ${escapeRe(heading)}\\s*$`).test(l));
  if (head === -1) throw new Error(`${suite}.md has no «## ${heading}» section.`);
  // The table: header, separator, then rows until a blank line or the end.
  let first = head + 1;
  while (first < lines.length && !/^\|/.test(lines[first])) first += 1;
  if (first >= lines.length) throw new Error(`${suite}.md: no table under «${heading}».`);
  let end = first;
  while (end < lines.length && /^\|/.test(lines[end])) end += 1;
  const clean = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const row = `| ${date ?? new Date().toISOString().slice(0, 10)} | ${clean(who)} | ${clean(result)} | ${clean(notes)} |`;
  // An empty placeholder row (every cell blank) gives way to the first real one.
  const placeholder = end - 1 > first + 1 && /^\|(\s*\|)+\s*$/.test(lines[end - 1]);
  if (placeholder) lines.splice(end - 1, 1, row);
  else lines.splice(end, 0, row);
  fs.writeFileSync(file, lines.join(eol));
  return row;
}

/** The suites' index (a README beside them): one table row per suite, its summary and test count. */
function readIndex(config) {
  const out = new Map();
  if (!config.suiteFormat.index) return out;
  const file = path.join(config.paths.suites, config.suiteFormat.index);
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*\[([\w-]+)\]\([\w-]+\.md\)\s*\|\s*(.*?)\s*\|\s*(\d+)\s*\|/.exec(line);
    if (m) out.set(m[1], { summary: m[2], tests: Number(m[3]) });
  }
  return out;
}

/**
 * What the cockpit's picker says about a suite, read from its own document:
 * the title, what it tests, who plays in it, how many tests, the last run
 * on record, and whether it can run: recorded, its recording's hash the
 * suite's, and a setup.
 */
function suiteInfo(config, name, index) {
  const { castHeading, runsHeading, testHeading } = config.suiteFormat;
  const text = fs.readFileSync(docOf(config, name), 'utf8').replace(/\r\n/g, '\n');
  const title = /^# (.+)$/m.exec(text)?.[1].trim() ?? name;
  const firstParagraph = text.split(/\n{2,}/).find((b, i) => i > 0 && !b.startsWith('#')) ?? '';
  const castBlock = new RegExp(`^## ${escapeRe(castHeading)}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '';
  const cast = config.cast
    .filter((p) => [p.id, p.name].some((n) => new RegExp(`\\*\\*${escapeRe(n)}\\*\\*`, 'i').test(castBlock)))
    .map((p) => p.id);
  const counted = (text.match(new RegExp(testHeading.source, testHeading.flags.includes('g') ? testHeading.flags : `${testHeading.flags}g`)) ?? []).length;
  const runs = new RegExp(`^## ${escapeRe(runsHeading)}\\s*\\n([\\s\\S]*)$`, 'm').exec(text)?.[1] ?? '';
  const rows = runs.split('\n').filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l));
  const last = rows.at(-1)?.split('|').map((c) => c.trim());
  const recording = recordingOf(config, name);
  const setup = Boolean(setupOf(config, name));
  let status = 'unrecorded';
  if (recording) {
    const head = fs.readFileSync(recording, 'utf8').split(/\r?\n/, 1)[0];
    const stamped = /sha256:([0-9a-f]{64})/.exec(head)?.[1];
    status = stamped !== suiteHash(config, name) ? 'stale' : setup ? 'ready' : 'nosetup';
  }
  return {
    name,
    title,
    summary: index.get(name)?.summary ?? firstParagraph.replace(/\s+/g, ' ').replace(/[*`]/g, '').slice(0, 400),
    tests: counted || index.get(name)?.tests || 0,
    cast,
    recorded: Boolean(recording),
    setup,
    status,
    lastPass: last ? { date: last[1], who: last[2], result: last[3] } : null,
  };
}

/** Every suite document in the suites folder (its index file aside). */
export function listSuites(config) {
  const dir = config.paths.suites;
  if (!fs.existsSync(dir)) return [];
  const index = readIndex(config);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== config.suiteFormat.index)
    .map((f) => suiteInfo(config, f.replace(/\.md$/, ''), index));
}
