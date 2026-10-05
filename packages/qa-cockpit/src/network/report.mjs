// What a look at the network found (`qa-cockpit network`), read from the
// HARs a `replay --network` left (capture.mjs), already without secrets.
//
// The timings are the QA copy's: a stack on this machine, with its own
// small data and no distance to the server. A call that takes 5 ms here may
// take 150 in production, and one that takes 900 here may be the copy's
// doing. So what does not depend on the machine comes first: how many calls
// a step makes, which wait for another, which repeat, how much they bring.
// The milliseconds are a hint; a before and after on the same machine
// (`--against`) is a measure.
import fs from 'node:fs';
import path from 'node:path';

// A call that starts this soon after another one ended most likely waited
// for it: the page read the answer, then asked the next thing.
const CHAIN_GAP = 150;
// Waiting this long for the server is slow, even on a laptop.
const SLOW = 300;
// A response this big is heavy for one call.
const HEAVY = 250 * 1024;
// The same call for this many items in one step: one call per item.
const PER_ITEM = 4;
// The same call at least this many times in a test, at a steady pace: a timer.
const TIMER_CALLS = 4;
// Findings of a kind listed before «and N more».
const LISTED = 8;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every look at the network in <out>/network, the newest first. */
export function networkRuns(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => ({ id, dir: path.join(root, id), meta: readJson(path.join(root, id, 'run.json')) }))
    .filter((r) => r.meta)
    .sort((a, b) => String(b.meta.startedAt ?? '').localeCompare(String(a.meta.startedAt ?? '')));
}

/**
 * A run by its id, or the newest of a suite (or of all), older than `before` when given.
 * @param {ReturnType<typeof networkRuns>} runs
 * @param {string | null} name
 * @param {{ before?: { meta: { startedAt?: string } } | null }} [options]
 */
export function findRun(runs, name, { before = null } = {}) {
  const older = before ? runs.filter((r) => String(r.meta.startedAt ?? '') < String(before.meta.startedAt ?? '')) : runs;
  if (!name) return older[0] ?? null;
  return older.find((r) => r.id === name) ?? older.find((r) => r.meta.suite === name) ?? null;
}

/** A run's tests, each with its steps and its people's HARs, in the order they ran. */
export function readRun(run) {
  const tests = [];
  for (const key of fs.readdirSync(run.dir)) {
    const dir = path.join(run.dir, key);
    const meta = readJson(path.join(dir, 'test.json'));
    if (!meta) continue;
    const hars = {};
    for (const [person, p] of Object.entries(meta.people ?? {})) {
      const har = readJson(path.join(dir, p?.har ?? `${person}.har`));
      if (har?.log) hars[person] = har;
    }
    tests.push({ key, dir, meta, hars });
  }
  tests.sort((a, b) => (a.meta.began ?? 0) - (b.meta.began ?? 0));
  return { ...run, tests };
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// A segment or a value that names one item: a number, a UUID, a long hex,
// a long id with a digit in it (a placeholder for a secret is one too).
const ID = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=[^/]*\d)[\w-]{16,})$/i;

/** /api/contacts/123/enrich?fair=9 → /api/contacts/{id}/enrich?fair={id} */
export function template(p) {
  const [pathname, query] = String(p).split('?');
  const segments = pathname
    .split('/')
    .map((s) => (ID.test(decode(s)) ? '{id}' : s))
    .join('/');
  if (!query) return segments;
  const pairs = query.split('&').map((pair) => {
    const i = pair.indexOf('=');
    const value = i === -1 ? '' : decode(pair.slice(i + 1));
    return i !== -1 && (ID.test(value) || /^\d+(,\d+)*$/.test(value)) ? `${pair.slice(0, i)}={id}` : pair;
  });
  return `${segments}?${pairs.join('&')}`;
}

