// The worker's side of `replay --network`: each person's requests in each
// test, saved as a HAR without its secrets (sanitize.mjs), for
// `qa-cockpit network` to read (report.mjs) and DevTools to draw. Silent
// unless the CLI set QA_NETWORK_DIR, so a replay never pays for it.
//
// In <QA_NETWORK_DIR>/<file>-<test>/ (chat-T1, chat-T2...):
//   - test.json: the test, its file and status, and each step with when it
//     began and ended, on the clock of the requests;
//   - <person>.har: their browser context's requests, from Playwright's own
//     HAR. Each entry says the step it started in (`_qaStep`, an index into
//     `log._qaCockpit.steps`; `_qaAfterStep` when it started after that
//     step had ended, as a call that waits for the user to stop typing
//     does). Its time runs to the response's last byte: Playwright's
//     leaves out the time a request waits for a connection
//     (`timings.blocked` here), which is the time requests sent at once
//     lose to each other. `log._qaCockpit.inputs` says when the person
//     pressed, typed or chose something: a call that follows was theirs.
//
// Playwright writes its raw HAR into a folder of the system's temporary
// files, read and deleted when the person's context closes: only the clean
// one is ever written to the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { testIdOf } from '../video/script.mjs';
import { machineSecrets, sanitizeHar } from './sanitize.mjs';

const DIR = process.env.QA_NETWORK_DIR || '';
export const enabled = Boolean(DIR);
const BODIES = process.env.QA_NETWORK_BODIES === '1';
// The run's key (sanitize.mjs): the CLI makes one per run and hands it to
// every worker, so a value gets the same id in every test and person. It
// lives in the environment of the run only, never on disk.
const SALT = process.env.QA_NETWORK_SALT || randomBytes(16).toString('hex');

let known = [];
let projectDir = process.cwd();

/** Tell it the project (a resolved config): its folder, and the secrets it knows. */
export function configure(config) {
  if (!enabled) return;
  projectDir = config.paths.project;
  known = machineSecrets(config);
}

/** @type {Map<string, { title: string, file: string, began: number, steps: object[], people: Record<string, object> }>} */
const tests = new Map();

function testOf(testInfo) {
  let t = tests.get(testInfo.testId);
  if (!t) {
    t = {
      title: testInfo.title,
      file: path.relative(projectDir, testInfo.file).split(path.sep).join('/'),
      began: Date.now(),
      steps: [],
      people: {},
    };
    tests.set(testInfo.testId, t);
  }
  return t;
}

const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase() || 'test';

/** «recordings/chat.spec.mjs», «T1 · …» → chat-T1 (a repeat or a retry says so). */
function testKey(testInfo) {
  const file = path.basename(testInfo.file).replace(/\.(spec|setup|test)\.[cm]?[jt]s$/, '').replace(/\.[cm]?[jt]s$/, '');
  const repeat = testInfo.repeatEachIndex ? `-repeat${testInfo.repeatEachIndex + 1}` : '';
  const retry = testInfo.retry ? `-retry${testInfo.retry}` : '';
  return `${file}-${testIdOf(testInfo.title) ?? slug(testInfo.title)}${repeat}${retry}`.replace(/[^\w.-]+/g, '_');
}

// The raw HARs' folders not yet deleted: gone with the worker, whatever
// happened to their context (a page that never opened leaves its context to
// be closed with the browser, which writes the HAR then).
const pending = new Set();
let sweeping = false;

/**
 * A person's browser context is about to open: the options that make
 * Playwright record its HAR, and what `watch` and `saved` need.
 * @param {string} id the person
 * @param {any} testInfo
 */
export function harFor(id, testInfo) {
  if (!enabled) return null;
  testOf(testInfo);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cockpit-har-'));
  pending.add(tmp);
  if (!sweeping) {
    sweeping = true;
    process.on('exit', () => {
      for (const dir of pending) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // The system cleans its temporary files.
        }
      }
    });
  }
  const raw = path.join(tmp, `${id}.har`);
  return {
    id,
    tmp,
    raw,
    finished: [],
    inputs: [],
    options: { recordHar: { path: raw, content: BODIES ? 'embed' : 'omit', mode: 'full' } },
  };
}

const keyOf = (method, url) => {
  try {
    return `${method} ${new URL(url).href}`;
  } catch {
    return `${method} ${url}`;
  }
};

// When the person pressed, typed or chose something, on the page's own
// clock (the requests' clock), kept before a test may fake it: a call that
// follows one of these was the person's doing, not the page waiting for an
// answer to ask the next thing (report.mjs). Times only, never what was
// typed.
function inputScript() {
  const now = Date.now.bind(Date);
  let last = 0;
  const tell = () => {
    const at = now();
    if (at - last < 20) return;
    last = at;
    try {
      window.__qaNetworkInput?.(at);
    } catch {
      // A time missing is a chain less sure.
    }
  };
  for (const type of ['pointerdown', 'click', 'keydown', 'input', 'change', 'submit']) addEventListener(type, tell, true);
}

/**
 * The context is open, no page yet: when each of its requests truly ended,
 * for `saved` to set the HAR's times right (see the top of this file), and
 * when the person acted.
 */
