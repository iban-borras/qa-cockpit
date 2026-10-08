// Reports from «Play as» (cockpit, open-browser.mjs). A person plays with the
// app in a window of their own, signed in as somebody of the cast, and
// finds something wrong: the cockpit followed the window as it follows a
// run, and «Make a report» turns what was done into a run of its own, of
// kind «play», with steps in a suite's words («3 · Bob: types «hola» in
// «Message»»), each with the window just before it, its requests and the
// page's errors, and the person's note on what went wrong, for an agent to
// reproduce it.
//
// The window is not slowed by any of it: its photos come from a screencast
// kept for a few seconds, the frame just before each action, and nothing
// waits for the cockpit. What a person types is kept, to be typed again,
// but never in a password's field, nor a card's, a code's or a token's.

import fs from 'node:fs';
import path from 'node:path';

// The frames kept, a few seconds' worth, one per tenth of a second at most:
// an action's photo is the last painted before it.
const KEEP_MS = 6_000;
const BUCKET_MS = 100;
// A report holds the last actions since the one before it, at most these.
export const MAX_ACTS = 60;
// A page opened within this long after an action is that action's doing (a
// link clicked), not a step of its own.
const NAV_AFTER_ACT_MS = 2_000;

/** In the page: the person's own actions (not the app's), told to the window's process. */
export function playScript() {
  if (window.top !== window) return;
  // Each told in its order: two in one millisecond keep it.
  let seq = 0;
  const tell = (e) => {
    try {
      window.__qaPlay?.({ ...e, n: ++seq });
    } catch {
      // The cockpit is a luxury.
    }
  };
  // The click an Enter makes (a form sent from its field) is the Enter's.
  let keyAt = 0;
  const named = (el) => {
    const t =
      el?.closest?.('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], label, summary, input, select, textarea') ??
      el;
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '');
    const text = field
      ? t.getAttribute('aria-label') || t.labels?.[0]?.innerText || t.placeholder || t.name || t.id || t.type
      : t?.getAttribute?.('aria-label') || t?.innerText || t?.tagName || '';
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
  };
  // What is typed in these is said to be typed, never what.
  const secret = (el) =>
    el?.type === 'password' ||
    /password|one-time-code|cc-/i.test(el?.autocomplete ?? '') ||
    /pass|secret|token|otp|\bpin\b|cvv|cvc|card|iban/i.test(`${el?.name ?? ''} ${el?.id ?? ''}`);
  const textual = (el) =>
    el?.isContentEditable || el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && !/^(checkbox|radio|range|color|file|button|submit|reset|image)$/i.test(el.type));
  const centre = (el) => {
    const r = (el ?? document.documentElement).getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  const at = (x, y) => ({ x: Math.round(x + scrollX), y: Math.round(y + scrollY), vx: Math.round(x), vy: Math.round(y), url: location.href });
  // A field typed in: its first key says where and when (its photo), its
  // value is told when the person goes on (another action, or out of it).
  let typing = null;
  let n = 0;
  const done = () => {
    if (!typing) return;
    const { el, id } = typing;
    typing = null;
    const hidden = secret(el);
    tell({ kind: 'typed', id, hidden, value: hidden ? null : String(el.isContentEditable ? el.innerText : (el.value ?? '')).slice(0, 200) });
  };
  addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || (e.detail === 0 && Date.now() - keyAt < 150)) return;
      done();
      // A click from the keyboard carries no position: the element's centre.
      const [x, y] = e.detail === 0 || (e.clientX === 0 && e.clientY === 0) ? centre(e.target) : [e.clientX, e.clientY];
      tell({ kind: 'click', label: named(e.target), t: Date.now(), ...at(x, y) });
    },
    true,
  );
  addEventListener(
    'input',
    (e) => {
      const el = e.target;
      if (!e.isTrusted || !textual(el)) return;
      if (typing && typing.el !== el) done();
      if (typing) return;
      const r = el.getBoundingClientRect();
      typing = { el, id: ++n };
      tell({ kind: 'typing', id: typing.id, label: named(el), t: Date.now(), ...at(r.left + Math.min(28, r.width / 2), r.top + r.height / 2) });
    },
    true,
  );
  addEventListener(
    'change',
    (e) => {
      const el = e.target;
      if (!e.isTrusted || el?.tagName !== 'SELECT') return;
      done();
      const value = el.selectedOptions?.[0]?.text?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '';
      tell({ kind: 'pick', label: named(el), value, t: Date.now(), ...at(...centre(el)) });
    },
    true,
  );
  addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      // Enter on a button or a link is its click, told as such.
      if (e.key === 'Enter' && e.target?.closest?.('button, a, [role="button"], summary')) return;
      done();
      keyAt = Date.now();
      tell({ kind: 'key', key: e.key, label: e.target === document.body ? '' : named(e.target), t: Date.now(), ...at(...centre(e.target)) });
    },
    true,
  );
  addEventListener('focusout', (e) => (typing && e.target === typing.el ? done() : undefined), true);
  addEventListener('pagehide', done);
}