function callOf(e, person, own) {
  const type = e._resourceType ?? 'other';
  const kind =
    type === 'fetch' || type === 'xhr'
      ? 'api'
      : type === 'document'
        ? 'page'
        : type === 'eventsource' || type === 'websocket'
          ? 'stream'
          : 'asset';
  let url = null;
  try {
    url = new URL(e.request.url);
  } catch {
    // Kept as it came.
  }
  const start = Date.parse(e.startedDateTime);
  const time = Number.isFinite(e.time) && e.time >= 0 ? Math.round(e.time) : null;
  const res = e.response ?? {};
  const header = (name) => (res.headers ?? []).find((h) => String(h.name).toLowerCase() === name)?.value;
  return {
    person,
    kind,
    type,
    method: e.request.method,
    origin: url?.origin ?? '',
    path: url ? url.pathname + url.search : String(e.request.url),
    own: url ? own.has(url.origin) : true,
    status: Number.isFinite(res.status) ? res.status : -1,
    failure: res._failureText ?? null,
    aborted: Boolean(e._wasAborted) || /ERR_ABORTED/.test(res._failureText ?? ''),
    start,
    time,
    end: start + (time ?? 0),
    wait: Number.isFinite(e.timings?.wait) && e.timings.wait >= 0 ? Math.round(e.timings.wait) : null,
    size: Number.isFinite(res.content?.size) && res.content.size >= 0 ? res.content.size : null,
    transfer: Number.isFinite(res._transferSize) && res._transferSize >= 0 ? res._transferSize : null,
    compressed: Boolean(header('content-encoding')),
    step: Number.isInteger(e._qaStep) ? e._qaStep : null,
    after: Boolean(e._qaAfterStep),
    timer: false,
  };
}

/** What a finding or a row says of a call. */
function brief(c) {
  return { method: c.method, origin: c.origin, path: c.path, own: c.own, status: c.status, failure: c.failure, ms: c.time, wait: c.wait, size: c.size };
}

function groupBy(list, key) {
  const groups = new Map();
  for (const item of list) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const spanOf = (calls) => (calls.length ? Math.max(...calls.map((c) => c.end)) - Math.min(...calls.map((c) => c.start)) : 0);

/** Calls on a timer (a poll, a heartbeat): the same call at a steady pace through the test. */
function timersOf(calls) {
  const timers = [];
  for (const list of groupBy(
    calls.filter((c) => c.kind === 'api'),
    (c) => `${c.person} ${c.method} ${c.origin}${c.path}`,
  ).values()) {
    if (list.length < TIMER_CALLS) continue;
    const starts = list.map((c) => c.start).sort((a, b) => a - b);
    const gaps = starts.slice(1).map((s, i) => s - starts[i]);
    const every = median(gaps);
    if (every < 400) continue;
    const steady = gaps.filter((g) => g >= every * 0.6 && g <= every * 1.6).length;
    if (steady < gaps.length * 0.75) continue;
    for (const c of list) c.timer = true;
    timers.push({ person: list[0].person, call: brief(list[0]), every: Math.round(every), count: list.length });
  }
  return timers;
}

/** How many calls were in flight at once, at most. */
function peakOf(calls) {
  const events = calls.flatMap((c) => [
    [c.start, 1],
    [c.end, -1],
  ]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, d] of events) {
    now += d;
    peak = Math.max(peak, now);
  }
  return peak;
}

/**
 * The longest run of calls where each began as the one before ended. A call
 * the person caused (they pressed or typed between the two: `inputs`) does
 * not wait for the one before: it starts a run of its own.
 */
function chainOf(list, inputs = []) {
  const calls = [...list].sort((a, b) => a.start - b.start);
  const best = calls.map(() => ({ n: 1, prev: -1 }));
  const acted = (from, to) => inputs.some((t) => t > from && t <= to);
  for (let i = 0; i < calls.length; i++) {
    for (let j = 0; j < i; j++) {
      const gap = calls[i].start - calls[j].end;
      if (gap < -2 || gap > CHAIN_GAP || best[j].n + 1 <= best[i].n) continue;
      if (!acted(calls[j].end - 2, calls[i].start)) best[i] = { n: best[j].n + 1, prev: j };
    }
  }
  let last = -1;
  for (let i = 0; i < calls.length; i++) if (last === -1 || best[i].n > best[last].n) last = i;
  if (last === -1 || best[last].n < 2) return null;
  const chain = [];
  for (let k = last; k !== -1; k = best[k].prev) chain.unshift(calls[k]);
  return { calls: chain, ms: chain.at(-1).end - chain[0].start, longest: Math.max(...chain.map((c) => c.time ?? 0)) };
}