export async function watch(har, context) {
  if (!har) return;
  const done = (request) => {
    try {
      const t = request.timing();
      const start = t.startTime > 0 ? t.startTime : null;
      const end = start !== null && t.responseEnd >= 0 ? start + t.responseEnd : Date.now();
      if (har.finished.length < 50_000) har.finished.push({ key: keyOf(request.method(), request.url()), start, end });
    } catch {
      // A time missing is Playwright's own, kept.
    }
  };
  context.on('requestfinished', done);
  context.on('requestfailed', done);
  try {
    await context.exposeBinding('__qaNetworkInput', (_source, at) => {
      if (Number.isFinite(at) && har.inputs.length < 20_000) har.inputs.push(at);
    });
    await context.addInitScript(inputScript);
  } catch {
    // Without them, every call that follows another closely counts as waiting for it.
  }
}

/** A step of the recording has ended (fixtures.mjs). */
export function stepRecorded(testInfo, step) {
  if (!enabled) return;
  testOf(testInfo).steps.push(step);
}

/**
 * Each entry's time to its last byte, and the wait for a connection in
 * `blocked`. Playwright's HAR starts a request when the page asks for it,
 * and counts its time from when it left the queue: the queue is lost.
 */
function fixTimes(har, finished) {
  /** @type {Map<string, { start: number | null, end: number }[]>} */
  const pool = new Map();
  for (const f of finished) {
    if (!pool.has(f.key)) pool.set(f.key, []);
    pool.get(f.key).push(f);
  }
  for (const list of pool.values()) list.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const entries = [...(har.log?.entries ?? [])].sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  for (const e of entries) {
    const list = pool.get(keyOf(e.request?.method, e.request?.url));
    if (!list?.length) continue;
    const began = Date.parse(e.startedDateTime);
    // The same request, the first not yet taken: it leaves the queue when
    // the page asked for it or after.
    const i = list.findIndex((f) => f.start === null || f.start >= began - 2);
    if (i === -1) continue;
    const [f] = list.splice(i, 1);
    // A stream (EventSource, WebSocket) is open until the page closes: its
    // time is how long it stayed, already.
    if (e._resourceType === 'eventsource' || e._resourceType === 'websocket') continue;
    const total = Math.round(f.end - began);
    if (!(total >= 0)) continue;
    const t = (e.timings ??= {});
    // Playwright counts a TLS handshake for plain HTTP too (the time to its
    // connection's end, from a start of -1): there is none.
    if (!/^(https|wss):/i.test(e.request?.url ?? '')) t.ssl = -1;
    const phases = ['dns', 'connect', 'send', 'wait', 'receive'].reduce((sum, k) => sum + (t[k] > 0 ? t[k] : 0), 0);
    t.blocked = Math.max(0, Math.round(total - phases));
    e.time = Math.max(total, Math.round(phases));
  }
}

/** Each entry's step: the last one that began before it (or with it). */
function placeSteps(har, steps) {
  const order = steps.map((s, i) => ({ ...s, i })).sort((a, b) => a.began - b.began);
  for (const e of har.log?.entries ?? []) {
    const t = Date.parse(e.startedDateTime);
    let at = null;
    for (const s of order) {
      if (s.began <= t) at = s;
      else break;
    }
    e._qaStep = at ? at.i : null;
    if (at && t > at.ended) e._qaAfterStep = true;
  }
}

/**
 * The person's context has closed, and Playwright has written its HAR:
 * cleaned, set right and placed in its steps, it goes to the run's folder;
 * the raw one is deleted, whatever happens.
 * @param {ReturnType<typeof harFor>} har
 * @param {{ testInfo: any, device?: object | null }} where
 */
export async function saved(har, { testInfo, device = null }) {
  if (!har) return;
  try {
    const t = testOf(testInfo);
    const dir = path.join(DIR, testKey(testInfo));
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(har.raw)) {
      const log = JSON.parse(fs.readFileSync(har.raw, 'utf8'));
      fixTimes(log, har.finished);
      placeSteps(log, t.steps);
      // Before the cleaning, so that it reaches these too.
      log.log._qaCockpit = { test: t.title, file: t.file, person: har.id, device, steps: t.steps, inputs: har.inputs };
      const { secrets } = sanitizeHar(log, { salt: SALT, known, bodies: BODIES });
      fs.writeFileSync(path.join(dir, `${har.id}.har`), `${JSON.stringify(log, null, 2)}\n`);
      t.people[har.id] = { har: `${har.id}.har`, device, requests: log.log?.entries?.length ?? 0, secrets };
    }
    fs.writeFileSync(
      path.join(dir, 'test.json'),
      `${JSON.stringify(
        {
          test: t.title,
          id: testIdOf(t.title),
          file: t.file,
          status: testInfo.status,
          began: t.began,
          ended: Date.now(),
          steps: t.steps,
          people: t.people,
        },
        null,
        2,
      )}\n`,
    );
  } catch (e) {
    // A HAR missing is a look missing, never a red run.
    console.error(`qa-cockpit: the network of ${har.id} in «${testInfo.title}» was not saved (${e instanceof Error ? e.message : e}).`);
  } finally {
    discard(har);
  }
}

/** The raw HAR's folder, gone (also when the context never opened). */
export function discard(har) {
  if (!har) return;
  try {
    fs.rmSync(har.tmp, { recursive: true, force: true });
    pending.delete(har.tmp);
  } catch {
    // The system cleans its temporary files.
  }
}