const pathOf = (url) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return String(url ?? '').slice(0, 200);
  }
};

/**
 * In the window's process: its pages followed for the cockpit. Each action
 * the person takes (playScript) goes with the frame painted just before it,
 * written to `dir`; the page's requests and errors go as they happen;
 * `latest.jpg` is the window as it is now, for the report's last step.
 * `send(events)` takes them to the cockpit, a few at a time.
 */
export async function followPlay({ context, device, dir, send }) {
  fs.mkdirSync(dir, { recursive: true });
  const queue = [{ kind: 'hello', t: Date.now(), device }];
  let sending = false;
  const flush = async () => {
    if (sending || !queue.length) return;
    sending = true;
    try {
      await send(queue.splice(0, 200));
    } catch {
      // The cockpit gone: the window is the person's all the same.
    } finally {
      sending = false;
    }
  };
  const timer = setInterval(() => void flush(), 400);

  // ── the frames ──
  const frames = new Map();
  let shotNo = 0;
  let newest = null;
  const photo = async (page, t) => {
    const list = frames.get(page) ?? [];
    let f = null;
    for (const x of list) {
      if (x.t > t) break;
      f = x;
    }
    // Nothing painted before it yet: the first there is.
    f ??= list[0] ?? null;
    if (!f) return { photo: null };
    if (!f.file) {
      f.file = `${f.t}-${++shotNo}.jpg`;
      await fs.promises.writeFile(path.join(dir, f.file), Buffer.from(f.data, 'base64')).catch(() => (f.file = null));
    }
    return f.file ? { photo: f.file, viewport: f.viewport } : { photo: null };
  };
  const screencast = async (page) => {
    const list = [];
    frames.set(page, list);
    try {
      const cdp = await context.newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        // When it was painted, on the wall clock the page's actions are on.
        const t = Math.round((metadata?.timestamp ?? Date.now() / 1000) * 1000);
        const frame = { t, data, viewport: { width: Math.round(metadata?.deviceWidth ?? 0), height: Math.round(metadata?.deviceHeight ?? 0) }, url: page.url() };
        // One per tenth of a second: the newest in it.
        if (list.length && t - list.at(-1).t < BUCKET_MS && !list.at(-1).file) list[list.length - 1] = frame;
        else list.push(frame);
        while (list.length > 1 && list[1].t < Date.now() - KEEP_MS) list.shift();
        newest = frame;
      });
      // At the window's own size, in CSS pixels: the marks are.
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
    } catch {
      // No photos of this page: its actions are still told.
    }
  };
  // The window as it is now, about once a second when it changed.
  let latestAt = 0;
  const latest = setInterval(() => {
    const f = newest;
    if (!f || f.t === latestAt) return;
    latestAt = f.t;
    const tmp = path.join(dir, 'latest.tmp');
    fs.promises
      .writeFile(tmp, Buffer.from(f.data, 'base64'))
      .then(() => fs.promises.rename(tmp, path.join(dir, 'latest.jpg')))
      .then(() => queue.push({ kind: 'latest', t: f.t, viewport: f.viewport, url: f.url }))
      .catch(() => {});
  }, 1_000);

  // ── the person's actions ──
  const typings = new Map();
  await context.exposeBinding('__qaPlay', async ({ page }, e) => {
    if (!e || typeof e !== 'object') return;
    const where = { n: Number(e.n) || 0, label: String(e.label ?? '').slice(0, 60), x: e.x, y: e.y, vx: e.vx, vy: e.vy, url: String(e.url ?? '') };
    if (e.kind === 'typing') {
      typings.set(e.id, { t: e.t, ...where, shot: photo(page, e.t) });
    } else if (e.kind === 'typed') {
      const s = typings.get(e.id);
      typings.delete(e.id);
      if (!s) return;
      const { shot, ...rest } = s;
      queue.push({ kind: 'act', act: 'type', ...rest, value: e.hidden ? null : String(e.value ?? '').slice(0, 200), hidden: Boolean(e.hidden), ...(await shot) });
    } else if (e.kind === 'click' || e.kind === 'key' || e.kind === 'pick') {
      const extra = e.kind === 'key' ? { key: String(e.key) } : e.kind === 'pick' ? { value: String(e.value ?? '').slice(0, 80) } : {};
      queue.push({ kind: 'act', act: e.kind, t: e.t, ...where, ...extra, ...(await photo(page, e.t)) });
    }
  });
  await context.addInitScript(playScript);

  // ── the pages: their frames, their errors, where they went ──
  const follow = async (page) => {
    await screencast(page);
    page.on('console', (m) => {
      if (m.type() === 'error') queue.push({ kind: 'console', t: Date.now(), level: 'error', text: m.text().slice(0, 300) });
    });
    page.on('pageerror', (err) => queue.push({ kind: 'console', t: Date.now(), level: 'exception', text: String(err?.message ?? err).slice(0, 300) }));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) queue.push({ kind: 'nav', t: Date.now(), url: frame.url() });
    });
  };
  for (const page of context.pages()) await follow(page);
  context.on('page', (page) => void follow(page));

  // ── the requests: the app's calls and its pages ──
  const kept = (r) => ['fetch', 'xhr', 'document'].includes(r.resourceType());
  const request = (r, status, failure = null) => {
    const t = r.timing();
    queue.push({
      kind: 'request',
      t: t.startTime > 0 ? Math.round(t.startTime) : Date.now(),
      type: r.resourceType() === 'document' ? 'page' : 'api',
      method: r.method(),
      path: pathOf(r.url()).slice(0, 200),
      status,
      ms: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
      ...(failure ? { failure: String(failure).slice(0, 120) } : {}),
    });
  };
  context.on('requestfinished', (r) => {
    if (!kept(r)) return;
    r.response()
      .then((res) => request(r, res?.status() ?? 0))
      .catch(() => request(r, 0));
  });
  context.on('requestfailed', (r) => {
    if (kept(r)) request(r, 0, r.failure()?.errorText);
  });

  return {
    /** The window closed: the last of it told. */
    async stop() {
      clearInterval(timer);
      clearInterval(latest);
      queue.push({ kind: 'closed', t: Date.now() });
      sending = false;
      await flush();
    },
  };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const markKind = { click: 'click', type: 'type', key: 'key', pick: 'pick' };

