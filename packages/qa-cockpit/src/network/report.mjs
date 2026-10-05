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
//
// A copy whose front is a development server (Vite, webpack, Next) shows
// some of its own: hundreds of modules arriving one by one, the components
// that mount when theirs arrive asking the server in waves, and React's
// StrictMode, in development only, asking for everything twice at once.
// What it does is told apart, never counted as the app's (found in
// CritKeep: most of a first report was that).
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
// The same call at least this many times in one page, at a steady pace: a timer.
const TIMER_CALLS = 4;
// Calls of one address this close together were asked at the same moment:
// two parts of the page asking without sharing, or StrictMode's double.
const AT_ONCE = 60;
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PLACEHOLDER = /REDACTED-[0-9a-f]{8}/g;
// A segment or a value that names one item: a number, a long hex, a long id
// with a digit in it.
const ID = /^(\d+|[0-9a-f]{12,}|(?=[^/]*\d)[\w-]{16,})$/i;
// A query parameter that names items: «id», «user_id», «fairId», «ids».
const ID_NAME = /(^|[_-])ids?$|[a-z]Ids?$/;

/**
 * An address with its items as {id}, so that the same call for another item
 * reads the same: /api/contacts/{id}/enrich?fair_id={id}&per_page=6. A
 * UUID or a secret's placeholder anywhere in it, a number in a path, a
 * number in a parameter that names an item; a number of another parameter
 * (per_page=6) stays what it is.
 */
export function template(p) {
  const [pathname, query] = String(p).split('?');
  const items = (s) => s.replace(UUID, '{id}').replace(PLACEHOLDER, '{id}');
  const segments = pathname
    .split('/')
    .map((s) => {
      const d = items(decode(s));
      return ID.test(d) ? '{id}' : d;
    })
    .join('/');
  if (query === undefined) return segments;
  const pairs = query.split('&').map((pair) => {
    const i = pair.indexOf('=');
    if (i === -1) return decode(pair);
    const name = decode(pair.slice(0, i));
    const value = items(decode(pair.slice(i + 1)));
    const item = /^\d+(,\d+)*$/.test(value) ? ID_NAME.test(name) : ID.test(value);
    return `${name}=${item ? '{id}' : value}`;
  });
  return `${segments}?${pairs.join('&')}`;
}

const headerOf = (list, name) => (list ?? []).find((h) => String(h.name).toLowerCase() === name)?.value;