/** Every chain of a step, the longest first: a step may hold several, apart. */
function chainsOf(list, inputs) {
  const chains = [];
  let left = list;
  for (;;) {
    const chain = chainOf(left, inputs);
    if (!chain) return chains;
    chains.push(chain);
    left = left.filter((c) => !chain.calls.includes(c));
  }
}

const failed = (c) => c.status >= 400 || (c.status === 0 && Boolean(c.failure) && !c.aborted);

function rowOf(step, person, mine, inputs) {
  const api = mine.filter((c) => c.kind === 'api' && !c.timer);
  const timed = api.filter((c) => c.time !== null);
  const safe = api.filter((c) => c.method === 'GET' || c.method === 'HEAD');
  const repeats = [...groupBy(safe, (c) => `${c.method} ${c.origin}${c.path}`).values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({ call: brief(g[0]), count: g.length }));
  const perItem = [...groupBy(safe, (c) => `${c.method} ${c.origin}${template(c.path)}`).values()]
    .filter((g) => new Set(g.map((c) => c.path)).size >= PER_ITEM)
    .map((g) => ({ call: { ...brief(g[0]), path: template(g[0].path) }, count: g.length, ms: spanOf(g), atOnce: peakOf(g.filter((c) => c.time !== null)) }));
  // Between the app's own answered calls: another site's (analytics, maps,
  // fonts) go out on their own, and would only make chains by chance; a call
  // cut short or never answered waited for nothing.
  const chains = chainsOf(timed.filter((c) => c.own && c.status > 0), inputs);
  return {
    step,
    person,
    calls: api.length,
    others: api.filter((c) => !c.own).length,
    late: api.filter((c) => c.after).length,
    pages: mine.filter((c) => c.kind === 'page').map(brief),
    assets: mine.filter((c) => c.kind === 'asset').length,
    span: spanOf(timed),
    peak: peakOf(timed),
    chain: chains[0] ?? null,
    chains,
    repeats,
    perItem,
    errors: mine.filter((c) => (c.kind === 'api' || c.kind === 'page') && failed(c)).map(brief),
    slow: timed.filter((c) => (c.wait ?? 0) >= SLOW).sort((a, b) => b.wait - a.wait).map(brief),
    heavy: api.filter((c) => (c.size ?? 0) >= HEAVY).sort((a, b) => b.size - a.size).map(brief),
    bytes: sum(api.map((c) => c.size ?? 0)),
    transfer: sum(mine.map((c) => c.transfer ?? 0)),
  };
}

/** The app's own origins: the stack's, or the pages' when the run does not say. */
function ownOrigins(run) {
  const own = new Set();
  for (const u of Object.values(run.meta.urls ?? {})) {
    try {
      own.add(new URL(u).origin);
    } catch {
      // Not a URL.
    }
  }
  if (!own.size) {
    for (const t of run.tests) {
      for (const har of Object.values(t.hars)) {
        for (const e of har.log.entries ?? []) {
          if (e._resourceType !== 'document') continue;
          try {
            own.add(new URL(e.request.url).origin);
          } catch {
            // Not a URL.
          }
        }
      }
    }
  }
  return own;
}

