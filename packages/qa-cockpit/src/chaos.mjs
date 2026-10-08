// Races between people (`replay --chaos N`). A recording of several people
// passes on this machine, at its own pace; on a slow phone, behind a slow
// network, the same steps may come in another order, and the app may not
// expect it: a message lost between loading the history and opening the
// live stream, a list redrawn from an answer older than what was pushed.
//
// Each round slows each person in its own way, drawn from the round's seed:
//
//   network   every request of theirs waits that long for its answer
//   pushes    what is pushed to their page (WebSocket messages, server-sent
//             events) reaches the app that late, in the order it came
//   CPU       their page runs that many times slower
//
// and starts from fresh data, like any run. A step that passes in some
// rounds and fails in others is a race, and the seed of a round it failed
// in plays that round again (`--chaos-seed`). `together()` starts several
// people's actions at once; in a round, in the order and at the offsets the
// seed says. Nothing of this costs a run without it.
import fs from 'node:fs';

const SEED = /^\d{1,9}$/.test(process.env.QA_CHAOS ?? '') ? Number(process.env.QA_CHAOS) : null;
const LOG = process.env.QA_CHAOS_LOG || null;

/** A round of `replay --chaos`: its people slowed, from its seed. */
export const enabled = SEED !== null;
/** Its steps' outcomes noted, for the rounds to be compared. */
export const logging = Boolean(LOG);

// What a round draws from, for each person. Several of each are «as it
// is», so that a round slows some people and not others: a race needs one
// person ahead of another.
const NETWORK_MS = [0, 0, 60, 150, 400, 800];
const PUSHES_MS = [0, 0, 80, 250, 600];
const CPU = [1, 1, 2, 4];
const TOGETHER_MS = [0, 0, 20, 60, 150, 300];