/** The development server a run's front was served by, if it was one. */
function devServerOf(entries) {
  for (const e of entries) {
    const url = String(e.request?.url ?? '');
    if (/\/@vite\/client|\/@react-refresh/.test(url) || String(headerOf(e.request?.headers, 'sec-websocket-protocol') ?? '').includes('vite-hmr')) return 'Vite';
    if (/\/_next\/webpack-hmr|\/_next\/static\/development\//.test(url)) return 'Next.js';
    if (/\/__webpack_hmr|\/webpack-dev-server|\/sockjs-node\//.test(url)) return 'webpack';
  }
  return null;
}

/** A development server's own stream, that reloads the page when its code changes. */
const hotReload = (e) =>
  String(headerOf(e.request?.headers, 'sec-websocket-protocol') ?? '').includes('vite-hmr') ||
  /\/__webpack_hmr|\/_next\/webpack-hmr|\/sockjs-node\//.test(String(e.request?.url ?? ''));

/** The code of an error, from its body when the run kept it: «ACCOUNT_PAUSED». */
function reasonOf(res) {
  if (!res.content?.text || !(res.status >= 400)) return null;
  try {
    const body = JSON.parse(res.content.text);
    const said = [body?.code, body?.error_code, body?.error, body?.type].find((v) => typeof v === 'string' && v && v.length <= 60);
    return said ?? null;
  } catch {
    return null;
  }
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
          : type === 'script' || type === 'stylesheet'
            ? 'code'
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
    reason: reasonOf(res),
    aborted: Boolean(e._wasAborted) || /ERR_ABORTED/.test(res._failureText ?? ''),
    hotReload: kind === 'stream' && hotReload(e),
    start,
    time,
    end: start + (time ?? 0),
    wait: Number.isFinite(e.timings?.wait) && e.timings.wait >= 0 ? Math.round(e.timings.wait) : null,
    size: Number.isFinite(res.content?.size) && res.content.size >= 0 ? res.content.size : null,
    transfer: Number.isFinite(res._transferSize) && res._transferSize >= 0 ? res._transferSize : null,
    compressed: Boolean(headerOf(res.headers, 'content-encoding')),
    step: Number.isInteger(e._qaStep) ? e._qaStep : null,
    after: Boolean(e._qaAfterStep),
    page: 0,
    timer: false,
  };
}

/** What a finding or a row says of a call. */
function brief(c) {
  return { method: c.method, origin: c.origin, path: c.path, own: c.own, status: c.status, failure: c.failure, reason: c.reason, ms: c.time, wait: c.wait, size: c.size };
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

/** The same call's moments, those asked at once taken as one: [[c, c'], [c'']]. */
function bursts(calls) {
  const out = [];
  for (const c of [...calls].sort((a, b) => a.start - b.start)) {
    if (out.length && c.start - out.at(-1).at(-1).start <= AT_ONCE) out.at(-1).push(c);
    else out.push([c]);
  }
  return out;
}

/**
 * Calls on a timer (a poll, a heartbeat): the same call at a steady pace
 * within one page. A call made once for every page a suite opens is no
 * timer, however steady the suite (found in CritKeep: three of three).
 */
function timersOf(calls) {
  const timers = [];
  for (const list of groupBy(
    calls.filter((c) => c.kind === 'api'),
    (c) => `${c.person} ${c.page} ${c.method} ${c.origin}${c.path}`,
  ).values()) {
    const moments = bursts(list);
    if (moments.length < TIMER_CALLS) continue;
    const starts = moments.map((b) => b[0].start);
    const gaps = starts.slice(1).map((s, i) => s - starts[i]);
    const every = median(gaps);
    if (every < 400) continue;
    const steady = gaps.filter((g) => g >= every * 0.6 && g <= every * 1.6).length;
    if (steady < gaps.length * 0.75) continue;
    for (const c of list) c.timer = true;
    timers.push({ person: list[0].person, call: brief(list[0]), every: Math.round(every), count: moments.length });
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
 * The longest run of calls where each began as the one before ended. Not
 * when something else may have set the next one off: the person pressing
 * or typing between the two (`inputs`), or a script arriving (`code`),
 * asked for once the first call had begun, which mounts the parts of the
 * page that ask in their turn. Most of the chains of a development server
 * were those, coincidences; a chain with nothing between is a page that
 * waited for an answer (found in CritKeep). A script asked for before is
 * the one already running: its last byte is said to arrive a moment after
 * it began to make the very calls in question.
 */
function chainOf(list, inputs = [], code = []) {
  const calls = [...list].sort((a, b) => a.start - b.start);
  const best = calls.map(() => ({ n: 1, prev: -1 }));
  const acted = (from, to) => inputs.some((t) => t > from && t <= to);
  const arrived = (a, b) => code.some((s) => s.start >= a.start && s.end > a.end - 2 && s.end <= b.start);
  for (let i = 0; i < calls.length; i++) {
    for (let j = 0; j < i; j++) {
      const gap = calls[i].start - calls[j].end;
      if (gap < -2 || gap > CHAIN_GAP || best[j].n + 1 <= best[i].n) continue;
      if (acted(calls[j].end - 2, calls[i].start) || arrived(calls[j], calls[i])) continue;
      best[i] = { n: best[j].n + 1, prev: j };
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
function chainsOf(list, inputs, code) {
  const chains = [];
  let left = list;
  for (;;) {
    const chain = chainOf(left, inputs, code);
    if (!chain) return chains;
    chains.push(chain);
    left = left.filter((c) => !chain.calls.includes(c));
  }
}

const failed = (c) => c.status >= 400 || (c.status === 0 && Boolean(c.failure) && !c.aborted);

function rowOf(step, person, mine, inputs, code, dev) {
  const api = mine.filter((c) => c.kind === 'api' && !c.timer);
  const timed = api.filter((c) => c.time !== null);
  const safe = api.filter((c) => c.method === 'GET' || c.method === 'HEAD');
  // The same call again, within one page: once per page is the page's own
  // load, and once more after the person did something, or after the page
  // changed something on the server (a POST, a DELETE), is the page
  // reading what changed. Asked twice at the same moment is another
  // finding, and in development StrictMode's, left out.
  const changes = mine.filter((c) => c.kind === 'api' && c.method !== 'GET' && c.method !== 'HEAD').map((c) => c.start);
  const between = (times, from, to) => times.some((t) => t > from && t <= to);
  const repeats = [];
  const doubled = [];
  for (const g of groupBy(safe, (c) => `${c.page} ${c.method} ${c.origin}${c.path}`).values()) {
    const moments = bursts(g);
    let again = 0;
    for (let i = 1; i < moments.length; i++) {
      const [from, to] = [moments[i - 1][0].start, moments[i][0].start];
      if (!between(inputs, from, to) && !between(changes, from, to)) again += 1;
    }
    if (again) repeats.push({ call: brief(g[0]), count: again + 1 });
    const most = Math.max(...moments.map((b) => b.length));
    if (most >= 2) doubled.push({ call: brief(g[0]), count: most });
  }
  const perItem = [...groupBy(safe, (c) => `${c.method} ${c.origin}${template(c.path)}`).values()]
    .filter((g) => new Set(g.map((c) => c.path)).size >= PER_ITEM)
    .map((g) => ({
      call: { ...brief(g[0]), path: template(g[0].path) },
      count: new Set(g.map((c) => c.path)).size,
      ms: spanOf(g),
      atOnce: peakOf(g.filter((c) => c.time !== null)),
    }));
  // Between the app's own answered calls: another site's (analytics, maps,
  // fonts) go out on their own, and would only make chains by chance; a call
  // cut short or never answered waited for nothing. Of the same call asked
  // twice at once, the first: the other is no link of its own.
  const firsts = [...groupBy(timed, (c) => `${c.method} ${c.origin}${c.path}`).values()].flatMap((g) => bursts(g).map((b) => b[0]));
  const chains = chainsOf(firsts.filter((c) => c.own && c.status > 0), inputs, code);
  return {
    step,
    person,
    calls: api.length,
    // The addresses it called, ids aside: what a comparison compares.
    asked: [...new Set(api.map(callKey))].sort(),
    others: api.filter((c) => !c.own).length,
    late: api.filter((c) => c.after).length,
    pages: mine.filter((c) => c.kind === 'page').map(brief),
    span: spanOf(timed),
    peak: peakOf(timed),
    chain: chains[0] ?? null,
    chains,
    repeats,
    doubled: dev ? [] : doubled,
    strictDoubles: dev ? sum(doubled.map((d) => d.count - 1)) : 0,
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

function analyseTest(t, own, dev) {
  const steps = (t.meta.steps ?? []).map((s) => s.title);
  const people = Object.keys(t.hars);
  const calls = [];
  for (const [person, har] of Object.entries(t.hars)) {
    const mine = (har.log.entries ?? []).map((e) => callOf(e, person, own));
    // Each call's page: how many pages the person had opened when it began.
    const loads = mine.filter((c) => c.kind === 'page').map((c) => c.start).sort((a, b) => a - b);
    for (const c of mine) c.page = loads.filter((s) => s <= c.start).length;
    calls.push(...mine);
  }
  const inputs = Object.fromEntries(
    Object.entries(t.hars).map(([person, har]) => [person, (har.log._qaCockpit?.inputs ?? []).filter(Number.isFinite).sort((a, b) => a - b)]),
  );
  // The scripts each person's pages asked for: what may mount a part of the
  // page that asks the server in its turn (chainOf). A style mounts nothing.
  const code = Object.fromEntries(people.map((p) => [p, calls.filter((c) => c.person === p && c.type === 'script').map((c) => ({ start: c.start, end: c.end }))]));
  const timers = timersOf(calls);
  // The streams the app opens (a development server's own reload is not
  // one), by address: each opening of a socket with a ticket of its own is
  // one stream, not a new one.
  const appStreams = calls.filter((c) => c.kind === 'stream' && !c.hotReload);
  const streams = [...groupBy(appStreams, (c) => `${c.method} ${c.own ? '' : c.origin}${template(c.path)}`).values()].map((g) => {
    // Opened again and again within one page: what a stream that drops
    // does. Two openings at once are one (StrictMode opens and closes one
    // first, in development).
    const perPage = [...groupBy(g, (c) => `${c.person} ${c.page}`).values()].map((x) => ({ person: x[0].person, opened: bursts(x).length }));
    const most = perPage.sort((a, b) => b.opened - a.opened)[0];
    return {
      call: brief(g[0]),
      people: [...new Set(g.map((c) => c.person))],
      opened: g.length,
      reopened: most.opened,
      who: most.person,
    };
  });
  const rows = [];
  for (const step of [null, ...steps.keys()]) {
    for (const person of people) {
      const mine = calls.filter((c) => c.person === person && c.step === step);
      if (!mine.length) continue;
      const row = rowOf(step, person, mine, inputs[person], code[person], dev);
      // A row with nothing of the app's own (only code, images, streams) says nothing.
      if (row.calls || row.pages.length || row.errors.length) rows.push(row);
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
    for (const d of row.doubled) findings.push({ kind: 'atOnce', ...at, count: d.count, call: d.call });
    for (const c of row.slow) findings.push({ kind: 'slow', ...at, ms: c.wait, call: c });
    for (const c of row.heavy) findings.push({ kind: 'heavy', ...at, bytes: c.size, call: c });
    for (const c of row.errors) findings.push({ kind: 'error', ...at, call: c });
  }
  for (const s of streams) {
    if (s.reopened >= 3) findings.push({ kind: 'reopened', test: t.key, id, step: null, stepTitle: null, person: s.who, count: s.reopened, call: s.call });
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
    strictDoubles: sum(rows.map((r) => r.strictDoubles)),
    uncompressed: { count: plain.length, bytes: sum(plain.map((c) => c.size ?? 0)) },
    findings,
  };
}

const ORDER = ['chain', 'perItem', 'repeat', 'atOnce', 'slow', 'heavy', 'error', 'reopened', 'timer'];
const weight = (f) => (f.kind === 'chain' ? f.count * 1e6 + f.ms : f.kind === 'heavy' ? f.bytes : f.kind === 'slow' ? f.ms : (f.count ?? 0));

/**
 * What a run's HARs say, test by test and step by step.
 * @param {ReturnType<typeof readRun>} run
 * @param {{ test?: string | null }} [options] only the test with this id or key
 */
export function analyse(run, { test = null } = {}) {
  const own = ownOrigins(run);
  const dev = devServerOf(run.tests.flatMap((t) => Object.values(t.hars).flatMap((h) => h.log.entries ?? [])));
  const tests = run.tests.filter((t) => !test || t.meta.id === test || t.key === test).map((t) => analyseTest(t, own, dev));
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
    devServer: dev,
    strictDoubles: sum(tests.map((t) => t.strictDoubles)),
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

/** «GET /api/contacts/{id}», its items as {id}; the whole address for another site's. */
const said = (c) => `${c.method} ${cut(c.own ? template(c.path) : `${c.origin}${template(c.path)}`, 110)}`;

/** A chain, its runs of the same call for several items said once: «GET /api/contacts/{id} ×12». */
function chainSaid(calls) {
  const parts = [];
  for (const c of calls) {
    const key = callKey(c);
    if (parts.at(-1)?.key === key) parts.at(-1).n += 1;
    else parts.push({ key, c, n: 1 });
  }
  return parts.map((p) => `${said(p.c)}${p.n > 1 ? ` ×${p.n}` : ''}`).join(' → ');
}

/** Where a finding was: the test, the step, the person. */
function place(f) {
  if (f.step === null) return `${f.id}${f.kind === 'timer' || f.kind === 'reopened' ? '' : ' · before the steps'} (${f.person})`;
  return `${f.id} · ${cut(f.stepTitle ?? `step ${f.step + 1}`, 60)} (${f.person})`;
}

/** The places of a pattern, each once («×2» when it shows twice there). */
function places(list, shown = 3) {
  const all = [...groupBy(list, place).entries()].map(([p, xs]) => (xs.length > 1 ? `${p} ×${xs.length}` : p));
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
    why: 'Each began right after the one before had ended, with nothing else between (no press, no code arriving): most likely the page waited for an answer to ask the next thing. Asked together (or answered by one call), they would cost one round trip instead of several: here a few milliseconds, in production one network latency each. Check each in the code.',
    line: (list) =>
      `${chainSaid(list[0].calls)}: ${list[0].count} calls, ${range(list.map((f) => f.ms), ms)} here, the slowest of them ${range(list.map((f) => f.longest), ms)}. In ${places(list)}.`,
  },
  perItem: {
    title: 'One call per item',
    why: 'The same call for many items in one step (a list asking for each of its rows): one call for all of them would do.',
    line: (list) => {
      const together = Math.max(...list.map((f) => f.atOnce ?? 1));
      return `${said(list[0].call)} for ${range(list.map((f) => f.count), String)} items in one step, ${together > 1 ? `up to ${together} at once` : 'one after another'} (${range(list.map((f) => f.ms), ms)} from the first to the last). In ${places(list)}.`;
    },
  },
  repeat: {
    title: 'The same call again',
    why: 'The very same request again on the same page, with nothing done between (no press, nothing changed on the server): the page already had the answer. A page opened again, or reading what an action changed, asks again: that is not counted.',
    line: (list) => `${said(list[0].call)} ×${range(list.map((f) => f.count), String)} in one page. In ${places(list)}.`,
  },
  atOnce: {
    title: 'The same call twice at once',
    why: 'Two parts of the page asking for the same thing at the same moment, each on its own: a shared request, or a cache, would ask once.',
    line: (list) => `${said(list[0].call)} ×${range(list.map((f) => f.count), String)} at once. In ${places(list)}.`,
  },
  slow: {
    title: `Slow on the server (${ms(SLOW)} or more waiting for it)`,
    why: 'The time between sending the request and its first byte back, from a server with this copy’s small data: in production it is as slow, or slower.',
    line: (list) => `${said(list[0].call)} waited ${range(list.map((f) => f.ms), ms)}. In ${places(list)}.`,
  },
  heavy: {
    title: `Heavy responses (${bytes(HEAVY)} or more)`,
    why: 'Does the page show all of it? A response trimmed to what the screen uses, or paged, is lighter on every phone.',
    line: (list) => `${said(list[0].call)} brought ${range(list.map((f) => f.bytes), bytes)}. In ${places(list)}.`,
  },
  error: {
    title: 'Errors',
    why: 'Calls the server refused, or that failed: a red the screen may hide, or a refusal the suite asks for (its code says which, when the run kept the responses: `--bodies`).',
    line: (list) => {
      const c = list[0].call;
      const reasons = [...new Set(list.map((f) => f.call.reason).filter(Boolean))];
      return `${said(c)} → ${c.status > 0 ? c.status : (c.failure ?? 'failed')}${reasons.length ? ` ${reasons.join(', ')}` : ''}${list.length > 1 ? ` ×${list.length}` : ''}. In ${places(list)}.`;
    },
  },
  reopened: {
    title: 'Streams opened again and again',
    why: 'A live stream (EventSource, WebSocket) that closes and opens again within one page: each time, the page may miss what happened meanwhile.',
    line: (list) => `${said(list[0].call)} opened ${range(list.map((f) => f.count), String)} times in one page. In ${places(list)}.`,
  },
  timer: {
    title: 'On a timer (left out of the steps)',
    why: 'The same call at a steady pace within one page, whatever the person does: a poll or a heartbeat. Each costs the server, for every person who has the page open.',
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
  if (!t.rows.length) return [...out, 'No calls of the app.', ''];
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
  const streams = t.streams.map((s) => `${said(s.call)} ×${s.opened} (${s.people.join(', ')})`);
  if (streams.length) out.push(`Streams: ${streams.join('; ')}.`, '');
  if (t.timers.length) out.push(`On a timer, left out of the rows: ${t.timers.map((x) => `${said(x.call)} every ${ms(x.every)} (${x.person})`).join('; ')}.`, '');
  return out;
}

function summaryOf(a) {
  const m = a.meta;
  const people = [...new Set(a.tests.flatMap((t) => t.people))];
  return `\`${m.command ?? 'replay'}\`, ${m.status ?? 'running or stopped'}, started ${String(m.startedAt ?? '').replace('T', ' ').slice(0, 16)}; ${noun(a.tests.length, 'test', 'tests')}${people.length ? `, ${people.join(', ')}` : ''}${m.bodies ? '; with the responses’ text' : ''}`;
}

/** What a development server does, said before the findings. */
function devText(a) {
  if (!a.devServer) return [];
  return [
    `- This copy's front is a development server (${a.devServer}): its code arrives in hundreds of modules, and the parts of a page that mount as theirs arrive ask the server in waves. A call that began while code arrived is not counted in a chain${a.strictDoubles ? `, and ${noun(a.strictDoubles, 'call asked a second time at the same moment was', 'calls asked a second time at the same moment were')} left out: React's StrictMode does that in development, never in production` : ''}. For a measure, look at the network of the built front, served at the same address (the skill: «A page that loads slowly»).`,
  ];
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
  out.push(...devText(a));
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

// The same finding in two runs: its kind and calls (ids aside), its test and
// person; not its step, which a chain may change by a few milliseconds. A
// test's own (a timer, a stream that drops) by its test alone: whoever of
// its people showed it most changes from run to run.
const findingKey = (f) => (f.step === null ? `${patternOf(f)}|${f.id}` : `${patternOf(f)}|${f.id}|${f.person}`);

/**
 * What changed from one run to another: the steps whose calls changed, and
 * the findings gone and new. Two runs alike say «nothing»: each run's own
 * items (new ids after a reset), its milliseconds' play, and the chains a
 * development server makes by chance (two alike runs of CritKeep's
 * development server shared only half of theirs) are left out.
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
  const dev = now.devServer ?? before.devServer;
  if (dev) {
    out.push(
      `- A development server (${dev}) makes chains by chance, different from one run to the next: chains are not compared. Compare runs of the built front for those.`,
    );
  }
  out.push(`- Their HARs: \`${shown(now.dir)}\`, \`${shown(before.dir)}\``, '');

  const rowsBefore = new Map();
  for (const t of before.tests) for (const r of t.rows) rowsBefore.set(`${t.key}|${r.step}|${r.person}`, { t, r });
  // Nearly every step slower (or faster) by the same much: the machine,
  // busier one time than the other, more than the app (found in CritKeep:
  // a run made under load took twice as long, every step).
  const ratios = now.tests
    .flatMap((t) => t.rows.map((r) => [r, rowsBefore.get(`${t.key}|${r.step}|${r.person}`)?.r]))
    .filter(([r, b]) => b && r.span > 50 && b.span > 50)
    .map(([r, b]) => r.span / b.span);
  const pace = median(ratios);
  const busy = ratios.length >= 4 && (pace >= 1.5 || pace <= 1 / 1.5);
  if (busy) {
    // Its calls «slow on the server» came or went with the machine: said
    // here, not among the findings new and gone (12 of 13 «new» were
    // those, against a run made under load in CritKeep).
    const slow = (a) => a.findings.filter((f) => f.kind === 'slow');
    const keys = (a) => new Set(slow(a).map(findingKey));
    // Counted by call, as the findings list them.
    const calls = (list) => new Set(list.map((f) => callKey(f.call))).size;
    const came = calls(slow(now).filter((f) => !keys(before).has(findingKey(f))));
    const went = calls(slow(before).filter((f) => !keys(now).has(findingKey(f))));
    out.push(
      `> Most steps took ${pace >= 1.5 ? `${pace.toFixed(1)} times as long` : `${(1 / pace).toFixed(1)} times less`} as before: the machine was busier one of the times, most likely. Its milliseconds, and the calls «slow on the server», say little here: run both again on a quiet machine.${came || went ? ` The calls slow on the server that ${came ? `came (${came})` : ''}${came && went ? ' or ' : ''}${went ? `went (${went})` : ''} with it are left out of the findings below.` : ''}`,
      '',
    );
  }
  const changed = [];
  const seen = new Set();
  const arrow = (a, b, f = (x) => x) => (f(a) === f(b) ? `${f(b)}` : `${f(a)} → ${f(b)}`);
  const label = (t, r) => `${t.id} · ${r.step === null ? 'before the steps' : cut(t.steps[r.step] ?? `step ${r.step + 1}`, 50)}`;
  const none = { calls: 0, asked: [], chain: null, chains: [], peak: 0, span: 0, bytes: 0, errors: [] };
  for (const t of now.tests) {
    for (const r of t.rows) {
      const key = `${t.key}|${r.step}|${r.person}`;
      seen.add(key);
      const b = rowsBefore.get(key)?.r ?? none;
      // What the app asked, not when nor how often by a moment's play: the
      // addresses it called, its errors, its bytes when a tenth more or
      // less, its milliseconds when they moved by half and a third of a second.
      const moved =
        b.asked.join(' ') !== r.asked.join(' ') ||
        b.errors.length !== r.errors.length ||
        (Math.abs(r.bytes - b.bytes) > 1024 && Math.abs(r.bytes - b.bytes) > 0.1 * Math.max(r.bytes, b.bytes)) ||
        (Math.abs(r.span - b.span) >= 300 && Math.abs(r.span - b.span) > 0.5 * Math.max(r.span, b.span));
      if (!moved) continue;
      const chainBefore = b.chain ? b.chain.calls.length : 0;
      const chainNow = r.chain ? r.chain.calls.length : 0;
      changed.push(
        `| ${cell(label(t, r))} | ${r.person} | ${arrow(b.calls, r.calls)} | ${arrow(chainBefore || '–', chainNow || '–')} | ${arrow(b.peak, r.peak)} | ${arrow(b.span, r.span, ms)} | ${arrow(b.bytes, r.bytes, bytes)} |`,
      );
    }
  }
  for (const [key, { t, r }] of rowsBefore) {
    if (seen.has(key) || !r.calls) continue;
    changed.push(`| ${cell(label(t, r))} | ${r.person} | ${r.calls} → 0 | ${r.chain ? r.chain.calls.length : '–'} → – | ${r.peak} → 0 | ${ms(r.span)} → – | ${bytes(r.bytes)} → 0 |`);
  }
  out.push('## Steps whose calls changed', '');
  if (changed.length) {
    out.push('| Test · step | Who | Calls | One after another | At once | Network | Brought |', '|---|---|---|---|---|---|---|', ...changed, '');
  } else {
    out.push('None: the same calls, and the milliseconds within their noise.', '');
  }

  const compared = (list) => list.filter((f) => !(dev && f.kind === 'chain') && !(busy && f.kind === 'slow'));
  const keysBefore = new Set(compared(before.findings).map(findingKey));
  const keysNow = new Set(compared(now.findings).map(findingKey));
  const gone = compared(before.findings).filter((f) => !keysNow.has(findingKey(f)));
  const added = compared(now.findings).filter((f) => !keysBefore.has(findingKey(f)));
  const listed = (list) => patterns(list).map((g) => `- ${KINDS[g[0].kind].title}: ${KINDS[g[0].kind].line(g)}`);
  out.push(`## Findings gone (${patterns(gone).length})`, '', ...(gone.length ? listed(gone) : ['None.']), '');
  out.push(`## Findings new (${patterns(added).length})`, '', ...(added.length ? listed(added) : ['None.']), '');
  const both = patterns(compared(now.findings).filter((f) => keysBefore.has(findingKey(f)))).length;
  out.push(`${noun(both, 'finding is', 'findings are')} in both: \`network ${now.id}\` lists them.`, '');
  return out.join('\n');
}

/** What `--json` prints: the analysis, every finding on its own. */
export function reportJson(a) {
  return {
    id: a.id,
    dir: a.dir,
    meta: a.meta,
    devServer: a.devServer,
    strictDoubles: a.strictDoubles,
    findings: a.findings,
    uncompressed: a.uncompressed,
    tests: a.tests.map(({ findings, ...t }) => t),
  };
}