function analyseTest(t, own) {
  const steps = (t.meta.steps ?? []).map((s) => s.title);
  const people = Object.keys(t.hars);
  const calls = [];
  for (const [person, har] of Object.entries(t.hars)) for (const e of har.log.entries ?? []) calls.push(callOf(e, person, own));
  const inputs = Object.fromEntries(
    Object.entries(t.hars).map(([person, har]) => [person, (har.log._qaCockpit?.inputs ?? []).filter(Number.isFinite).sort((a, b) => a - b)]),
  );
  const timers = timersOf(calls);
  const streams = [...groupBy(calls.filter((c) => c.kind === 'stream'), (c) => `${c.person} ${c.origin}${c.path}`).values()].map((g) => ({
    person: g[0].person,
    call: brief(g[0]),
    opened: g.length,
  }));
  const rows = [];
  for (const step of [null, ...steps.keys()]) {
    for (const person of people) {
      const mine = calls.filter((c) => c.person === person && c.step === step);
      if (mine.length) rows.push(rowOf(step, person, mine, inputs[person]));
    }
  }
  const plain = calls.filter((c) => c.kind === 'api' && c.own && !c.compressed && (c.size ?? 0) >= 2048 && c.status >= 200 && c.status < 300);
  const id = t.meta.id ?? t.key;
  const findings = [];
  for (const row of rows) {
    const at = { test: t.key, id, step: row.step, stepTitle: row.step === null ? null : steps[row.step], person: row.person };
    for (const chain of row.chains) {
      findings.push({ kind: 'chain', ...at, count: chain.calls.length, ms: chain.ms, longest: chain.longest, calls: chain.calls.map(brief) });
    }
    for (const p of row.perItem) findings.push({ kind: 'perItem', ...at, count: p.count, ms: p.ms, atOnce: p.atOnce, call: p.call });
    for (const r of row.repeats) findings.push({ kind: 'repeat', ...at, count: r.count, call: r.call });
    for (const c of row.slow) findings.push({ kind: 'slow', ...at, ms: c.wait, call: c });
    for (const c of row.heavy) findings.push({ kind: 'heavy', ...at, bytes: c.size, call: c });
    for (const c of row.errors) findings.push({ kind: 'error', ...at, call: c });
  }
  for (const s of streams) {
    if (s.opened >= 3) findings.push({ kind: 'reopened', test: t.key, id, step: null, stepTitle: null, person: s.person, count: s.opened, call: s.call });
  }
  for (const timer of timers) {
    findings.push({ kind: 'timer', test: t.key, id, step: null, stepTitle: null, person: timer.person, count: timer.count, every: timer.every, call: timer.call });
  }
  return {
    key: t.key,
    id,
    title: t.meta.test,
    status: t.meta.status ?? null,
    steps,
    people,
    rows,
    timers,
    streams,
    uncompressed: { count: plain.length, bytes: sum(plain.map((c) => c.size ?? 0)) },
    findings,
  };
}

const ORDER = ['chain', 'perItem', 'repeat', 'slow', 'heavy', 'error', 'reopened', 'timer'];
const weight = (f) => (f.kind === 'chain' ? f.count * 1e6 + f.ms : f.kind === 'heavy' ? f.bytes : f.kind === 'slow' ? f.ms : (f.count ?? 0));

/**
 * What a run's HARs say, test by test and step by step.
 * @param {ReturnType<typeof readRun>} run
 * @param {{ test?: string | null }} [options] only the test with this id or key
 */
export function analyse(run, { test = null } = {}) {
  const own = ownOrigins(run);
  const tests = run.tests.filter((t) => !test || t.meta.id === test || t.key === test).map((t) => analyseTest(t, own));
  // The run's order, for the places of a pattern.
  tests.forEach((t, i) => {
    for (const f of t.findings) f.order = i * 10_000 + (f.step ?? -1);
  });
  const findings = tests
    .flatMap((t) => t.findings)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || weight(b) - weight(a));
  return {
    id: run.id,
    dir: run.dir,
    meta: run.meta,
    tests,
    findings,
    uncompressed: { count: sum(tests.map((t) => t.uncompressed.count)), bytes: sum(tests.map((t) => t.uncompressed.bytes)) },
  };
}

// ── how it reads ──

