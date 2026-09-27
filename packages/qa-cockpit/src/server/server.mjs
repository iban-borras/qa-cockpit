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
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shown } from '../config.mjs';
import { acquireLock, isAlive, lockFileOf, readLock, StackBusy } from '../lock.mjs';
import { listSuites } from '../suites.mjs';
import { deviceFor, deviceLabel } from '../devices.mjs';
import { cleanNote, notesMarkdown, pinnedFileOf, pinnedSeqs, readNotes, readRunFiles, writeNotes } from '../notes.mjs';

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
    core = path.dirname(createRequire(path.join(config.paths.project, 'package.json')).resolve('playwright-core/package.json'));
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
  for (const id of listRuns().slice(KEEP_RUNS)) {
    if (noteCount(path.join(COCKPIT_DIR, id))) continue;
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
  };
}

function runsIndex() {
  return listRuns().map((id) => {
    const notes = noteCount(path.join(COCKPIT_DIR, id));
    if (run && run.id === id) return { ...summary(run), notes };
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

// Windows can start a process on a desktop the person does not see (an
// agent's terminal does). A child inherits its parent's desktop, so a small
// PowerShell child tells us ours. Linux needs a display for any window.
function checkDesktop() {
  if (process.platform === 'linux') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      desktopWarning = { code: 'no_display' };
    }
    return;
  }
  if (process.platform !== 'win32') return;
  const script = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class CkDesk {
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint t);
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int i, StringBuilder s, int n, out int need);
  public static string Name(IntPtr h) { var s = new StringBuilder(256); int n; GetUserObjectInformation(h, 2, s, 512, out n); return s.ToString(); }
}
"@
[CkDesk]::Name([CkDesk]::GetProcessWindowStation()) + '\\' + [CkDesk]::Name([CkDesk]::GetThreadDesktop([CkDesk]::GetCurrentThreadId()))`;
  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  let out = '';
  ps.stdout.on('data', (d) => (out += d));
  ps.on('close', () => {
    const where = out.trim();
    if (where && where.toLowerCase() !== 'winsta0\\default') {
      desktopWarning = { code: 'hidden_desktop', where };
      log(`[cockpit] started on a desktop nobody sees (${where}): windows will not show. Launch it from your own terminal.`, 'error');
      broadcast('desktop', { desktopWarning });
    }
  });
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
    broadcast('run', summary(run));
  }
  task = null;
  broadcast('task', null);
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

function onFrame(f) {
  if (!run || run.closed || f.run !== run.id) return false;
  const file = inside(path.join(run.dir, 'frames'), path.relative(path.join('cockpit', run.id, 'frames'), f.file ?? ''));
  if (!file || !fs.existsSync(file)) return false;
  const frame = {
    seq: run.frames.length + 1,
    actor: String(f.actor),
    test: String(f.test ?? ''),
    step: String(f.step ?? ''),
    status: String(f.status ?? ''),
    error: f.error ? String(f.error) : null,
    url: String(f.url ?? ''),
    file: path.relative(CFG.paths.out, file).split(path.sep).join('/'),
    location: f.location ? String(f.location) : null,
    viewport: f.viewport && Number.isFinite(f.viewport.width) ? { width: f.viewport.width, height: f.viewport.height } : null,
    scroll: f.scroll && Number.isFinite(f.scroll.y) ? { x: Number(f.scroll.x) || 0, y: Number(f.scroll.y) || 0 } : { x: 0, y: 0 },
    marks: (Array.isArray(f.marks) ? f.marks : []).slice(0, 50).map((m) => ({
      kind: m.kind === 'type' ? 'type' : 'click',
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
      url: String(m.url ?? ''),
      label: String(m.label ?? '').slice(0, 60),
      at: Number.isFinite(Number(m.at)) ? Number(m.at) : null,
    })),
    // The device the person played on (devices.mjs): what it is, for the card.
    device:
      f.device && typeof f.device.name === 'string'
        ? {
            name: f.device.name.slice(0, 60),
            kind: ['phone', 'tablet', 'laptop', 'desktop'].includes(f.device.kind) ? f.device.kind : 'desktop',
            width: Number(f.device.width) || null,
            height: Number(f.device.height) || null,
          }
        : null,
    requests: (Array.isArray(f.requests) ? f.requests : []).slice(0, 200).map((r) => ({
      kind: r.kind === 'page' ? 'page' : 'api',
      method: String(r.method ?? '').slice(0, 10),
      path: String(r.path ?? '').slice(0, 200),
      status: Number(r.status) || 0,
      ms: Number.isFinite(Number(r.ms)) && r.ms !== null ? Math.max(0, Math.round(Number(r.ms))) : null,
      at: Number.isFinite(Number(r.at)) ? Number(r.at) : null,
    })),
    began: f.began ? String(f.began) : null,
    ms: Number.isFinite(Number(f.ms)) && f.ms !== null ? Math.max(0, Math.round(Number(f.ms))) : null,
    time: String(f.time ?? new Date().toISOString()),
  };
  run.frames.push(frame);
  fs.appendFileSync(path.join(run.dir, 'frames.jsonl'), JSON.stringify(frame) + '\n');
  broadcast('frame', frame);
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
function playAs(actor) {
  const last = run?.frames?.findLast?.((f) => f.actor === actor && f.device)?.device;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPEN_BROWSER, actor], {
      cwd: CFG.paths.project,
      env: { ...process.env, QA_COCKPIT_CONFIG: CFG.file, FRONTEND_URL: stack.front ?? '', ...(last ? { QA_DEVICE: last.name } : {}) },
      // Hides this node's console only; the browser it starts shows itself.
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const done = (result) => {
      clearTimeout(timer);
      child.stdout.removeAllListeners('data');
      resolve(result);
    };
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
    name: CFG.name,
    project: CFG.stack.name,
    // Where the cockpit runs, and how: the page shows the command when this
    // server is gone, and a page cannot find it out by itself.
    projectDir: CFG.paths.project,
    cli: CFG.cli,
    language: CFG.cockpit.language,
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
  };
}

async function onAction(body) {
  const { action, suite, headed, docker, actor } = body;
  const known = listSuites(CFG);
  const pick = () => {
    const s = known.find((x) => x.name === suite);
    if (!s) throw new Refusal('no_suite', { suite });
    return s;
  };
  const inDocker = docker ? ['--in-docker'] : [];
  const replayArgs = (name) => ['replay', name, ...inDocker, ...(headed && !docker ? ['--headed'] : [])];
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
    return playAs(actor);
  }
  if (task) throw new Refusal('task_running');
  const held = readLock(LOCK_FILE);
  if (held) throw busyRefusal(held);
  let started;
  if (action === 'reset') started = startTask({ kind: 'reset', suite: null }, [['reset']]);
  else if (action === 'setup') {
    const s = pick();
    if (!s.setup) throw new Refusal('no_setup', { suite: s.name });
    started = startTask({ kind: 'setup', suite: s.name, docker: Boolean(docker) }, [['setup', s.name, ...inDocker]]);
  } else if (action === 'replay') {
    const s = pick();
    if (!s.recorded) throw new Refusal('no_recording', { suite: s.name });
    started = startTask({ kind: 'replay', suite: s.name, docker: Boolean(docker) }, [replayArgs(s.name)]);
  } else if (action === 'full') {
    const s = pick();
    if (!s.recorded || !s.setup) throw new Refusal(s.recorded ? 'no_setup' : 'no_recording', { suite: s.name });
    started = startTask({ kind: 'full', suite: s.name, docker: Boolean(docker) }, [
      ['reset'],
      ['setup', s.name, ...inDocker],
      replayArgs(s.name),
    ]);
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
    return send(res, 200, { ...summary(r), frames: r.frames, notes: readNotes(r.dir), pinned: pinnedSeqs(r.dir) });
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
  LOCK_FILE = lockFileOf(config);
  KEEP_RUNS = config.cockpit.keepRuns;
  TRACE_VIEWER_DIR = traceViewerDir(config);
  const latest = listRuns()[0];
  if (latest) run = loadRun(latest);
  if (run) logRing.push(...readRunLog(run.dir).slice(-LOG_LINES));
  checkDesktop();
  void checkStack();
  setInterval(() => void checkStack(), 10_000).unref();
  setInterval(watchLock, 2_000).unref();
  setInterval(() => broadcast('heartbeat', { time: Date.now() }), 15_000).unref();
  server.listen(port, HOST, () => {
    console.log(`\n  QA Cockpit for ${config.name}: http://localhost:${port}`);
    console.log(`  (loopback only; stack «${config.stack.name}»)\n`);
  });
  return server;
}