/** An action in a suite's words: «clicks «Send»», «types «hola» in «Message»». */
export function stepWords(a) {
  const q = (s) => `«${s}»`;
  if (a.act === 'click') return `clicks ${q(a.label || 'the page')}`;
  if (a.act === 'type') return a.hidden ? `types in ${q(a.label)} (hidden)` : `types ${q(a.value ?? '')} in ${q(a.label)}`;
  if (a.act === 'key') return `presses ${a.key}${a.label ? ` in ${q(a.label)}` : ''}`;
  if (a.act === 'pick') return `picks ${q(a.value ?? '')} in ${q(a.label)}`;
  if (a.act === 'open') return `opens ${pathOf(a.url)}`;
  return a.act;
}

/**
 * A report as a run (the cockpit writes it): from each window's events
 * since its last report, the steps in time order, each with the window just
 * before it (an action's photo, its mark on it) and the window after it (the
 * next action's photo, or the window as it is now), its requests and the
 * page's errors; then each person's window now, with the note.
 * @param {{ sessions: { actor: string, device: any, dir: string, events: any[], since: number, latest: any }[], note: string, title: string, runDir: string, relOut: (abs: string) => string, now: number }} o
 */
export function playRun({ sessions, note, title, runDir, relOut, now }) {
  const copies = [];
  const keep = (s, file, as) => {
    const to = path.join(runDir, 'frames', as);
    copies.push({ from: path.join(s.dir, file), to });
    return relOut(to);
  };
  // Each window's steps: its actions, and the pages it opened by itself.
  const steps = [];
  for (const s of sessions) {
    const evs = s.events.filter((e) => e.t > s.since);
    const acts = evs.filter((e) => e.kind === 'act');
    for (const a of acts) steps.push({ s, ...a });
    for (const nav of evs.filter((e) => e.kind === 'nav' && e.url && !e.url.startsWith('about:'))) {
      const caused = acts.some((a) => a.t <= nav.t && nav.t - a.t < NAV_AFTER_ACT_MS);
      if (!caused) steps.push({ s, kind: 'act', act: 'open', t: nav.t, url: nav.url, label: '', photo: null });
    }
  }
  steps.sort((a, b) => a.t - b.t || (a.s === b.s ? (a.n ?? 0) - (b.n ?? 0) : 0));
  const dropped = Math.max(0, steps.length - MAX_ACTS);
  const kept = steps.slice(dropped);
  const frames = [];
  const iso = (t) => new Date(t).toISOString();
  const between = (s, kind, from, to) => s.events.filter((e) => e.kind === kind && e.t >= from && e.t < to);
  const requestsOf = (s, from, to) =>
    between(s, 'request', from, to)
      .slice(0, 200)
      .map((r) => ({ kind: r.type === 'page' ? 'page' : 'api', method: r.method, path: r.path, status: r.status, ms: r.ms, at: r.t }));
  const consoleOf = (s, from, to) => between(s, 'console', from, to).slice(0, 20).map((c) => ({ level: c.level, text: c.text, at: c.t }));
  let shot = 0;
  for (const [i, a] of kept.entries()) {
    const step = `${i + 1} · ${cap(a.s.actor)}: ${stepWords(a)}`;
    // The window after it: just before the same window's next action, or now.
    const next = kept.slice(i + 1).find((b) => b.s === a.s) ?? null;
    const to = next ? next.t : now;
    // With no photo after it (nothing painted yet), its own before it.
    const after =
      (next?.photo && { file: next.photo, viewport: next.viewport }) ||
      (a.s.latest && { file: 'latest.jpg', viewport: a.s.latest.viewport }) ||
      (a.photo && { file: a.photo, viewport: a.viewport }) ||
      null;
    if (!after) continue;
    const base = { actor: a.s.actor, test: title, step, device: a.s.device ?? null, location: null, scroll: { x: 0, y: 0 }, began: iso(a.t) };
    let of = frames.length + 1;
    if (a.photo) {
      of += 1;
      frames.push({
        ...base,
        seq: frames.length + 1,
        kind: 'action',
        of,
        status: 'passed',
        error: null,
        url: a.url,
        file: keep(a.s, a.photo, `${++shot}-${a.photo}`),
        viewport: a.viewport ?? null,
        // A key pressed says which; a pick, what was picked.
        marks: [{ kind: markKind[a.act] ?? 'click', x: a.vx ?? 0, y: a.vy ?? 0, url: a.url, label: (a.act === 'key' ? a.key : a.act === 'pick' ? a.value : a.label) ?? '', at: a.t, n: 1 }],
        requests: [],
        ms: null,
        time: iso(a.t),
      });
    }
    frames.push({
      ...base,
      seq: of,
      status: 'passed',
      error: null,
      url: next?.url ?? a.s.latest?.url ?? a.url ?? '',
      file: keep(a.s, after.file, `${++shot}-${after.file}`),
      viewport: after.viewport ?? null,
      marks: [],
      requests: requestsOf(a.s, a.t, to),
      console: consoleOf(a.s, a.t, to),
      findings: [],
      langs: [],
      langsSkipped: null,
      langsStopped: null,
      realtime: null,
      // The person's pace, not the app's: no step's time.
      ms: null,
      photosMs: null,
      time: iso(to),
    });
  }
  // Each window as it is now: where the person saw it go wrong.
  const people = sessions.map((s) => cap(s.actor)).join(', ');
  const last = `${kept.length + 1} · ${people}: the screen when it was reported`;
  const wrong = note || 'Reported from «Play as», with no note.';
  for (const s of sessions) {
    if (!s.latest) continue;
    const own = kept.filter((a) => a.s === s);
    const from = own.at(-1)?.t ?? s.since;
    // What its last action's step does not list already: a window that
    // only watched has all of its own here.
    const listed = own.length ? now + 1 : s.since;
    frames.push({
      seq: frames.length + 1,
      actor: s.actor,
      test: title,
      step: last,
      status: 'failed',
      error: wrong,
      url: s.latest.url ?? '',
      file: keep(s, 'latest.jpg', `${++shot}-latest-${s.actor}.jpg`),
      location: null,
      viewport: s.latest.viewport ?? null,
      scroll: { x: 0, y: 0 },
      marks: [],
      device: s.device ?? null,
      requests: requestsOf(s, listed, now + 1),
      console: consoleOf(s, listed, now + 1),
      findings: [],
      langs: [],
      langsSkipped: null,
      langsStopped: null,
      realtime: null,
      began: iso(from),
      ms: null,
      photosMs: null,
      time: iso(now),
    });
  }
  const first = kept[0]?.t ?? Math.min(...sessions.map((s) => s.since || now));
  return { frames, copies, acts: kept.length, dropped, startedAt: iso(first), people: sessions.map((s) => s.actor) };
}
