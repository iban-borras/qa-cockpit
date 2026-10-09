// The cockpit: a page on http://127.0.0.1:3150 that starts the CLI's
// commands, follows a run step by step, keeps a photo of every person at
// every step, shows one of them live on demand, and opens each test's trace.
//
//   <cli> cockpit [--port 3150] [--no-open]
//
// LAUNCH IT FROM A TERMINAL ON YOUR OWN DESKTOP and keep it open. Some agents
// run their terminal on a desktop nobody sees; what the cockpit launches
// with a window («Play as …», headed runs) appears on the desktop of
// whoever started it, and checkDesktop() warns when that one is hidden.
//
// It listens on the loopback only, answers only requests addressed to
// itself (Host) and coming from its own page (Origin), and serves files from
// <out>/cockpit/, the project's trace viewer and its own page, nothing else.
//
// A run of the cockpit lives in <out>/cockpit/<id>/: run.json, frames.jsonl
// (one photo per line), frames/, traces/ and log.txt, and the notes left on
// its photos (notes.mjs). The last `keepRuns` stay, and any run with notes;
// older ones are removed when a new one starts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shown } from '../config.mjs';
import { acquireLock, isAlive, lockFileOf, readLock, StackBusy } from '../lock.mjs';
import { listSuites } from '../suites.mjs';
import { deviceFor, deviceLabel } from '../devices.mjs';
import { cleanNote, notesMarkdown, pinnedFileOf, pinnedSeqs, readNotes, readRunFiles, writeNotes } from '../notes.mjs';
import { noteData, readData } from '../stackdata.mjs';
import { desktopOf } from '../desktop.mjs';
import { playRun } from '../play.mjs';
import { candidatesOf, readChanges } from '../changes.mjs';
import { playwrightCoreDir } from '../deps.mjs';

const PACKAGE_JSON = new URL('../../package.json', import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const BIN = path.join(HERE, '..', '..', 'bin', 'qa-cockpit.mjs');
const OPEN_BROWSER = path.join(HERE, '..', 'open-browser.mjs');
const HOST = '127.0.0.1';
const LOG_LINES = 3000;

// The project, set by startCockpit().
let CFG = null;
let COCKPIT_DIR = null;
let LOCK_FILE = null;
let KEEP_RUNS = 6;
let TRACE_VIEWER_DIR = null;

/** The trace viewer Playwright bundles, from the project's own install. */
function traceViewerDir(config) {
  let core = path.join(config.paths.project, 'node_modules', 'playwright-core');
  try {
    core = playwrightCoreDir(config);
  } catch {
    // The usual place, then.
  }
  return path.join(core, 'lib', 'vite', 'traceViewer');
}

// A person's id, as the URLs and the cast use it.
const ACTOR = /^[a-z][a-z0-9_]*$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

let PORT = 3150;
const clients = new Set();
const logRing = [];
/** @type {null | { label: string, startedAt: string, child: import('node:child_process').ChildProcess | null, stopped: boolean }} */
let task = null;
/** @type {null | ReturnType<typeof newRun>} */
let run = null;
const liveClients = new Map(); // actor -> Set<ServerResponse>
const lastLive = new Map(); // actor -> Buffer
let stack = { up: false, front: null, back: null, checkedAt: null };
let desktopWarning = null;
let outdated = null;

// ---------------------------------------------------------------- helpers

/** A refusal the page can say in its own language: a code and its values. */
class Refusal extends Error {
  constructor(code, params = {}) {
    super(`${code} ${JSON.stringify(params)}`);
    this.code = code;
    this.params = params;
  }
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

function stripAnsi(s) {
  return String(s ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** A path under root, or null: `..`, absolute paths and NUL never get out. */
function inside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  return buf.length ? JSON.parse(buf.toString('utf8')) : {};
}

function serveFile(res, file, cache = 'no-store') {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// docker compose writes its progress («Container … Started») to stderr, so
// stderr alone does not make a line red: it must also read like a failure.
const LOOKS_BAD = /error|fail|refus|exception|timed? ?out|✘|not found|denied|cannot|could not/i;
// Playwright's list reporter prints a failure on STDOUT: the test's mark
// («✘», or «x» when it is not writing to a terminal), the header of its
// block («1) [chromium] › …») and the error's own lines. Those are errors
// too, or «only errors» hides the very lines it is for. Narrow on purpose:
// a test title or a step that merely says «error» is not one.
const FAILURE_LINE =
  /^\s*(?:(?:✘|x)\s+\d+ \[[\w-]+\] ›|\d+\) \[[\w-]+\] ›|✘|[A-Za-z]*Error:|Expected:|Received:|Timeout:|Test timeout)/;

function log(text, fromStderr = false) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripAnsi(raw).trimEnd();
    if (!line.trim()) continue;
    const isError =
      fromStderr === true ? LOOKS_BAD.test(line) : fromStderr === 'error' || (fromStderr === false && FAILURE_LINE.test(line));
    // Whose run the line is, when a run is open: the page shows the log of
    // the run on its screen, as it shows that run's photos.
    const open = run && !run.closed ? run : null;
    const entry = { text: line, isError, time: new Date().toISOString(), run: open?.id ?? null, suite: open?.suite ?? null };
    logRing.push(entry);
    if (logRing.length > LOG_LINES) logRing.shift();
    if (run && !run.closed) keepLine(run.dir, entry);
    broadcast('log', entry);
  }
}

/**
 * A line of a run's log, on disk: `log.txt` to read, `log.jsonl` for the
 * page to show again after a restart (the ring above lives in memory), with
 * whether it was an error. Synchronous: the asynchronous append it replaces
 * could land two lines of one chunk in the wrong order.
 */
function keepLine(dir, entry) {
  try {
    fs.appendFileSync(path.join(dir, 'log.txt'), `${entry.time} ${entry.text}\n`);
    fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch {
    // A log that cannot be written must not stop the run it describes.
  }
}

/**
 * A run's log as the page shows it. A run from before `log.jsonl` has only
 * `log.txt`: its failures are found again by their shape, and what stderr
 * said is not told apart there.
 */
function readRunLog(dir) {
  const jsonl = path.join(dir, 'log.jsonl');
  if (fs.existsSync(jsonl)) {
    return fs
      .readFileSync(jsonl, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          return l ? [JSON.parse(l)] : [];
        } catch {
          return []; // a line cut short by a stop
        }
      });
  }
  const txt = path.join(dir, 'log.txt');
  if (!fs.existsSync(txt)) return [];
  return fs
    .readFileSync(txt, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const cut = l.indexOf(' ');
      const text = l.slice(cut + 1);
      return {
        text,
        time: l.slice(0, cut),
        isError: FAILURE_LINE.test(text) || (text.startsWith('[cockpit]') && text.includes(': failed')),
      };
    });
}

// ---------------------------------------------------------------- runs

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function newRun(suite, label) {
  const id = `${stamp()}-${suite}`;
  const dir = path.join(COCKPIT_DIR, id);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  return {
    id,
    dir,
    suite,
    label,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    closed: false,
    phase: null, // { files, total, done }
    current: null, // { test, step, actors }
    tests: {}, // title -> { status, duration, errors, trace, order }
    testOrder: [],
    frames: [],
  };
}

function summary(r) {
  if (!r) return null;
  const { dir, frames, closed, ...rest } = r;
  return { ...rest, frameCount: frames.length };
}

function saveRun(r) {
  const { dir, frames, closed, ...meta } = r;
  fs.writeFileSync(path.join(r.dir, 'run.json'), JSON.stringify(meta, null, 1));
}

function loadRun(id) {
  const dir = inside(COCKPIT_DIR, id);
  if (!dir || !fs.existsSync(path.join(dir, 'run.json'))) return null;
  const { meta, frames } = readRunFiles(dir);
  // A run the server did not see finish (it was stopped) is not running now.
  if (meta.status === 'running') meta.status = 'interrupted';
  return { ...meta, dir, frames, closed: true };
}

function listRuns() {
  if (!fs.existsSync(COCKPIT_DIR)) return [];
  return fs
    .readdirSync(COCKPIT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(COCKPIT_DIR, e.name, 'run.json')))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// A note nobody has written yet (the page keeps it until then) is not one.
const noteCount = (dir) => readNotes(dir).filter((n) => n.text.trim()).length;