/** A generator of numbers in [0, 1) from a word: the same word, the same numbers. */
function random(word) {
  // FNV-1a for the word, then mulberry32.
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (next, list) => list[Math.floor(next() * list.length)];

/** How a round's seed slows one person: the same seed, the same person, the same way. */
export function profileOf(seed, person) {
  const next = random(`${seed}:${person}`);
  return { network: pick(next, NETWORK_MS), pushes: pick(next, PUSHES_MS), cpu: pick(next, CPU) };
}

/** «network +150 ms, pushes +250 ms, CPU ×2», or «as it is». */
export function profileText(p) {
  const parts = [p.network && `network +${p.network} ms`, p.pushes && `pushes +${p.pushes} ms`, p.cpu > 1 && `CPU ×${p.cpu}`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'as it is';
}

/** Seeds for a search: different, and short enough to type. */
export function pickSeeds(n) {
  const seeds = new Set();
  while (seeds.size < n) seeds.add(1 + Math.floor(Math.random() * 99_999));
  return [...seeds];
}

const note = (line) => {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify(line)}\n`);
  } catch {
    // Not compared, then: the round is no worse for it.
  }
};

/** An error in a line: Playwright's own words up to its call log, «Locator: …», «Expected: …» and all. */
function gist(error) {
  const lines = String(error?.message ?? error ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const log = lines.findIndex((l) => /^Call log:/.test(l));
  const said = (log === -1 ? lines : lines.slice(0, log)).filter((l) => !/^at /.test(l)).map((l) => l.replace(/^Error: /, ''));
  return said.slice(0, 6).join(' · ').slice(0, 300) || null;
}

/**
 * In the page: what is pushed to it reaches the app `ms` late, in the
 * order it came (a slow connection delays, it does not reorder): a
 * WebSocket's messages and close, an EventSource's events but its own
 * open and error, through listeners and `on…` handlers alike.
 */
function delayPushes(ms) {
  let last = 0;
  const later = (fn) => {
    const at = Math.max(Date.now() + ms, last);
    last = at;
    setTimeout(fn, at - Date.now());
  };
  const plain = EventTarget.prototype;
  const held = new WeakMap();
  const late = (fn) => {
    if (typeof fn !== 'function' && typeof fn?.handleEvent !== 'function') return fn;
    let w = held.get(fn);
    if (!w) {
      w = function (e) {
        later(() => (typeof fn === 'function' ? fn.call(this, e) : fn.handleEvent(e)));
      };
      held.set(fn, w);
    }
    return w;
  };
  const patch = (Kind, pushed, handlers) => {
    if (typeof Kind !== 'function') return;
    const proto = Kind.prototype;
    proto.addEventListener = function (type, fn, opts) {
      return plain.addEventListener.call(this, type, pushed(type) ? late(fn) : fn, opts);
    };
    proto.removeEventListener = function (type, fn, opts) {
      return plain.removeEventListener.call(this, type, pushed(type) ? (held.get(fn) ?? fn) : fn, opts);
    };
    for (const type of handlers) {
      const own = new WeakMap();
      Object.defineProperty(proto, `on${type}`, {
        configurable: true,
        enumerable: true,
        get() {
          return own.get(this)?.fn ?? null;
        },
        set(fn) {
          const was = own.get(this);
          if (was) plain.removeEventListener.call(this, type, was.w);
          own.delete(this);
          if (typeof fn !== 'function') return;
          const w = function (e) {
            later(() => fn.call(this, e));
          };
          own.set(this, { fn, w });
          plain.addEventListener.call(this, type, w);
        },
      });
    }
  };
  patch(window.WebSocket, (type) => type === 'message' || type === 'close', ['message', 'close']);
  patch(window.EventSource, (type) => type !== 'open' && type !== 'error', ['message']);
}

const disturbed = new Set();

/**
 * A person's page slowed the way this round's seed says, before it opens
 * anything. Network and CPU through a CDP session of its own (Chromium
 * only); the pushes in the page, in any browser. `quietly` keeps it out of
 * the trace.
 */
export async function disturb(person, page, quietly = (_, fn) => fn()) {
  if (!enabled) return;
  const p = profileOf(SEED, person);
  if (!disturbed.has(person)) {
    disturbed.add(person);
    note({ kind: 'person', person, profile: p });
  }
  if (p.pushes) await quietly(page, () => page.addInitScript(delayPushes, p.pushes));
  if (!p.network && p.cpu === 1) return;
  try {
    const cdp = await quietly(page, () => page.context().newCDPSession(page));
    if (p.network) {
      await quietly(page, () => cdp.send('Network.enable'));
      await quietly(page, () => cdp.send('Network.emulateNetworkConditions', { offline: false, latency: p.network, downloadThroughput: -1, uploadThroughput: -1 }));
    }
    if (p.cpu > 1) await quietly(page, () => cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu }));
  } catch {
    // Not Chromium: only the pushes are late.
  }
}

let togetherCalls = 0;

/**
 * Several people's actions at once, each a function:
 *
 *   await together(
 *     () => alice.getByRole('button', { name: 'Save' }).click(),
 *     () => bob.getByRole('button', { name: 'Save' }).click(),
 *   );
 *
 * All start together; in a round of `replay --chaos`, each at the offset its
 * seed says (one first, by a little or by a lot, or both at once). Every one
 * is waited for, and the first that failed fails the call.
 * @param {...(() => any) | (() => any)[]} actions
 */
export async function together(...actions) {
  const fns = actions.flat();
  if (!fns.length || fns.some((f) => typeof f !== 'function')) {
    throw new TypeError('together() takes functions, one per action: together(() => alice.click(…), () => bob.click(…))');
  }
  const next = enabled ? random(`${SEED}:together:${togetherCalls++}`) : null;
  const settled = await Promise.allSettled(
    fns.map(async (fn) => {
      const wait = next ? pick(next, TOGETHER_MS) : 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      return fn();
    }),
  );
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map((s) => s.value);
}

/** A step's end, for the rounds to be compared. */
export function stepEnded({ test, step, status, error }) {
  note({ kind: 'step', test, step, status, error: status === 'passed' ? null : gist(error) });
}

/** A test's end, its steps' or not (a fixture, a hook). */
export function testEnded(testInfo) {
  note({ kind: 'test', test: testInfo.title, status: testInfo.status, error: testInfo.status === 'passed' ? null : gist(testInfo.error) });
}

/** What a round's log says: the people slowed, its steps and its tests. */
export function readRound(file) {
  const round = { people: {}, steps: [], tests: [] };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return round;
  }
  for (const line of text.split('\n')) {
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    if (x.kind === 'person') round.people[x.person] = x.profile;
    else if (x.kind === 'step') round.steps.push({ test: x.test, step: x.step, status: x.status, error: x.error });
    else if (x.kind === 'test') round.tests.push({ test: x.test, status: x.status, error: x.error });
  }
  return round;
}

/**
 * What the rounds found, compared step by step: the steps that passed in
 * some and failed in others (races), those that failed in every round that
 * reached them, and the rounds that failed outside their steps.
 * @param {{ round: number, seed: number, status: string, run?: string | null, people: any, steps: any[], tests: any[] }[]} rounds
 */
export function foundIn(rounds) {
  const steps = new Map();
  for (const r of rounds) {
    for (const s of r.steps) {
      const key = `${s.test}\u0000${s.step}`;
      let x = steps.get(key);
      if (!x) steps.set(key, (x = { test: s.test, step: s.step, passed: [], failed: [] }));
      if (s.status === 'passed') x.passed.push(r.round);
      else x.failed.push({ round: r.round, seed: r.seed, error: s.error ?? null });
    }
  }
  const all = [...steps.values()];
  return {
    rounds: rounds.map(({ round, seed, status, run = null, people }) => ({ round, seed, status, run, people })),
    unstable: all.filter((x) => x.failed.length && x.passed.length),
    always: all.filter((x) => x.failed.length && !x.passed.length),
    outside: rounds
      .filter((r) => r.status === 'failed' && !r.steps.some((s) => s.status !== 'passed'))
      .map((r) => ({
        round: r.round,
        seed: r.seed,
        tests: r.tests.filter((t) => t.status === 'failed' || t.status === 'timedOut').map((t) => ({ test: t.test, error: t.error })),
      })),
  };
}