const ms = (n) => (n === null || n === undefined ? '–' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${Math.round(n)} ms`);
const bytes = (n) =>
  n === null || n === undefined ? '–' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)} kB` : `${n} B`;
const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const cell = (s) => String(s).replace(/\|/g, '\\|');
/** «4–7 ms», «1.2 s–3.0 s», «×4–×12»: the values of several places. */
const range = (values, f) => {
  const xs = values.filter((v) => v !== null && v !== undefined);
  if (!xs.length) return f(null);
  const lo = f(Math.min(...xs));
  const hi = f(Math.max(...xs));
  if (lo === hi) return hi;
  const unit = / [a-zA-Z]+$/.exec(hi)?.[0];
  return unit && lo.endsWith(unit) ? `${lo.slice(0, -unit.length)}–${hi}` : `${lo}–${hi}`;
};

/** «GET /api/me», or the whole address for another site's. */
const said = (c) => `${c.method} ${cut(c.own ? c.path : `${c.origin}${c.path}`, 110)}`;
/** The same, with its ids as {id}: how calls of several places read as one. */
const saidAsOne = (c) => said({ ...c, path: template(c.path) });

/** A chain, its runs of the same call for several items said once: «GET /api/contacts/{id} ×12». */
function chainSaid(calls, asOne) {
  const parts = [];
  for (const c of calls) {
    const key = callKey(c);
    if (parts.at(-1)?.key === key) parts.at(-1).n += 1;
    else parts.push({ key, c, n: 1 });
  }
  return parts.map((p) => (p.n > 1 ? `${saidAsOne(p.c)} ×${p.n}` : (asOne ? saidAsOne : said)(p.c))).join(' → ');
}

/** Where a finding was: the test, the step, the person. */
function place(f) {
  if (f.step === null) return `${f.id}${f.kind === 'timer' || f.kind === 'reopened' ? '' : ' · before the steps'} (${f.person})`;
  return `${f.id} · ${cut(f.stepTitle ?? `step ${f.step + 1}`, 60)} (${f.person})`;
}

function places(list, shown = 3) {
  const all = list.map(place);
  return all.length <= shown ? all.join('; ') : `${all.slice(0, shown).join('; ')}; and ${all.length - shown} more`;
}

// What makes two findings one: the same kind on the same calls, ids aside.
const callKey = (c) => `${c.method} ${c.own ? '' : c.origin}${template(c.path)}`;
function patternOf(f) {
  if (f.kind === 'chain') return `chain|${f.calls.map(callKey).join('>')}`;
  if (f.kind === 'error') return `error|${callKey(f.call)}|${f.call.status > 0 ? f.call.status : f.call.failure}`;
  return `${f.kind}|${callKey(f.call)}`;
}

/** Findings of one kind on the same calls, together, the most frequent first; each in the run's order. */
function patterns(findings) {
  const groups = [...groupBy(findings, patternOf).values()];
  for (const g of groups) g.sort((a, b) => a.order - b.order);
  return groups.sort(
    (a, b) => ORDER.indexOf(a[0].kind) - ORDER.indexOf(b[0].kind) || b.length - a.length || Math.max(...b.map(weight)) - Math.max(...a.map(weight)),
  );
}

const KINDS = {
  chain: {
    title: 'One call after another',
    why: 'Each began right after the one before had ended, with nothing done by the person in between: most likely the page waited for an answer to ask the next thing. Asked together (or answered by one call), they would cost one round trip instead of several: here a few milliseconds, in production one network latency each.',
    line: (list) =>
      `${chainSaid(list[0].calls, list.length > 1)}: ${list[0].count} calls, ${range(list.map((f) => f.ms), ms)} here (the longest alone ${range(list.map((f) => f.longest), ms)}). In ${places(list)}.`,
  },
  perItem: {
    title: 'One call per item',
    why: 'The same call for many items in one step (a list asking for each of its rows): one call for all of them would do.',
    line: (list) => {
      const together = Math.max(...list.map((f) => f.atOnce ?? 1));
      return `${saidAsOne(list[0].call)} ×${range(list.map((f) => f.count), String)} in one step, ${together > 1 ? `up to ${together} at once` : 'one after another'} (${range(list.map((f) => f.ms), ms)} from the first to the last). In ${places(list)}.`;
    },
  },
  repeat: {
    title: 'The same call again',
    why: 'The very same request more than once in one step: the page already had the answer.',
    line: (list) => `${(list.length === 1 ? said : saidAsOne)(list[0].call)} ×${range(list.map((f) => f.count), String)} in one step. In ${places(list)}.`,
  },
  slow: {
    title: `Slow on the server (${ms(SLOW)} or more waiting for it)`,
    why: 'The time between sending the request and its first byte back, from a server with this copy’s small data: in production it is as slow, or slower.',
    line: (list) => `${(list.length === 1 ? said : saidAsOne)(list[0].call)} waited ${range(list.map((f) => f.ms), ms)}. In ${places(list)}.`,
  },
  heavy: {
    title: `Heavy responses (${bytes(HEAVY)} or more)`,
    why: 'Does the page show all of it? A response trimmed to what the screen uses, or paged, is lighter on every phone.',
    line: (list) => `${(list.length === 1 ? said : saidAsOne)(list[0].call)} brought ${range(list.map((f) => f.bytes), bytes)}. In ${places(list)}.`,
  },
  error: {
    title: 'Errors',
    why: 'Calls the server refused, or that failed: a red the screen may hide.',
    line: (list) => {
      const c = list[0].call;
      return `${(list.length === 1 ? said : saidAsOne)(c)} → ${c.status > 0 ? c.status : (c.failure ?? 'failed')}${list.length > 1 ? ` ×${list.length}` : ''}. In ${places(list)}.`;
    },
  },
  reopened: {
    title: 'Streams opened again and again',
    why: 'A live stream (EventSource, WebSocket) that closes and opens again: each time, the page may miss what happened meanwhile.',
    line: (list) => `${said(list[0].call)} opened ${range(list.map((f) => f.count), String)} times in a test. In ${places(list)}.`,
  },
  timer: {
    title: 'On a timer (left out of the steps)',
    why: 'The same call at a steady pace, whatever the person does: a poll or a heartbeat. Each costs the server, for every person who has the page open.',
    line: (list) => `${said(list[0].call)} every ${range(list.map((f) => f.every), ms)}. In ${list.map((f) => `${place(f)} ×${f.count}`).join('; ')}.`,
  },
};

const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function findingsText(findings, uncompressed) {
  const out = ['## Findings', ''];
  const groups = patterns(findings);
  for (const kind of ORDER) {
    const mine = groups.filter((g) => g[0].kind === kind);
    if (!mine.length) continue;
    const count = sum(mine.map((g) => g.length));
    out.push(`### ${KINDS[kind].title} (${noun(mine.length, 'pattern', 'patterns')}, ${noun(count, 'place', 'places')})`, '', KINDS[kind].why, '');
    for (const g of mine.slice(0, LISTED)) out.push(`- ${KINDS[kind].line(g)}`);
    if (mine.length > LISTED) out.push(`- and ${mine.length - LISTED} more (\`--json\` lists them all)`);
    out.push('');
  }
  if (uncompressed.count) {
    out.push(
      '### Not compressed in this copy',
      '',
      `${noun(uncompressed.count, 'response', 'responses')} of the app over 2 kB came without compression (${bytes(uncompressed.bytes)}). A copy's server often leaves it out where production's proxy adds it: check production before calling it a finding.`,
      '',
    );
  }
  if (!groups.length && !uncompressed.count) {
    out.push('Nothing stands out: no calls one after another, repeated or per item, none slow, heavy or failed.', '');
  }
  return out;
}

function rowsText(t) {
  const out = [`### ${t.id} · ${cut(String(t.title).replace(/^[A-Z]{1,2}\d+[a-z]?\s+·\s+/, ''), 90)}${t.status ? ` (${t.status})` : ''}`, ''];
  if (!t.rows.length) return [...out, 'No requests.', ''];
  out.push('| Step | Who | Calls | One after another | At once | Network | Brought | Also |', '|---|---|---|---|---|---|---|---|');
  for (const r of t.rows) {
    const also = [
      ...r.pages.map((p) => `page ${said(p)} ${ms(p.ms)}`),
      r.others ? `${r.others} to other sites` : '',
      r.late ? `${r.late} after the step ended` : '',
      r.errors.length ? `${r.errors.length} failed` : '',
    ].filter(Boolean);
    const step = r.step === null ? 'before the steps' : cut(t.steps[r.step] ?? `step ${r.step + 1}`, 60);
    out.push(
      `| ${cell(step)} | ${r.person} | ${r.calls} | ${r.chain ? r.chain.calls.length : ''} | ${r.calls ? r.peak : ''} | ${r.calls ? ms(r.span) : ''} | ${r.calls ? bytes(r.bytes) : ''} | ${cell(also.join('; '))} |`,
    );
  }
  out.push('');
  const streams = [...groupBy(t.streams, (s) => said(s.call)).entries()].map(
    ([call, list]) => `${call} (${list.map((s) => `${s.person}${s.opened > 1 ? ` ×${s.opened}` : ''}`).join(', ')})`,
  );
  if (streams.length) out.push(`Streams: ${streams.join('; ')}.`, '');
  if (t.timers.length) out.push(`On a timer, left out of the rows: ${t.timers.map((x) => `${said(x.call)} every ${ms(x.every)} (${x.person})`).join('; ')}.`, '');
  return out;
}

function summaryOf(a) {
  const m = a.meta;
  const people = [...new Set(a.tests.flatMap((t) => t.people))];
  return `\`${m.command ?? 'replay'}\`, ${m.status ?? 'running or stopped'}, started ${String(m.startedAt ?? '').replace('T', ' ').slice(0, 16)}; ${noun(a.tests.length, 'test', 'tests')}${people.length ? `, ${people.join(', ')}` : ''}${m.bodies ? '; with the responses’ text' : ''}`;
}

/**
 * The report of one run, for an agent (Markdown).
 * @param {ReturnType<typeof analyse>} a
 * @param {{ shown: (abs: string) => string, cli: string }} how
 */
export function reportText(a, { shown, cli }) {
  const out = [`# The network of ${a.meta.suite}: ${a.id}`, ''];
  out.push(`- ${summaryOf(a)}`);
  out.push(`- Its HARs, without their secrets: \`${shown(a.dir)}/<test>/<person>.har\` (DevTools draws one: Network, Import HAR)`);
  out.push('- The timings are this copy’s (its stack on this machine, its data): trust the counts, the chains, the repeats and the sizes; read the milliseconds as a hint.');
  out.push(`- A change is measured against this run: \`replay ${a.meta.suite} --network\` again, then \`${cli} network --against previous\`.`);
  if (a.meta.cockpit) out.push('- The cockpit followed this run: its traces and photos slow it a little. Compare runs made the same way.');
  out.push('');
  if (!a.tests.length) return [...out, 'No HAR in this run: its tests did not get to open a browser.', ''].join('\n');
  out.push(...findingsText(a.findings, a.uncompressed));
  out.push('## Step by step', '', '«One after another»: the step\'s longest chain. «Network»: from the first call of the step to the end of its last. «Brought»: what its calls brought.', '');
  for (const t of a.tests) out.push(...rowsText(t));
  return out.join('\n');
}

// ── a run against an earlier one ──

const findingKey = (f) => `${patternOf(f)}|${f.test}|${f.step}|${f.person}`;

/**
 * What changed from one run to another: the steps whose calls changed, and
 * the findings gone and new.
 * @param {ReturnType<typeof analyse>} now
 * @param {ReturnType<typeof analyse>} before
 * @param {{ shown: (abs: string) => string }} how
 */
export function compareText(now, before, { shown }) {
  const out = [`# The network of ${now.meta.suite}: ${now.id}, against ${before.id}`, ''];
  out.push(`- Now: ${summaryOf(now)}`, `- Before: ${summaryOf(before)}`);
  if (Boolean(now.meta.cockpit) !== Boolean(before.meta.cockpit)) {
    out.push('- The cockpit followed one of them and not the other: its traces slow a run a little, so their milliseconds compare less well.');
  }
  out.push(`- Their HARs: \`${shown(now.dir)}\`, \`${shown(before.dir)}\``, '');

  const rowsBefore = new Map();
  for (const t of before.tests) for (const r of t.rows) rowsBefore.set(`${t.key}|${r.step}|${r.person}`, { t, r });
  const changed = [];
  const seen = new Set();
  const arrow = (a, b, f = (x) => x) => (f(a) === f(b) ? `${f(b)}` : `${f(a)} → ${f(b)}`);
  const label = (t, r) => `${t.id} · ${r.step === null ? 'before the steps' : cut(t.steps[r.step] ?? `step ${r.step + 1}`, 50)}`;
  for (const t of now.tests) {
    for (const r of t.rows) {
      const key = `${t.key}|${r.step}|${r.person}`;
      seen.add(key);
      const b = rowsBefore.get(key)?.r ?? { calls: 0, chain: null, peak: 0, span: 0, bytes: 0 };
      const chainBefore = b.chain ? b.chain.calls.length : 0;
      const chainNow = r.chain ? r.chain.calls.length : 0;
      const moved =
        b.calls !== r.calls ||
        chainBefore !== chainNow ||
        b.peak !== r.peak ||
        (Math.abs(r.bytes - b.bytes) > 1024 && Math.abs(r.bytes - b.bytes) > 0.1 * Math.max(r.bytes, b.bytes)) ||
        (Math.abs(r.span - b.span) >= 20 && Math.abs(r.span - b.span) > 0.25 * Math.max(r.span, b.span));
      if (!moved) continue;
      changed.push(
        `| ${cell(label(t, r))} | ${r.person} | ${arrow(b.calls, r.calls)} | ${arrow(chainBefore || '–', chainNow || '–')} | ${arrow(b.peak, r.peak)} | ${arrow(b.span, r.span, ms)} | ${arrow(b.bytes, r.bytes, bytes)} |`,
      );
    }
  }
  for (const [key, { t, r }] of rowsBefore) {
    if (seen.has(key)) continue;
    changed.push(`| ${cell(label(t, r))} | ${r.person} | ${r.calls} → 0 | ${r.chain ? r.chain.calls.length : '–'} → – | ${r.peak} → 0 | ${ms(r.span)} → – | ${bytes(r.bytes)} → 0 |`);
  }
  out.push('## Steps whose calls changed', '');
  if (changed.length) {
    out.push('| Test · step | Who | Calls | One after another | At once | Network | Brought |', '|---|---|---|---|---|---|---|', ...changed, '');
  } else {
    out.push('None: the same calls, and the milliseconds within their noise.', '');
  }

  const keysBefore = new Map(before.findings.map((f) => [findingKey(f), f]));
  const keysNow = new Map(now.findings.map((f) => [findingKey(f), f]));
  const gone = [...keysBefore].filter(([k]) => !keysNow.has(k)).map(([, f]) => f);
  const added = [...keysNow].filter(([k]) => !keysBefore.has(k)).map(([, f]) => f);
  const listed = (list) => patterns(list).map((g) => `- ${KINDS[g[0].kind].title}: ${KINDS[g[0].kind].line(g)}`);
  out.push(`## Findings gone (${gone.length})`, '', ...(gone.length ? listed(gone) : ['None.']), '');
  out.push(`## Findings new (${added.length})`, '', ...(added.length ? listed(added) : ['None.']), '');
  out.push(`${noun(now.findings.length - added.length, 'finding is', 'findings are')} in both: \`network ${now.id}\` lists them.`, '');
  return out.join('\n');
}

/** What `--json` prints: the analysis, every finding on its own. */
export function reportJson(a) {
  return { id: a.id, dir: a.dir, meta: a.meta, findings: a.findings, uncompressed: a.uncompressed, tests: a.tests.map(({ findings, ...t }) => t) };
}