function pruneRuns() {
  // The newest `keepRuns` runs stay, and those with notes. A search for
  // races (`replay --chaos`) counts as one, all its rounds together: its
  // failed round is what it is for, and the oldest of its rounds.
  const groupOf = (id) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(COCKPIT_DIR, id, 'run.json'), 'utf8')).chaos?.group ?? null;
    } catch {
      return null;
    }
  };
  let kept = 0;
  let last = null;
  for (const id of listRuns()) {
    const group = groupOf(id);
    if (!group || group !== last) kept += 1;
    last = group;
    if (kept <= KEEP_RUNS || noteCount(path.join(COCKPIT_DIR, id))) continue;
    fs.rmSync(path.join(COCKPIT_DIR, id), { recursive: true, force: true });
  }
}

/** What the run picker says under a run: how far its tests got, and the
 *  first that broke. The run itself (tests with their errors and traces)
 *  stays in run.json, read only when the run is opened. */
function tallyOf(r) {
  const tests = Object.entries(r.tests ?? {});
  const broke = tests.find(([, x]) => x.status === 'failed' || x.status === 'timedOut');
  return {
    total: r.phase?.total || r.testOrder?.length || tests.length,
    done: r.phase?.done ?? null,
    passed: tests.filter(([, x]) => x.status === 'passed').length,
    failedAt: broke?.[0] ?? null,
    // Every test it ran: a run of several commands (reset, setup and the
    // recording; a round of a search) ran more than its last one counted.
    count: tests.length,
  };
}

/** How much a run changed from the one it was compared with, or null. */
function changesCount(id) {
  const c = readChanges(COCKPIT_DIR, id);
  return c ? { against: c.against, changed: c.summary.changed, new: c.summary.new, gone: c.summary.gone } : null;
}

function runsIndex() {
  return listRuns().map((id) => {
    const notes = noteCount(path.join(COCKPIT_DIR, id));
    if (run && run.id === id) return { ...summary(run), notes, changes: changesCount(id) };
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(COCKPIT_DIR, id, 'run.json'), 'utf8'));
      return {
        id,
        suite: meta.suite,
        label: meta.label,
        kind: meta.kind ?? null,
        docker: meta.docker ?? false,
        who: meta.who ?? null,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt ?? null,
        status: meta.status === 'running' ? 'interrupted' : meta.status,
        tally: tallyOf(meta),
        notes,
        looks: meta.looks ?? null,
        // Compared with an earlier run: how much changed (changes.mjs).
        changes: changesCount(id),
        // A round of a search for races: its seed, and how many it found.
        ...(meta.chaos ? { chaos: { ...meta.chaos, found: undefined, races: meta.chaos.found ? meta.chaos.found.unstable.length : null } } : {}),
      };
    } catch {
      return { id };
    }
  });
}

// ---------------------------------------------------------------- the stack

async function checkStack() {
  let urls = null;
  try {
    urls = CFG.stack.urlsAsync ? await CFG.stack.urlsAsync() : CFG.stack.urls();
  } catch {
    urls = null;
  }
  let up = false;
  if (urls) {
    try {
      const probe = urls.api && CFG.stack.healthPath ? `${urls.api}${CFG.stack.healthPath}` : urls.app;
      up = CFG.stack.health ? Boolean(await CFG.stack.health(urls)) : (await fetch(probe, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
      up = false;
    }
  }
  const next = {
    up,
    front: urls?.app ?? null,
    back: urls?.api ?? null,
    checkedAt: new Date().toISOString(),
  };
  const changed = next.up !== stack.up || next.front !== stack.front;
  stack = next;
  if (changed) broadcast('stack', stack);
}

// The windows the cockpit opens («Play as», headed runs) appear on the
// desktop it was started on (desktop.mjs): say so when nobody sees that one.
// Linux needs a display for any window. `cockpit --detach` starts it on the
// person's desktop whatever the terminal (detach.mjs).
function checkDesktop() {
  if (process.platform === 'linux') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      desktopWarning = { code: 'no_display' };
    }
    return;
  }
  void desktopOf().then((where) => {
    if (where && where.toLowerCase() !== 'winsta0\\default') {
      desktopWarning = { code: 'hidden_desktop', where };
      log(`[cockpit] started on a desktop nobody sees (${where}): windows will not show. Start it with \`${CFG.cli} cockpit --detach\`.`, 'error');
      broadcast('desktop', { desktopWarning });
    }
  });
}

// THE PACKAGE UPDATED UNDER A RUNNING COCKPIT: npm replaces its files, and
// the cockpit keeps the code it started with, while every run it follows
// brings the new one (the CLI, the workers). What a newer worker sends, an
// older cockpit may read wrong: CritKeep's, started at 0.4.0, dropped every
// click of 0.7.0's photos for a day. It says so, and starts nothing more.
function checkInstalled() {
  let installed = VERSION;
  try {
    installed = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version ?? VERSION;
  } catch {
    // Being replaced this very moment: asked again in a while.
  }
  const next = installed === VERSION ? null : { running: VERSION, installed };
  if (next?.installed === outdated?.installed) return outdated;
  outdated = next;
  if (outdated) log(`[cockpit] QA Cockpit ${installed} is installed, but this cockpit runs ${VERSION}: restart it (${CFG.cli} cockpit --restart).`, 'error');
  broadcast('outdated', { outdated });
  return outdated;
}

/** No run is started, nor followed, by a cockpit older than its package. */
function refuseIfOutdated() {
  const old = checkInstalled();
  if (old) throw new Refusal('cockpit_outdated', old);
}

// ---------------------------------------------------------------- tasks

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  // A replay in a container outlives its `docker run` client: remove it too.
  if (!CFG.stack.compose) return;
  const label = `${CFG.stack.compose.project}-runner`;
  const ids = spawnSync('docker', ['ps', '-q', '--filter', `label=${label}`], { encoding: 'utf8', windowsHide: true })
    .stdout?.trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids?.length) spawnSync('docker', ['rm', '-f', ...ids], { windowsHide: true });
}

function runQa(args, env) {
  return new Promise((resolve) => {
    log(`$ ${CFG.cli} ${args.join(' ')}`);
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: CFG.paths.project,
      env: { ...process.env, FORCE_COLOR: '0', QA_COCKPIT_CONFIG: CFG.file, ...env },
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    task.child = child;
    child.stdout.on('data', (d) => log(d));
    child.stderr.on('data', (d) => log(d, true));
    child.on('error', (e) => {
      log(`[cockpit] ${e.message}`, 'error');
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * The looks a replay takes, from its command's words: what its run is
 * named with, so that a run says at a glance it looked at accessibility,
 * the other languages or real time, or that it was a search for races.
 * @param {string[]} words
 */
function looksOf(words) {
  const at = words.indexOf('replay');
  if (at === -1) return null;
  const rest = words.slice(at + 1);
  const value = (flag) => {
    const i = rest.findIndex((w) => w === flag || w.startsWith(`${flag}=`));
    if (i === -1) return null;
    const v = rest[i].includes('=') ? rest[i].split('=')[1] : rest[i + 1];
    return v && !v.startsWith('-') ? v : '';
  };
  const langs = value('--languages');
  const looks = {
    ...(rest.includes('--a11y') ? { a11y: true } : {}),
    ...(langs !== null ? { languages: langs ? langs.split(',').filter((x) => /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(x)) : (CFG.languages?.priority ?? []) } : {}),
    ...(rest.includes('--realtime') ? { realtime: true } : {}),
    ...(rest.includes('--network') ? { network: true } : {}),
  };
  return Object.keys(looks).length ? looks : null;
}

/**
 * Run a sequence of CLI commands as one task; with a suite, as one run.
 * The kind (reset, setup, replay, full) is what the page names in its
 * language; `label` is only for the log.
 * @param {{ kind: string, suite: string | null, docker?: boolean }} what
 * @param {string[][]} sequence
 */
async function startTask(what, sequence) {
  const { kind, suite, docker = false } = what;
  const label = `${kind}${suite ? ` of ${suite}` : ''}${docker ? ' (container)' : ''}`;
  // The stack for the whole sequence, or the refusal says who has it; the
  // steps are handed the lock through QA_LOCK (lib/lock.mjs).
  let lock;
  try {
    lock = acquireLock(LOCK_FILE, sequence.map((args) => args.join(' ')).join(' → '), { who: 'Cockpit', untilExit: false, cli: CFG.cli });
  } catch (e) {
    if (e instanceof StackBusy) throw busyRefusal(e.holder);
    throw e;
  }
  task = { label, kind, suite, docker, startedAt: new Date().toISOString(), child: null, stopped: false, lock };
  if (suite) {
    if (run && !run.closed) run.closed = true;
    run = newRun(suite, label);
    run.kind = kind;
    run.docker = docker;
    const looks = looksOf(sequence.find((args) => args[0] === 'replay') ?? []);
    if (looks) run.looks = looks;
    saveRun(run);
    pruneRuns();
    lastLive.clear();
    broadcast('run', summary(run));
  }
  broadcast('task', taskInfo());
  const env = { COCKPIT_URL: `http://${HOST}:${PORT}`, COCKPIT_RUN: run && suite ? run.id : 'adhoc', QA_LOCK: lock.token };
  let code = 0;
  try {
    for (const args of sequence) {
      code = await runQa(args, env);
      if (code !== 0 || task.stopped) break;
    }
  } finally {
    lock.release();
    watchLock();
  }
  finishTask(task.stopped ? 'stopped' : code === 0 ? 'passed' : 'failed', code);
}

/** The task's end, the cockpit's own or a terminal's: its run closed with
 *  a status, and the page told. */
function finishTask(status, code = 0) {
  if (!task) return;
  log(`[cockpit] ${task.label}: ${status === 'failed' ? `failed (exit ${code})` : status}`, status === 'failed' ? 'error' : false);
  if (task.suite && run && !run.closed) {
    run.status = status;
    run.endedAt = new Date().toISOString();
    run.current = null;
    saveRun(run);
    run.closed = true;
    forgetUnseenPhotos(run);
    broadcast('run', summary(run));
  }
  task = null;
  broadcast('task', null);
}

/** The photos of a run that no frame took (its worker cut short, or newer
 *  than this cockpit): nobody can see them, and they took room. A step's
 *  photos in its other languages (`--languages`) are its frame's too. */
function forgetUnseenPhotos(r) {
  try {
    const dir = path.join(r.dir, 'frames');
    const seen = new Set(r.frames.flatMap((f) => [f.file, ...(f.langs ?? []).map((l) => l.file)]).map((file) => path.basename(file)));
    for (const name of fs.readdirSync(dir)) if (!seen.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // Kept, then: the run is no worse for it.
  }
}

// ---------------------------------------------------------------- runs from a terminal

const EXTERNAL_KINDS = new Set(['reset', 'setup', 'sessions', 'replay']);

/**
 * A run launched from a terminal while the cockpit is up (cli.mjs,
 * «announce»): it becomes the cockpit's task and, with a suite, its run, as
 * if the buttons had started it, so its steps, photos, traces and log land
 * here. The process stays the terminal's and holds the stack's lock itself;
 * the cockpit only follows it, and cannot stop it.
 */
function beginExternal(body) {
  if (task) throw new Refusal('task_running');
  refuseIfOutdated();
  const pid = Number(body.pid);
  if (!Number.isInteger(pid) || !isAlive(pid)) throw new Refusal('unknown_action', { action: 'external' });
  const kind = EXTERNAL_KINDS.has(body.kind) ? body.kind : 'replay';
  const suite = listSuites(CFG).find((s) => s.name === body.suite)?.name ?? null;
  const who = String(body.who ?? 'terminal').slice(0, 60);
  const command = String(body.command ?? kind).slice(0, 200);
  const label = `${kind}${suite ? ` of ${suite}` : ''} (${who})`;
  task = { label, kind, suite, docker: false, startedAt: new Date().toISOString(), child: null, stopped: false, external: { pid, who } };
  if (suite) {
    if (run && !run.closed) run.closed = true;
    run = newRun(suite, label);
    run.kind = kind;
    run.who = who;
    const looks = looksOf(command.split(/\s+/));
    if (looks) run.looks = looks;
    saveRun(run);
    pruneRuns();
    lastLive.clear();
    broadcast('run', summary(run));
  }
  broadcast('task', taskInfo());
  log(`$ ${CFG.cli} ${command}   (${who}, from a terminal)`);
  return { ok: true, run: suite ? run.id : 'adhoc' };
}

/** Lines a terminal's run wrote, for the log: only from the process followed. */
function externalLines(body) {
  if (!task?.external || Number(body.pid) !== task.external.pid) return false;
  for (const line of Array.isArray(body.lines) ? body.lines : []) log(String(line.text ?? ''), line.err ? true : false);
  return true;
}

// ---------------------------------------------------------------- changes from an earlier run

// A run compared with another green one (changes.mjs), when a person picks
// it: the CLI's `changes`, in a process of its own (it opens the project's
// Chromium), and the page told when it is done. Not a task: the stack is
// not touched.
const comparing = new Set();
function compareAgain(id, against) {
  if (!RUN_ID.test(id) || !RUN_ID.test(String(against ?? ''))) return { ok: false };
  if (!candidatesOf(COCKPIT_DIR, id).some((c) => c.id === against)) return { ok: false };
  if (comparing.has(id)) return { ok: true };
  comparing.add(id);
  const child = spawn(process.execPath, [BIN, 'changes', id, '--against', against, '--again', '--quiet'], {
    cwd: CFG.paths.project,
    env: { ...process.env, FORCE_COLOR: '0', QA_COCKPIT_CONFIG: CFG.file },
    windowsHide: true,
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => {
    comparing.delete(id);
    if (code) log(`[cockpit] ${id} not compared with ${against}: ${stripAnsi(err).trim().split('\n').at(-1) ?? `exit ${code}`}`, 'error');
    broadcast('changes', { run: id });
  });
  broadcast('changes', { run: id, comparing: true });
  return { ok: true };
}

// ---------------------------------------------------------------- reports from «Play as»

// A window opened by «Play as» is followed for a report (open-browser.mjs,
// play.mjs): its process tells what the person does there, each action
// with the window just before it, and the page's requests and errors.
// «Make a report» turns what every window did since its last report into
// a run of kind «play», closed from birth: a run going on the stack is not
// touched. The sessions live while the cockpit does; their photos, in
// <cockpit>/play/<session>/, until the next ones push them out.
const plays = new Map();
const PLAY_EVENTS = 2_000;
const PLAY_SESSIONS = 8;
const capWord = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** What the page shows of each window: open, and what it did since its last report. */
function playsInfo() {
  return [...plays.values()]
    .map((p) => {
      const fresh = p.events.filter((e) => e.t > p.since);
      const errors = fresh.filter((e) => e.kind === 'console' || (e.kind === 'request' && (e.status === 0 || e.status >= 500))).length;
      return { session: p.session, actor: p.actor, open: p.open, dismissed: Boolean(p.dismissed), acts: fresh.filter((e) => e.kind === 'act').length, errors, latest: p.latest?.t ?? null };
    })
    // A window dropped («Drop it») shows again at its next action.
    .filter((p) => (p.open && !p.dismissed) || p.acts > 0);
}

/** «Drop it»: what every window did since its last report, with no report;
 *  a window still open shows again at its next action. */
function playDiscard() {
  const now = Date.now();
  for (const p of [...plays.values()]) {
    p.since = now;
    p.dismissed = true;
    if (!p.open) {
      plays.delete(p.session);
      fs.rmSync(p.dir, { recursive: true, force: true });
    }
  }
  playsChanged();
  return { ok: true };
}

let playsTimer = null;
function playsChanged() {
  if (playsTimer) return;
  playsTimer = setTimeout(() => {
    playsTimer = null;
    broadcast('plays', playsInfo());
  }, 400);
}

/** The oldest closed windows' sessions, and their photos, beyond the few kept. */
function forgetOldPlays() {
  const closed = [...plays.values()].filter((p) => !p.open);
  for (const p of closed.slice(0, Math.max(0, plays.size - PLAY_SESSIONS))) {
    plays.delete(p.session);
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
}

const numOf = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const strOf = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const PLAY_PHOTO = /^[\w.-]{1,80}\.jpg$/;

/** A window's event as the cockpit keeps it, or null. */
function playEventOf(e) {
  if (!e || typeof e !== 'object') return null;
  const t = numOf(e.t);
  if (t === null) return null;
  const viewport = viewportOf(e.viewport);
  switch (e.kind) {
    case 'hello': {
      const d = e.device;
      const device =
        d && typeof d.name === 'string'
          ? { name: d.name.slice(0, 60), kind: ['phone', 'tablet', 'laptop', 'desktop'].includes(d.kind) ? d.kind : 'desktop', width: numOf(d.width), height: numOf(d.height) }
          : null;
      return { kind: 'hello', t, device };
    }
    case 'latest':
      return { kind: 'latest', t, viewport, url: strOf(e.url, 500) };
    case 'closed':
      return { kind: 'closed', t };
    case 'nav':
      return { kind: 'nav', t, url: strOf(e.url, 500) };
    case 'console':
      return { kind: 'console', t, level: e.level === 'exception' ? 'exception' : 'error', text: strOf(e.text, 300) };
    case 'request':
      return {
        kind: 'request',
        t,
        type: e.type === 'page' ? 'page' : 'api',
        method: strOf(e.method, 10),
        path: strOf(e.path, 200),
        status: numOf(e.status) ?? 0,
        ms: numOf(e.ms),
        ...(e.failure ? { failure: strOf(e.failure, 120) } : {}),
      };
    case 'act':
      if (!['click', 'type', 'key', 'pick'].includes(e.act)) return null;
      return {
        kind: 'act',
        act: e.act,
        t,
        label: strOf(e.label, 60),
        value: typeof e.value === 'string' ? e.value.slice(0, 200) : null,
        hidden: e.hidden === true,
        ...(e.act === 'key' ? { key: strOf(e.key, 20) } : {}),
        url: strOf(e.url, 500),
        x: numOf(e.x) ?? 0,
        y: numOf(e.y) ?? 0,
        vx: numOf(e.vx) ?? 0,
        vy: numOf(e.vy) ?? 0,
        photo: typeof e.photo === 'string' && PLAY_PHOTO.test(e.photo) ? e.photo : null,
        viewport,
      };
    default:
      return null;
  }
}

/** A window's events, from its own process: only with its session's token. */
function playEvents(body) {
  const p = plays.get(String(body?.session ?? ''));
  if (!p || body.token !== p.token || !Array.isArray(body.events)) return false;
  for (const raw of body.events.slice(0, 500)) {
    const e = playEventOf(raw);
    if (!e) continue;
    if (e.kind === 'hello') p.device = e.device;
    else if (e.kind === 'latest') p.latest = { t: e.t, viewport: e.viewport, url: e.url };
    else if (e.kind === 'closed') p.open = false;
    else {
      p.events.push(e);
      if (e.kind === 'act') {
        p.dismissed = false;
        // A person playing by hand changes the data a replay expects
        // (stackdata.mjs): the Replay button asks, the CLI warns.
        const data = readData(CFG);
        if (data?.state !== 'played' || data.who !== p.actor) noteData(CFG, { state: 'played', suite: data?.suite ?? null, who: p.actor });
      }
    }
  }
  if (p.events.length > PLAY_EVENTS) p.events.splice(0, p.events.length - PLAY_EVENTS);
  playsChanged();
  return true;
}

/**
 * «Make a report»: what every window did since its last report, as a run
 * of the suite on screen, with the person's note on what went wrong.
 */
function playReport(body) {
  const suite = listSuites(CFG).find((s) => s.name === body?.suite)?.name;
  if (!suite) throw new Refusal('no_suite', { suite: String(body?.suite ?? '') });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  const sessions = [...plays.values()].filter((p) => p.events.some((e) => e.kind === 'act' && e.t > p.since));
  if (!sessions.length) throw new Refusal('play_nothing');
  const now = Date.now();
  const first = note.split('\n')[0].trim();
  const title = `P · ${first ? first.slice(0, 80) : `${sessions.map((p) => capWord(p.actor)).join(', ')} at play`}`;
  let id = `${stamp()}-${suite}`;
  for (let k = 2; fs.existsSync(path.join(COCKPIT_DIR, id)); k++) id = `${stamp()}-${suite}-${k}`;
  const dir = path.join(COCKPIT_DIR, id);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  const built = playRun({
    sessions: sessions.map((p) => ({ actor: p.actor, device: p.device, dir: p.dir, events: p.events, since: p.since, latest: p.latest })),
    note,
    title,
    runDir: dir,
    relOut: (abs) => path.relative(CFG.paths.out, abs).split(path.sep).join('/'),
    now,
  });
  for (const c of built.copies) {
    try {
      fs.copyFileSync(c.from, c.to);
    } catch {
      // A photo gone: its step says what was done all the same.
    }
  }
  const wrong = note || 'Reported from «Play as», with no note.';
  const meta = {
    id,
    suite,
    label: `play of ${suite}`,
    kind: 'play',
    startedAt: built.startedAt,
    endedAt: new Date(now).toISOString(),
    status: 'failed',
    phase: { files: 1, total: 1, done: 1 },
    current: null,
    tests: { [title]: { status: 'failed', duration: Math.max(0, now - Date.parse(built.startedAt)), errors: [{ message: wrong }], trace: null } },
    testOrder: [title],
    play: { note, people: built.people, acts: built.acts, dropped: built.dropped },
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(dir, 'frames.jsonl'), built.frames.map((f) => `${JSON.stringify(f)}\n`).join(''));
  for (const p of sessions) p.since = now;
  pruneRuns();
  playsChanged();
  log(`[cockpit] a report from «Play as» (${built.people.join(', ')}, ${built.acts} actions): ${id}`);
  return { ok: true, run: id };
}

// ---------------------------------------------------------------- races between people

// A search for races (`replay --chaos`, cli.mjs and chaos.mjs) plays its
// rounds in one process, the cockpit's task or a terminal's: each round is
// a run of its own here, with its seed and how it slowed each person, and
// the search's end leaves what the rounds found in each of its runs.
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const textOf = (v, max = 300) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const RUN_ID = /^[\w.-]{1,120}$/;

const slowedOf = (people) =>
  Object.fromEntries(
    Object.entries(people && typeof people === 'object' ? people : {})
      .filter(([id, p]) => ACTOR.test(id) && p && typeof p === 'object')
      .slice(0, 20)
      .map(([id, p]) => [id, { network: intIn(p.network, 0, 60_000) ?? 0, pushes: intIn(p.pushes, 0, 60_000) ?? 0, cpu: intIn(p.cpu, 1, 20) ?? 1 }]),
  );

function chaosOf(x) {
  if (!x || typeof x !== 'object') return null;
  // Round 0 of a search: as it is, nobody slowed, no seed.
  const round = intIn(x.round, 0, 50);
  const of = intIn(x.of, 1, 50);
  const seed = round === 0 ? null : intIn(x.seed, 1, 999_999_999);
  if (round === null || !of || (round && !seed) || round > of) return null;
  return { group: typeof x.group === 'string' && RUN_ID.test(x.group) ? x.group : null, round, of, seed, people: slowedOf(x.people) };
}

function foundOf(x) {
  if (!x || typeof x !== 'object') return null;
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const steps = (v) =>
    list(v, 200)
      .map((s) => ({
        test: textOf(s?.test),
        step: textOf(s?.step),
        passed: list(s?.passed, 50).filter((n) => intIn(n, 0, 50) !== null),
        failed: list(s?.failed, 50)
          .map((f) => ({ round: intIn(f?.round, 0, 50), seed: intIn(f?.seed, 1, 999_999_999), error: textOf(f?.error) }))
          .filter((f) => f.round !== null && (f.round === 0 || f.seed)),
      }))
      .filter((s) => s.test && s.step);
  return {
    of: intIn(x.of, 1, 50),
    stopped: intIn(x.stopped, 0, 50),
    rounds: list(x.rounds, 51)
      .map((r) => ({
        round: intIn(r?.round, 0, 50),
        seed: intIn(r?.seed, 1, 999_999_999),
        status: r?.status === 'passed' ? 'passed' : 'failed',
        run: typeof r?.run === 'string' && RUN_ID.test(r.run) ? r.run : null,
        people: slowedOf(r?.people),
      }))
      .filter((r) => r.round !== null && (r.round === 0 || r.seed)),
    // Each slowed round compared with round 0 (changes.mjs): how much changed.
    changes: list(x.changes, 50)
      .map((c) => ({
        round: intIn(c?.round, 1, 50),
        changed: intIn(c?.changed, 0, 10_000) ?? 0,
        new: intIn(c?.new, 0, 10_000) ?? 0,
        gone: intIn(c?.gone, 0, 10_000) ?? 0,
      }))
      .filter((c) => c.round),
    unstable: steps(x.unstable),
    always: steps(x.always),
    outside: list(x.outside, 50)
      .map((o) => ({
        round: intIn(o?.round, 0, 50),
        seed: intIn(o?.seed, 1, 999_999_999),
        tests: list(o?.tests, 50)
          .map((t) => ({ test: textOf(t?.test), error: textOf(t?.error) }))
          .filter((t) => t.test),
      }))
      .filter((o) => o.round !== null && (o.round === 0 || o.seed)),
  };
}

/** The run a search reports to, named by the process playing it. */
const searching = (body) => Boolean(task && run && !run.closed && task.suite && body?.run === run.id);

/** The end of a round's run: its status, as the search tells it. */
function closeRound(status) {
  run.status = status === 'passed' ? 'passed' : 'failed';
  run.endedAt = new Date().toISOString();
  run.current = null;
  saveRun(run);
  run.closed = true;
  forgetUnseenPhotos(run);
  broadcast('run', summary(run));
}

/**
 * A round begins. The first names the run that follows the search; each
 * next one closes the round before, with its status, and opens a run of
 * its own, of the same kind. Its id goes back, for the round's reports.
 */
function chaosRound(body) {
  const chaos = chaosOf(body?.chaos);
  // Asked again, its answer lost on the way: the round has its run already.
  if (chaos?.group && task && run && !run.closed && run.chaos?.group === chaos.group && run.chaos.round === chaos.round) return { ok: true, run: run.id };
  if (!searching(body) || !chaos) return { ok: false };
  if (run.chaos) {
    const { suite, label, kind, docker, who } = run;
    closeRound(body.previous);
    run = newRun(suite, label);
    Object.assign(run, { kind, docker }, who ? { who } : {});
    run.chaos = chaos;
    saveRun(run);
    pruneRuns();
    lastLive.clear();
  } else {
    run.chaos = chaos;
    saveRun(run);
  }
  broadcast('run', summary(run));
  return { ok: true, run: run.id };
}

/**
 * The search's end: its last round closed with its status (the process
 * ends red when any round failed), and what the rounds found kept in each
 * of its runs, for the report of any of them.
 */
function chaosEnd(body) {
  if (!searching(body) || !run.chaos) return { ok: false };
  const found = foundOf(body.found);
  if (found && run.chaos.group) {
    run.chaos.found = found;
    for (const id of listRuns()) {
      if (id === run.id) continue;
      const file = path.join(COCKPIT_DIR, id, 'run.json');
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (meta.chaos?.group !== run.chaos.group) continue;
        meta.chaos.found = found;
        fs.writeFileSync(file, JSON.stringify(meta, null, 1));
      } catch {
        // A round gone (pruned, or by hand): the others say it.
      }
    }
  }
  closeRound(body.status);
  return { ok: true };
}

// ---------------------------------------------------------------- report events

function onReport(e) {
  if (!run || run.closed || e.run !== run.id) return;
  if (e.type === 'run:begin') {
    run.phase = { files: e.files, total: e.totalTests, done: 0 };
    for (const t of e.tests ?? []) if (!run.testOrder.includes(t)) run.testOrder.push(t);
  } else if (e.type === 'test:begin') {
    run.current = { test: e.test, step: null, actors: [] };
    run.tests[e.test] = { ...(run.tests[e.test] ?? {}), status: 'running' };
  } else if (e.type === 'step:begin') {
    run.current = { test: e.test, step: e.step, actors: e.actors };
  } else if (e.type === 'step:end') {
    if (e.error) run.current = { test: e.test, step: e.step, actors: e.actors, error: e.error };
  } else if (e.type === 'test:end') {
    if (run.phase) run.phase.done += 1;
    // The trace arrived just before (the reporter's queue keeps the order).
    run.tests[e.test] = { status: e.status, duration: e.duration, errors: e.errors, trace: run.tests[e.test]?.trace ?? null };
  }
  saveRun(run);
  broadcast('report', e);
  broadcast('run', summary(run));
}

// A photo's file, as the worker names it: inside this run's frames/, and there.
function frameFile(name) {
  const file = inside(path.join(run.dir, 'frames'), path.relative(path.join('cockpit', run.id, 'frames'), String(name ?? '')));
  return file && fs.existsSync(file) ? path.relative(CFG.paths.out, file).split(path.sep).join('/') : null;
}

const viewportOf = (v) => (v && Number.isFinite(v.width) ? { width: v.width, height: v.height } : null);

// A photo's marks, at its own pixels: the page's for a step's (`x`, `y`),
// the window's for an action's (`vx`, `vy`).
const marksOf = (list, inWindow = false) =>
  (Array.isArray(list) ? list : []).slice(0, 50).map((m) => ({
    kind: m.kind === 'type' ? 'type' : 'click',
    x: Number(inWindow ? (m.vx ?? m.x) : m.x) || 0,
    y: Number(inWindow ? (m.vy ?? m.y) : m.y) || 0,
    url: String(m.url ?? ''),
    label: String(m.label ?? '').slice(0, 60),
    at: Number.isFinite(Number(m.at)) ? Number(m.at) : null,
    // Its number among the step's actions (worker.mjs); none in older runs.
    ...(Number.isInteger(m.n) && m.n > 0 ? { n: m.n } : {}),
  }));

// What a look at a step's screen found, each with its box at the page's
// pixels when it is drawn: accessibility (`replay --a11y`, a11y.mjs), a
// rule and the element; a language (`--languages`, languages.mjs), a rule
// and the words that do not fit.
const RULES = { a11y: new Set(['name', 'label', 'alt', 'keyboard']), lang: new Set(['cut', 'wide', 'key']) };
const boxOf = (b) =>
  b && [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(Number(v)))
    ? { x: Math.max(0, Math.round(b.x)), y: Math.max(0, Math.round(b.y)), w: Math.max(0, Math.round(b.w)), h: Math.max(0, Math.round(b.h)) }
    : null;
const findingsOf = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((x) => RULES[x?.kind]?.has(x.rule))
    .slice(0, 50)
    .map((x) =>
      x.kind === 'a11y'
        ? { kind: 'a11y', rule: x.rule, role: String(x.role ?? '').slice(0, 30), name: x.name ? String(x.name).slice(0, 80) : null, what: String(x.what ?? '').slice(0, 120), box: boxOf(x.box) }
        : { kind: 'lang', rule: x.rule, lang: String(x.lang ?? '').slice(0, 12), text: String(x.text ?? '').slice(0, 80), box: boxOf(x.box) },
    );

// What changes on a screen by itself (changes.mjs), as boxes at its photo's pixels.
const masksOf = (list) => (Array.isArray(list) ? list : []).slice(0, 50).map(boxOf).filter(Boolean);
// What a page said went wrong while its step went: console errors, what it threw.
const consoleOf = (list) =>
  (Array.isArray(list) ? list : []).slice(0, 20).map((c) => ({
    level: c?.level === 'exception' ? 'exception' : 'error',
    text: String(c?.text ?? '').slice(0, 300),
    at: Number.isFinite(Number(c?.at)) ? Number(c.at) : null,
  }));

// The hand-off a step ended with (`replay --realtime`, realtime.mjs):
// another person's action, and how long until it was sent, received here,
// and seen on this screen.
const handOffOf = (h) => {
  if (!h || typeof h !== 'object') return null;
  const leg = (x, word) =>
    x && Number.isFinite(Number(x.ms)) ? { ms: Math.max(0, Math.round(Number(x.ms))), [word]: String(x[word] ?? '').slice(0, 80) } : null;
  const out = { from: String(h.from ?? '').slice(0, 40), what: String(h.what ?? '').slice(0, 80), sent: leg(h.sent, 'what'), received: leg(h.received, 'what'), seen: leg(h.seen, 'text') };
  // Seen with no pushed message carrying it: not live, and the answer it likely came with.
  if (h.live === false && out.seen) Object.assign(out, { live: false, via: h.via ? String(h.via).slice(0, 80) : null });
  return out.received || out.seen ? out : null;
};

// A step's screen in the app's other languages: each its photo, where it
// was scrolled to, whether its words changed, and what does not fit.
const langsOf = (list) =>
  (Array.isArray(list) ? list : []).slice(0, 12).flatMap((s) => {
    const file = frameFile(s.file);
    if (!file) return [];
    const scroll = s.scroll && Number.isFinite(s.scroll.y) ? { x: Number(s.scroll.x) || 0, y: Number(s.scroll.y) || 0 } : { x: 0, y: 0 };
    return [{ lang: String(s.lang ?? '').slice(0, 12), file, scroll, changed: s.changed !== false, findings: findingsOf(s.findings) }];
  });

/**
 * A step's photo, and before it the photos of its actions (worker.mjs,
 * ACTION PHOTOS): each a photo of its own, `kind: 'action'`, of the step
 * photographed after it (`of`). An action's photo is the window, its marks
 * at the window's pixels; one whose file is missing gives its marks back to
 * the step's photo.
 */
function onFrame(f) {
  if (!run || run.closed || f.run !== run.id) return false;
  const file = frameFile(f.file);
  if (!file) return false;
  const marks = marksOf(f.marks);
  const shots = [];
  for (const s of (Array.isArray(f.shots) ? f.shots : []).slice(0, 50)) {
    const shot = frameFile(s.file);
    if (shot) shots.push({ ...s, file: shot, masks: masksOf(s.masks) });
    else marks.push(...marksOf(s.marks));
  }
  // In the order they were made, so that the step's list reads 1, 2, 3.
  marks.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const step = {
    actor: String(f.actor),
    test: String(f.test ?? ''),
    step: String(f.step ?? ''),
    status: String(f.status ?? ''),
  };
  // The device the person played on (devices.mjs): what it is, for the card.
  const device =
    f.device && typeof f.device.name === 'string'
      ? {
          name: f.device.name.slice(0, 60),
          kind: ['phone', 'tablet', 'laptop', 'desktop'].includes(f.device.kind) ? f.device.kind : 'desktop',
          width: Number(f.device.width) || null,
          height: Number(f.device.height) || null,
        }
      : null;
  const location = f.location ? String(f.location) : null;
  const began = f.began ? String(f.began) : null;
  const of = run.frames.length + shots.length + 1;
  const frames = shots.map((s, i) => ({
    seq: run.frames.length + i + 1,
    kind: 'action',
    of,
    ...step,
    error: null,
    url: String(s.url ?? ''),
    file: s.file,
    location,
    viewport: viewportOf(s.viewport),
    scroll: { x: 0, y: 0 },
    marks: marksOf(s.marks, true),
    masks: s.masks,
    device,
    requests: [],
    began,
    ms: null,
    time: String(s.time ?? new Date().toISOString()),
  }));
  frames.push({
    seq: of,
    ...step,
    error: f.error ? String(f.error) : null,
    url: String(f.url ?? ''),
    file,
    location,
    viewport: viewportOf(f.viewport),
    scroll: f.scroll && Number.isFinite(f.scroll.y) ? { x: Number(f.scroll.x) || 0, y: Number(f.scroll.y) || 0 } : { x: 0, y: 0 },
    marks,
    device,
    requests: (Array.isArray(f.requests) ? f.requests : []).slice(0, 200).map((r) => ({
      kind: r.kind === 'page' ? 'page' : 'api',
      method: String(r.method ?? '').slice(0, 10),
      path: String(r.path ?? '').slice(0, 200),
      status: Number(r.status) || 0,
      ms: Number.isFinite(Number(r.ms)) && r.ms !== null ? Math.max(0, Math.round(Number(r.ms))) : null,
      at: Number.isFinite(Number(r.at)) ? Number(r.at) : null,
    })),
    masks: masksOf(f.masks),
    console: consoleOf(f.console),
    findings: findingsOf(f.findings),
    langs: langsOf(f.langs),
    // A step whose language was not changed (the change failed, or the
    // project's `ready` said not now),
    // and the one after which the look stopped (its screen did not come back).
    langsSkipped: f.langsSkipped ? String(f.langsSkipped).slice(0, 200) : null,
    langsStopped: f.langsStopped ? String(f.langsStopped).slice(0, 200) : null,
    realtime: handOffOf(f.realtime),
    began,
    ms: Number.isFinite(Number(f.ms)) && f.ms !== null ? Math.max(0, Math.round(Number(f.ms))) : null,
    // The cockpit's own photos in the step, and the step's: apart from `ms`.
    photosMs: Number.isFinite(Number(f.photosMs)) && f.photosMs !== null ? Math.max(0, Math.round(Number(f.photosMs))) : null,
    time: String(f.time ?? new Date().toISOString()),
  });
  for (const frame of frames) {
    run.frames.push(frame);
    fs.appendFileSync(path.join(run.dir, 'frames.jsonl'), JSON.stringify(frame) + '\n');
    broadcast('frame', frame);
  }
  // The look in other languages stopped for the rest of the run: said once,
  // in its log, with why.
  if (f.langsStopped && !run.langsStopped) {
    run.langsStopped = String(f.langsStopped).slice(0, 200);
    log(`[cockpit] languages: stopped after ${step.test} › ${step.step} (${step.actor}): ${run.langsStopped}. The rest of the run plays in its own language only.`, 'error');
  }
  return true;
}

// ---------------------------------------------------------------- live

function watchedActors() {
  return [...liveClients.entries()].filter(([, set]) => set.size > 0).map(([actor]) => actor);
}

function writePart(res, buf) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
  res.write(buf);
  res.write('\r\n');
}

// ---------------------------------------------------------------- play as

/** A person's usual device, as the cockpit shows it; never a failed page. */
function usualDevice(id) {
  try {
    return deviceLabel(deviceFor(CFG, id));
  } catch {
    return null;
  }
}

/**
 * «Play as»: a window signed in as the person, on the device they last
 * played on in the run on screen (a suite may put them on another than
 * their usual one), or on their usual device.
 */
/**
 * Why a person's saved session is the run's now, or null. A window of
 * theirs (`Play as`) opens from that session: the server would see one
 * person in two places, and what the window did, the run's person would
 * have done (a sign-out signs the run out); the run, for its part, renews
 * or clears the session under the window. So not while a run plays them,
 * nor while a reset or a renewal of every session goes. Somebody else may
 * play in the same data, after a word of warning (the page asks).
 */
function sessionInUse(actor) {
  if (!task) return null;
  if (!task.suite) return task.kind === 'reset' || task.kind === 'sessions' ? 'sessions_renewing' : null;
  return listSuites(CFG).find((s) => s.name === task.suite)?.cast.includes(actor) ? 'person_in_run' : null;
}

function playAs(actor) {
  const last = run?.frames?.findLast?.((f) => f.actor === actor && f.device)?.device;
  // The window followed for a report (play.mjs): a session of its own.
  const session = `${stamp()}-${actor}-${randomBytes(3).toString('hex')}`;
  const p = { session, actor, token: randomBytes(16).toString('hex'), dir: path.join(COCKPIT_DIR, 'play', session), startedAt: new Date().toISOString(), open: true, events: [], since: 0, latest: null, device: null };
  plays.set(session, p);
  forgetOldPlays();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPEN_BROWSER, actor], {
      cwd: CFG.paths.project,
      env: {
        ...process.env,
        QA_COCKPIT_CONFIG: CFG.file,
        FRONTEND_URL: stack.front ?? '',
        ...(last ? { QA_DEVICE: last.name } : {}),
        COCKPIT_URL: `http://${HOST}:${PORT}`,
        QA_PLAY_SESSION: session,
        QA_PLAY_TOKEN: p.token,
        QA_PLAY_DIR: p.dir,
      },
      // Hides this node's console only; the browser it starts shows itself.
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let ready = false;
    const done = (result) => {
      clearTimeout(timer);
      child.stdout.removeAllListeners('data');
      if (!result.ok && !ready) plays.delete(session);
      ready ||= result.ok;
      playsChanged();
      resolve(result);
    };
    child.on('exit', () => {
      p.open = false;
      playsChanged();
    });
    const timer = setTimeout(() => done({ ok: false, error: 'The browser said nothing in 30 seconds.' }), 30_000);
    child.stdout.on('data', (d) => {
      out += d;
      if (/^READY$/m.test(out)) done({ ok: true, warning: desktopWarning });
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => done({ ok: false, error: stripAnsi(err).trim().slice(-600) || `It exited with code ${code}.` }));
    child.unref();
  });
}

// ---------------------------------------------------------------- http

function allowedHosts() {
  return new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `host.docker.internal:${PORT}`]);
}

function allowedOrigins() {
  return new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
}

function taskInfo() {
  return task
    ? { label: task.label, kind: task.kind, suite: task.suite, docker: task.docker, startedAt: task.startedAt, who: task.external?.who ?? null, external: Boolean(task.external) }
    : null;
}

/** The stack is someone else's: a refusal the page says in its language. */
function busyRefusal(holder) {
  const at = new Date(holder.since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return new Refusal('stack_busy', { who: holder.who, command: holder.command, at });
}

/** Who holds the stack now, as the page shows it; null when free. */
function lockInfo() {
  const held = readLock(LOCK_FILE);
  // «Mine» is a lock the page already shows as a running task: the
  // cockpit's own, or the terminal's run it follows.
  const mine = Boolean((task?.lock && held?.token === task.lock.token) || (task?.external && held?.pid === task.external.pid));
  return held ? { who: held.who, command: held.command, since: held.since, pid: held.pid, mine } : null;
}

// A run launched from a terminal takes the lock without the cockpit knowing:
// the file is looked at every two seconds and the page told when it changes.
let lastLock = 'null';
function watchLock() {
  // A terminal's run that died without its end (Ctrl+C, a crash).
  if (task?.external && !isAlive(task.external.pid)) finishTask('interrupted');
  const now = JSON.stringify(lockInfo());
  if (now === lastLock) return;
  lastLock = now;
  broadcast('lock', JSON.parse(now));
}

function state() {
  const sessions = fs.existsSync(CFG.paths.state)
    ? fs.readdirSync(CFG.paths.state).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [];
  const rel = (abs) => (abs ? shown(CFG, abs) : null);
  return {
    port: PORT,
    // Which cockpit this is, and its process: `cockpit --detach` tells an
    // older one apart, and `--restart` stops this one (detach.mjs).
    version: VERSION,
    // Older than the package installed now: restart it.
    outdated: checkInstalled(),
    pid: process.pid,
    name: CFG.name,
    project: CFG.stack.name,
    // Where the cockpit runs, and how: the page shows the command when this
    // server is gone, and a page cannot find it out by itself.
    projectDir: CFG.paths.project,
    cli: CFG.cli,
    language: CFG.cockpit.language,
    // The app's languages, when its config says how to change them (`--languages`).
    languages: CFG.languages ? { base: CFG.languages.base, others: CFG.languages.others, priority: CFG.languages.priority } : null,
    // Paths as people and agents read them (relative to the repo), for the
    // report and the messages the page copies.
    paths: {
      out: rel(CFG.paths.out),
      suites: rel(CFG.paths.suites),
      recordings: rel(CFG.paths.recordings),
      setups: rel(CFG.paths.setups),
      project: rel(CFG.paths.project),
      skill: rel(CFG.paths.skill),
    },
    recordingExt: CFG.suiteFormat.extensions[0],
    setupExt: CFG.suiteFormat.setupExtensions[0],
    reportNotes: CFG.report.notes,
    // What the stack's data is now (stackdata.mjs): the Replay button asks
    // before a replay that would not find its suite's setup.
    data: readData(CFG),
    stack,
    desktopWarning,
    lock: lockInfo(),
    suites: listSuites(CFG),
    sessions,
    cast: CFG.cast.map((p) => ({ id: p.id, name: p.name, email: p.email, badge: p.badge, device: usualDevice(p.id) })),
    task: taskInfo(),
    run: summary(run),
    runs: runsIndex(),
    watched: watchedActors(),
    // The windows of «Play as» followed for a report, and what each did since the last.
    plays: playsInfo(),
  };
}

async function onAction(body) {
  const { action, suite, headed, docker, a11y, languages, realtime, chaos, chaosSeed, changes, actor } = body;
  const known = listSuites(CFG);
  const pick = () => {
    const s = known.find((x) => x.name === suite);
    if (!s) throw new Refusal('no_suite', { suite });
    return s;
  };
  const inDocker = docker ? ['--in-docker'] : [];
  // The languages chosen on the page, each one of the config's; `true`, its priority ones.
  const chosenLangs = !CFG.languages || !languages ? [] : (Array.isArray(languages) ? languages.map(String) : CFG.languages.priority).filter((x) => CFG.languages.others.includes(x));
  // A search for races (`--chaos`): its rounds, each from fresh data by
  // itself, compared rather than looked at, so without the looks.
  const rounds = intIn(Number(chaos), 2, 50);
  // One round of a search again (`--chaos-seed`): from fresh data too, and
  // with any look.
  const seed = rounds ? null : intIn(Number(chaosSeed), 1, 999_999_999);
  const replayArgs = (name) => [
    'replay',
    name,
    ...inDocker,
    ...(headed && !docker ? ['--headed'] : []),
    ...(rounds
      ? ['--chaos', String(rounds)]
      : [
          ...(seed ? ['--chaos-seed', String(seed)] : []),
          // Compared with an earlier green run at its end (changes.mjs): the newest, or the one named.
          ...(changes ? ['--changes', ...(typeof changes === 'string' && RUN_ID.test(changes) ? [changes] : [])] : []),
          ...(a11y ? ['--a11y'] : []),
          ...(realtime ? ['--realtime'] : []),
          ...(chosenLangs.length ? ['--languages', chosenLangs.join(',')] : []),
        ]),
  ];
  if (action === 'stop') {
    if (!task) return { ok: true, stopped: false };
    if (task.external) throw new Refusal('external_task', { who: task.external.who });
    task.stopped = true;
    killTree(task.child);
    return { ok: true, stopped: true };
  }
  if (action === 'play-as') {
    if (!ACTOR.test(actor ?? '') || !fs.existsSync(path.join(CFG.paths.state, `${actor}.json`))) {
      throw new Refusal('no_session', { actor });
    }
    // Somebody the run going now plays: the window would be them, in the
    // same session (sessionInUse).
    const inUse = sessionInUse(actor);
    if (inUse) throw new Refusal(inUse, { actor, name: actor[0].toUpperCase() + actor.slice(1), suite: task?.suite ?? '' });
    return playAs(actor);
  }
  if (task) throw new Refusal('task_running');
  const held = readLock(LOCK_FILE);
  if (held) throw busyRefusal(held);
  refuseIfOutdated();
  let started;
  if (action === 'reset') started = startTask({ kind: 'reset', suite: null }, [['reset']]);
  else if (action === 'setup') {
    const s = pick();
    if (!s.setup) throw new Refusal('no_setup', { suite: s.name });
    started = startTask({ kind: 'setup', suite: s.name, docker: Boolean(docker) }, [['setup', s.name, ...inDocker]]);
  } else if (action === 'prepare') {
    // Fresh data and the suite's setup on it, nothing replayed: a suite to
    // play by hand.
    const s = pick();
    if (!s.setup) throw new Refusal('no_setup', { suite: s.name });
    started = startTask({ kind: 'setup', suite: s.name, docker: Boolean(docker) }, [['reset'], ['setup', s.name, ...inDocker]]);
  } else if (action === 'replay') {
    const s = pick();
    if (!s.recorded) throw new Refusal('no_recording', { suite: s.name });
    started = startTask({ kind: 'replay', suite: s.name, docker: Boolean(docker) }, [replayArgs(s.name)]);
  } else if (action === 'full') {
    const s = pick();
    if (!s.recorded || !s.setup) throw new Refusal(s.recorded ? 'no_setup' : 'no_recording', { suite: s.name });
    // Each round of a search starts from fresh data by itself.
    started = startTask(
      { kind: 'full', suite: s.name, docker: Boolean(docker) },
      rounds ? [replayArgs(s.name)] : [['reset'], ['setup', s.name, ...inDocker], replayArgs(s.name)],
    );
  } else throw new Refusal('unknown_action', { action });
  started.catch((e) => {
    log(`[cockpit] ${e instanceof Error ? e.message : e}`, 'error');
    task = null;
    broadcast('task', null);
  });
  return { ok: true };
}

async function handle(req, res) {
  if (!allowedHosts().has(String(req.headers.host ?? '').toLowerCase())) return send(res, 403, { error: 'Host' });
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !allowedOrigins().has(origin)) return send(res, 403, { error: 'Origin' });

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && p === '/api/state') return send(res, 200, state());
  if (req.method === 'GET' && p === '/api/log') return send(res, 200, logRing);
  // The notes on a run's photos (notes.mjs): one note at a time, and the
  // copy of a photo with its pins drawn, which the page makes.
  const notesPath = /^\/api\/runs\/([^/]+)\/(notes|pinned)\/([^/]+)$/.exec(p);
  if (notesPath && (req.method === 'PUT' || req.method === 'DELETE')) {
    const [, id, what, key] = notesPath.map(decodeURIComponent);
    const r = run && run.id === id ? run : loadRun(id);
    if (!r) return send(res, 404, { error: 'No such run' });
    if (what === 'pinned') {
      const seq = Number(key);
      if (!r.frames.some((f) => f.seq === seq)) return send(res, 404, { error: 'No such photo' });
      const file = pinnedFileOf(r.dir, seq);
      if (req.method === 'DELETE') fs.rmSync(file, { force: true });
      else {
        const buf = await readBody(req, 40 * 1024 * 1024);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
      }
      return send(res, 200, { ok: true });
    }
    const notes = readNotes(r.dir);
    const at = notes.findIndex((n) => n.id === key);
    // A tack that comes, goes or moves leaves the copy of its photo out of
    // date: it goes, and a page draws it again. A note typed on does not.
    let stale = null;
    if (req.method === 'DELETE') {
      if (at >= 0) stale = notes.splice(at, 1)[0].seq;
    } else {
      const note = cleanNote(key, await readJson(req), r.frames, notes[at]);
      if (!note) return send(res, 400, { error: 'Not a note of this run' });
      if (at < 0 || notes[at].x !== note.x || notes[at].y !== note.y) stale = note.seq;
      if (at >= 0) notes[at] = note;
      else notes.push(note);
    }
    writeNotes(r.dir, notes);
    if (stale !== null) fs.rmSync(pinnedFileOf(r.dir, stale), { force: true });
    broadcast('notes', { run: id, notes });
    return send(res, 200, { ok: true, notes });
  }
  if (req.method === 'GET' && p.startsWith('/api/runs/') && p.endsWith('/notes.md')) {
    const id = decodeURIComponent(p.slice('/api/runs/'.length, -'/notes.md'.length));
    const r = run && run.id === id ? run : loadRun(id);
    if (!r) return send(res, 404, { error: 'No such run' });
    const md = notesMarkdown({
      runId: id,
      dir: r.dir,
      frames: r.frames,
      notes: readNotes(r.dir),
      out: shown(CFG, CFG.paths.out),
      project: shown(CFG, CFG.paths.project),
    });
    return send(res, 200, md, 'text/markdown; charset=utf-8');
  }
  if (req.method === 'GET' && p.startsWith('/api/runs/') && p.endsWith('/log')) {
    const dir = inside(COCKPIT_DIR, decodeURIComponent(p.slice('/api/runs/'.length, -'/log'.length)));
    if (!dir || !fs.existsSync(path.join(dir, 'run.json'))) return send(res, 404, { error: 'No such run' });
    return send(res, 200, readRunLog(dir).slice(-LOG_LINES));
  }
  if (req.method === 'GET' && p.startsWith('/api/runs/')) {
    const id = decodeURIComponent(p.slice('/api/runs/'.length));
    const r = run && run.id === id ? run : loadRun(id);
    if (!r) return send(res, 404, { error: 'No such run' });
    return send(res, 200, {
      ...summary(r),
      frames: r.frames,
      notes: readNotes(r.dir),
      pinned: pinnedSeqs(r.dir),
      // Compared with an earlier run (changes.mjs), and the green ones it may be.
      changes: readChanges(COCKPIT_DIR, id),
      candidates: r.kind === 'play' || r.chaos ? [] : candidatesOf(COCKPIT_DIR, id).slice(0, 20),
    });
  }
  if (req.method === 'GET' && p === '/api/watch') return send(res, 200, { actors: watchedActors() });

  if (req.method === 'GET' && p.startsWith('/api/live/')) {
    const actor = p.slice('/api/live/'.length);
    if (!ACTOR.test(actor)) return send(res, 400, { error: 'actor' });
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    if (!liveClients.has(actor)) liveClients.set(actor, new Set());
    liveClients.get(actor).add(res);
    if (lastLive.has(actor)) writePart(res, lastLive.get(actor));
    broadcast('watch', { actors: watchedActors() });
    req.on('close', () => {
      liveClients.get(actor)?.delete(res);
      broadcast('watch', { actors: watchedActors() });
    });
    return;
  }

  if (req.method === 'POST' && p.startsWith('/api/live/')) {
    const actor = p.slice('/api/live/'.length);
    if (!ACTOR.test(actor)) return send(res, 400, { error: 'actor' });
    const buf = await readBody(req, 4 * 1024 * 1024);
    lastLive.set(actor, buf);
    for (const c of liveClients.get(actor) ?? []) {
      try {
        writePart(c, buf);
      } catch {
        liveClients.get(actor).delete(c);
      }
    }
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/trace') {
    const test = url.searchParams.get('test') ?? '';
    if (!run || run.closed || url.searchParams.get('run') !== run.id || !test) return send(res, 200, { ok: false });
    const buf = await readBody(req, 512 * 1024 * 1024);
    fs.mkdirSync(path.join(run.dir, 'traces'), { recursive: true });
    const name = `${String(run.testOrder.indexOf(test) + 1).padStart(2, '0')}-${test.replace(/[^\w]+/g, '-').slice(0, 60)}.zip`;
    fs.writeFileSync(path.join(run.dir, 'traces', name), buf);
    run.tests[test] = { ...(run.tests[test] ?? {}), trace: `cockpit/${run.id}/traces/${name}` };
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/frame') {
    return send(res, 200, { ok: onFrame(await readJson(req)) });
  }
  if (req.method === 'POST' && p === '/api/external/begin') {
    try {
      return send(res, 200, beginExternal(await readJson(req)));
    } catch (e) {
      return send(res, 409, { ok: false, code: e instanceof Refusal ? e.code : 'error' });
    }
  }
  if (req.method === 'POST' && p === '/api/external/log') {
    return send(res, 200, { ok: externalLines(await readJson(req)) });
  }
  if (req.method === 'POST' && p === '/api/external/end') {
    const body = await readJson(req);
    const ours = externalLines(body);
    if (ours) finishTask(body.code === 0 ? 'passed' : 'failed', body.code);
    return send(res, 200, { ok: ours });
  }
  if (req.method === 'POST' && p === '/api/changes/done') {
    const body = await readJson(req);
    if (typeof body?.run === 'string' && RUN_ID.test(body.run)) broadcast('changes', { run: body.run });
    return send(res, 200, { ok: true });
  }
  const againstPath = /^\/api\/runs\/([^/]+)\/changes$/.exec(p);
  if (againstPath && req.method === 'POST') return send(res, 200, compareAgain(decodeURIComponent(againstPath[1]), (await readJson(req))?.against));
  if (req.method === 'POST' && p === '/api/play/event') return send(res, 200, { ok: playEvents(await readJson(req)) });
  if (req.method === 'POST' && p === '/api/play/discard') return send(res, 200, playDiscard());
  if (req.method === 'POST' && p === '/api/play/report') {
    try {
      return send(res, 200, playReport(await readJson(req)));
    } catch (e) {
      return send(res, 400, { ok: false, code: e instanceof Refusal ? e.code : 'error', params: e instanceof Refusal ? e.params : {}, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (req.method === 'POST' && p === '/api/chaos/round') return send(res, 200, chaosRound(await readJson(req)));
  if (req.method === 'POST' && p === '/api/chaos/end') return send(res, 200, chaosEnd(await readJson(req)));
  if (req.method === 'POST' && p === '/api/report-event') {
    onReport(await readJson(req));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/action') {
    try {
      return send(res, 200, await onAction(await readJson(req)));
    } catch (e) {
      return send(res, 400, {
        ok: false,
        code: e instanceof Refusal ? e.code : 'error',
        params: e instanceof Refusal ? e.params : {},
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (req.method === 'GET' && p.startsWith('/out/cockpit/')) {
    return serveFile(res, inside(COCKPIT_DIR, decodeURIComponent(p.slice('/out/cockpit/'.length))), 'max-age=3600');
  }
  if (req.method === 'GET' && p.startsWith('/trace/')) {
    const rel = decodeURIComponent(p.slice('/trace/'.length)) || 'index.html';
    return serveFile(res, inside(TRACE_VIEWER_DIR, rel), 'no-cache');
  }
  if (req.method === 'GET') {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    return serveFile(res, inside(PUBLIC_DIR, rel), 'no-cache');
  }
  return send(res, 405, { error: 'Method' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  });
});

/**
 * Start the cockpit for a project.
 * @param {any} config the resolved config
 * @param {number} [port]
 */
export function startCockpit(config, port = config.cockpit.port) {
  CFG = config;
  PORT = port;
  COCKPIT_DIR = path.join(config.paths.out, 'cockpit');
  // The photos of «Play as» windows an earlier cockpit followed: nobody's
  // now (one still open writes on, and stays).
  try {
    for (const d of fs.readdirSync(path.join(COCKPIT_DIR, 'play'))) {
      const at = path.join(COCKPIT_DIR, 'play', d);
      if (Date.now() - fs.statSync(at).mtimeMs > 10 * 60_000) fs.rmSync(at, { recursive: true, force: true });
    }
  } catch {
    // None yet.
  }
  LOCK_FILE = lockFileOf(config);
  KEEP_RUNS = config.cockpit.keepRuns;
  TRACE_VIEWER_DIR = traceViewerDir(config);
  const latest = listRuns()[0];
  if (latest) run = loadRun(latest);
  if (run) logRing.push(...readRunLog(run.dir).slice(-LOG_LINES));
  checkDesktop();
  void checkStack();
  setInterval(() => {
    void checkStack();
    checkInstalled();
  }, 10_000).unref();
  setInterval(watchLock, 2_000).unref();
  setInterval(() => broadcast('heartbeat', { time: Date.now() }), 15_000).unref();
  server.listen(port, HOST, () => {
    console.log(`\n  QA Cockpit for ${config.name}: http://localhost:${port}`);
    console.log(`  (loopback only; stack «${config.stack.name}»)\n`);
  });
  return server;
}
