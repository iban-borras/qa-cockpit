// Changes from an earlier run (`replay --changes`, `qa-cockpit changes`).
// After a change to the code, the suite may still pass and the app be
// different: a screen laid out otherwise, a call more, an error in the
// console. A run is compared with an earlier green one of the same suite,
// made the same way (the newest, or the one a person picks, so that a fix
// is not taken for a change), step by step as a text is: steps aligned by
// test, step and person.
//
//   photos     each step's, and each action's (the step's weighs more),
//              in the project's own Chromium, at a small size and with a
//              tolerance: the regions that changed, as boxes on this run's
//              photo; what changes by itself (the config's `changes.mask`)
//              left out
//   requests   by endpoint (ids folded): new ones, gone ones, another
//              status, more or fewer calls
//   errors     what the page said went wrong that it did not before
//
// A round of a search for races is compared with the search's round 0,
// played as it is. Nothing of it costs the run: it is done after it.
import fs from 'node:fs';
import path from 'node:path';
import { readRunFiles } from './notes.mjs';
import { playwrightOf } from './playwright.mjs';

export const CHANGES_FILE = 'changes.json';
// Photos compared at this width, in blocks of this side: a region is the
// blocks that changed, joined; a single block is noise (a caret, a pixel).
const WIDTH = 320;
const BLOCK = 8;
const TOLERANCE = 40;
const MIN_BLOCKS = 2;

const readMeta = (root, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, id, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
};

const runIds = (root) =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'run.json')))
        .map((e) => e.name)
        .sort()
        .reverse()
    : [];

/** Whether a run can be the one others are compared with: green, and its recording played (a replay or a full run; no report, no round, no setup alone). */
const comparable = (m) => m && m.status === 'passed' && (!m.kind || m.kind === 'replay' || m.kind === 'full') && !m.chaos;

/**
 * The run a run is compared with: the newest green one before it, of the
 * same suite and made the same way (its kind, in a container or not); with
 * none, the newest green one of the suite before it.
 */
export function baselineOf(root, id) {
  const meta = readMeta(root, id);
  if (!meta) return null;
  const before = runIds(root).filter((other) => other < id);
  const same = (m) => (m.kind ?? null) === (meta.kind ?? null) && Boolean(m.docker) === Boolean(meta.docker);
  let loose = null;
  for (const other of before) {
    const m = readMeta(root, other);
    if (!comparable(m) || m.suite !== meta.suite) continue;
    if (same(m)) return other;
    loose ??= other;
  }
  return loose;
}

/** The green runs of a suite before a run: the ones a person may compare it with, newest first. */
export function candidatesOf(root, id) {
  const meta = readMeta(root, id);
  if (!meta) return [];
  return runIds(root)
    .filter((other) => other < id)
    .map((other) => ({ id: other, meta: readMeta(root, other) }))
    .filter((x) => comparable(x.meta) && x.meta.suite === meta.suite)
    .map((x) => ({ id: x.id, kind: x.meta.kind ?? null, startedAt: x.meta.startedAt }));
}

/** An endpoint as the reports name it: ids folded into `{id}` and `{n}`. */
const endpoint = (r) =>
  `${r.method} ${String(r.path ?? '')
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
    .replace(/\/\d+(?=\/|$)/g, '/{n}')}`;

/** What a page's error says, its numbers and ids left out: the same error twice is one. */
const errorKey = (c) =>
  String(c.text ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
    .replace(/\d+/g, '#')
    .slice(0, 200);

/** Two steps' requests, by endpoint: what came, went, answered otherwise, or was called more or less. */
function requestsDiff(now = [], was = []) {
  const group = (list) => {
    const m = new Map();
    for (const r of list) {
      const k = endpoint(r);
      const g = m.get(k) ?? { n: 0, statuses: new Set() };
      g.n += 1;
      g.statuses.add(r.status || 0);
      m.set(k, g);
    }
    return m;
  };
  const a = group(now);
  const b = group(was);
  const out = { new: [], gone: [], status: [], count: [] };
  for (const [k, g] of a) {
    const h = b.get(k);
    if (!h) {
      out.new.push(`${k} ${[...g.statuses].join('/')}`);
      continue;
    }
    const s1 = [...g.statuses].sort().join('/');
    const s0 = [...h.statuses].sort().join('/');
    if (s1 !== s0) out.status.push({ what: k, was: s0, now: s1 });
    if (g.n !== h.n) out.count.push({ what: k, was: h.n, now: g.n });
  }
  for (const [k, h] of b) if (!a.has(k)) out.gone.push(`${k} ${[...h.statuses].join('/')}`);
  return out;
}

const someRequests = (d) => d.new.length + d.gone.length + d.status.length + d.count.length > 0;

/** In a page of the project's Chromium: where two photos differ, at this run's photo's pixels. */
async function photoDiffInPage({ a, b, masksA, masksB, width, block, tolerance, minBlocks }) {
  const load = (src) =>
    new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => no(new Error('not an image'));
      img.src = src;
    });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const ka = width / ia.naturalWidth;
  const kb = width / ib.naturalWidth;
  const ha = Math.max(1, Math.round(ia.naturalHeight * ka));
  const hb = Math.max(1, Math.round(ib.naturalHeight * kb));
  const H = Math.max(ha, hb);
  // What changes by itself, from either run, painted alike on both.
  const masks = [...masksA.map((m) => [m, ka]), ...masksB.map((m) => [m, kb])];
  const pixels = (img, k, h) => {
    const c = new OffscreenCanvas(width, H);
    const g = c.getContext('2d', { willReadFrequently: true });
    // Below the shorter photo, nothing of it: a page grown or shrunk.
    g.fillStyle = '#ff00ff';
    g.fillRect(0, 0, width, H);
    g.drawImage(img, 0, 0, width, h);
    g.fillStyle = '#808080';
    for (const [m, km] of masks) g.fillRect(Math.floor(m.x * km), Math.floor(m.y * km), Math.ceil(m.w * km) + 1, Math.ceil(m.h * km) + 1);
    return g.getImageData(0, 0, width, H).data;
  };
  const pa = pixels(ia, ka, ha);
  const pb = pixels(ib, kb, hb);
  // Something put in or taken out pushes all below it up or down: the rows
  // that match the earlier photo moved by the same offset are not changes.
  // Each row in short (its colour every few pixels), and the offset that
  // matches the most of them.
  const step = 4;
  const sig = (p) => {
    const out = [];
    for (let y = 0; y < H; y++) {
      const row = new Int16Array(Math.ceil(width / step) * 3);
      for (let x = 0, k = 0; x < width; x += step, k += 3) {
        const i = (y * width + x) * 4;
        row[k] = p[i];
        row[k + 1] = p[i + 1];
        row[k + 2] = p[i + 2];
      }
      out.push(row);
    }
    return out;
  };
  const sa = sig(pa);
  const sb = sig(pb);
  const same = (r, q) => {
    for (let k = 0; k < r.length; k++) if (Math.abs(r[k] - q[k]) > tolerance) return false;
    return true;
  };
  let shift = 0;
  let best = 0;
  for (let y = 0; y < H; y++) if (same(sa[y], sb[y])) best += 1;
  // Nearly every row where it was: nothing moved, nothing to look for.
  const reach = best >= H * 0.98 ? 0 : Math.floor(H / 2);
  for (let d = -reach; d <= reach; d++) {
    if (!d) continue;
    let n = 0;
    for (let y = Math.max(0, d); y < Math.min(H, H + d); y++) if (same(sa[y], sb[y - d])) n += 1;
    // Worth it only when it explains clearly more than staying put.
    if (n > best + 8) {
      best = n;
      shift = d;
    }
  }
  // Moved up: something above was taken out, and nothing of it is left on
  // this photo to box. Where the rows start matching only moved, it was.
  let cut = null;
  if (shift < 0) {
    for (let y = 0; y < H && cut === null; y++) {
      const ys = y - shift;
      if (ys < H && !same(sa[y], sb[y]) && same(sa[y], sb[ys])) cut = y;
    }
  }
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(H / block);
  const counts = new Uint16Array(cols * rows);
  const differs = (i, j) => Math.max(Math.abs(pa[i] - pb[j]), Math.abs(pa[i + 1] - pb[j + 1]), Math.abs(pa[i + 2] - pb[j + 2])) > tolerance;
  for (let y = 0; y < H; y++) {
    const ys = y - shift;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Changed in place, and moved by the offset too.
      if (!differs(i, i)) continue;
      if (shift && ys >= 0 && ys < H && !differs(i, (ys * width + x) * 4)) continue;
      counts[Math.floor(y / block) * cols + Math.floor(x / block)] += 1;
    }
  }
  // A block changed when a few of its pixels did; its neighbours that did
  // too make one region.
  const changed = counts.map((n) => (n > 3 ? 1 : 0));
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  let blocks = 0;
  for (let i = 0; i < changed.length; i++) {
    if (!changed[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let n = 0;
    let x0 = cols;
    let y0 = rows;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const j = stack.pop();
      n += 1;
      const cx = j % cols;
      const cy = Math.floor(j / cols);
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const k = ny * cols + nx;
        if (changed[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    if (n < minBlocks) continue;
    blocks += n;
    regions.push({ x: (x0 * block) / ka, y: (y0 * block) / ka, w: ((x1 - x0 + 1) * block) / ka, h: ((y1 - y0 + 1) * block) / ka, n });
  }
  regions.sort((p, q) => q.n - p.n);
  // What was taken out: a line across where it was, first.
  if (cut !== null) regions.unshift({ x: 0, y: cut / ka, w: width / ka, h: 3, n: 0, gone: true });
  return {
    score: Math.round((10_000 * blocks) / (cols * rows)) / 10_000,
    regions: regions.slice(0, 20).map(({ n, gone, ...r }) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), ...(gone ? { gone: true } : {}) })),
    heights: { now: Math.round(ia.naturalHeight), was: Math.round(ib.naturalHeight) },
    // What came in or went out moved the rest by this much, at this photo's pixels.
    moved: shift ? Math.round(shift / ka) : 0,
  };
}

const dataUrl = (file) => `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;

/**
 * A run compared with another, written to its `changes.json` and returned.
 * `root` is the cockpit's runs (<out>/cockpit), `out` the paths its frames
 * name their photos from.
 * @param {{ config: any, root: string, run: string, against: string, say?: (line: string) => void }} o
 */
export async function compareRuns({ config, root, run, against, say = () => {} }) {
  const now = readRunFiles(path.join(root, run));
  const was = readRunFiles(path.join(root, against));
  const stepsOf = ({ frames }) => {
    const map = new Map();
    for (const f of frames) {
      if (f.kind === 'action' || f.status === 'context') continue;
      let k = `${f.test}\u0001${f.step}\u0001${f.actor}`;
      for (let i = 2; map.has(k); i++) k = `${f.test}\u0001${f.step}\u0001${f.actor}\u0001${i}`;
      map.set(k, f);
    }
    return map;
  };
  const actionsOf = ({ frames }, f) => frames.filter((a) => a.kind === 'action' && a.of === f.seq);
  const a = stepsOf(now);
  const b = stepsOf(was);
  const testsNow = new Set(now.frames.map((f) => f.test));
  const testsThen = new Set(was.frames.map((f) => f.test));
  const pairs = [];
  for (const [k, f] of a) if (b.has(k)) pairs.push([f, b.get(k)]);

  // The photos, in one page of the project's Chromium.
  const photoOf = (f) => path.join(config.paths.out, f.file);
  const jobs = [];
  for (const [f, g] of pairs) {
    jobs.push({ key: `s${f.seq}`, a: f, b: g });
    const fa = actionsOf(now, f);
    const ga = actionsOf(was, g);
    fa.forEach((x, i) => (ga[i] ? jobs.push({ key: `a${x.seq}`, a: x, b: ga[i] }) : null));
  }
  const diffs = new Map();
  if (jobs.length) {
    say(`Comparing ${jobs.length} photos with the run ${against}…`);
    const { chromium } = playwrightOf(config);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      for (const j of jobs) {
        if (!fs.existsSync(photoOf(j.a)) || !fs.existsSync(photoOf(j.b))) continue;
        try {
          diffs.set(
            j.key,
            await page.evaluate(photoDiffInPage, {
              a: dataUrl(photoOf(j.a)),
              b: dataUrl(photoOf(j.b)),
              masksA: j.a.masks ?? [],
              masksB: j.b.masks ?? [],
              width: WIDTH,
              block: BLOCK,
              tolerance: TOLERANCE,
              minBlocks: MIN_BLOCKS,
            }),
          );
        } catch {
          // A photo that cannot be read: not compared.
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const steps = [];
  for (const [k, f] of a) {
    const g = b.get(k);
    if (!g) {
      // A test the earlier run did not have is said once, below.
      if (testsThen.has(f.test)) steps.push({ test: f.test, step: f.step, actor: f.actor, seq: f.seq, was: null, kind: 'new' });
      continue;
    }
    const photo = diffs.get(`s${f.seq}`) ?? null;
    const actions = actionsOf(now, f).map((x, i) => {
      const y = actionsOf(was, g)[i] ?? null;
      const label = y && x.marks?.[0]?.label !== y.marks?.[0]?.label ? { was: y.marks?.[0]?.label ?? '', now: x.marks?.[0]?.label ?? '' } : null;
      const d = diffs.get(`a${x.seq}`) ?? null;
      return { n: i + 1, seq: x.seq, was: y?.seq ?? null, photo: d?.regions.length ? d : null, label, new: !y };
    });
    const gone = Math.max(0, actionsOf(was, g).length - actionsOf(now, f).length);
    const requests = requestsDiff(f.requests, g.requests);
    const before = new Set((g.console ?? []).map(errorKey));
    const errors = (f.console ?? []).filter((c) => !before.has(errorKey(c))).map((c) => c.text);
    const status = f.status !== g.status ? { was: g.status, now: f.status } : null;
    const changed =
      Boolean(status) ||
      Boolean(photo?.regions.length) ||
      actions.some((x) => x.photo || x.label || x.new) ||
      gone > 0 ||
      someRequests(requests) ||
      errors.length > 0;
    steps.push({
      test: f.test,
      step: f.step,
      actor: f.actor,
      seq: f.seq,
      was: g.seq,
      kind: changed ? 'changed' : 'same',
      status,
      photo: photo?.regions.length ? photo : null,
      actions: actions.filter((x) => x.photo || x.label || x.new),
      actionsGone: gone,
      requests: someRequests(requests) ? requests : null,
      errors,
    });
  }
  for (const [k, g] of b) {
    if (a.has(k) || !testsNow.has(g.test)) continue;
    steps.push({ test: g.test, step: g.step, actor: g.actor, seq: null, was: g.seq, kind: 'gone' });
  }
  const result = {
    run,
    against,
    againstKind: readMeta(root, against)?.kind ?? null,
    againstAt: readMeta(root, against)?.startedAt ?? null,
    at: new Date().toISOString(),
    tests: { onlyNow: [...testsNow].filter((t) => !testsThen.has(t)), onlyThen: [...testsThen].filter((t) => !testsNow.has(t)) },
    steps,
    summary: {
      compared: pairs.length,
      changed: steps.filter((s) => s.kind === 'changed').length,
      new: steps.filter((s) => s.kind === 'new').length,
      gone: steps.filter((s) => s.kind === 'gone').length,
    },
  };
  fs.writeFileSync(path.join(root, run, CHANGES_FILE), `${JSON.stringify(result, null, 1)}\n`);
  return result;
}

/** A run's changes as written, or null. */
export function readChanges(root, run) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, run, CHANGES_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** «T1/2 · Alice: writes …», as the summaries name a step; whose photo, when it names more than one. */
const stepName = (s) => {
  const id = /^(\S+)\s+·/.exec(s.test)?.[1];
  const named = /^\S+\s+·\s+([^:]+):/.exec(s.step)?.[1]?.trim();
  const who = s.actor && named?.toLowerCase() !== s.actor.toLowerCase() ? ` (${s.actor}'s screen)` : '';
  return `${id ? `${id}/` : `${s.test} › `}${s.step}${who}`;
};

/** What changed, in lines for a terminal and an agent. */
export function changesLines(c, photoPath = (seq) => `#${seq}`) {
  const lines = [];
  const { changed, new: added, gone, compared } = c.summary;
  lines.push(`Changes from the run ${c.against}: ${changed} of ${compared} steps compared changed${added ? `, ${added} new` : ''}${gone ? `, ${gone} gone` : ''}.`);
  for (const t of c.tests.onlyNow) lines.push(`  A test the earlier run did not have: ${t}`);
  for (const t of c.tests.onlyThen) lines.push(`  A test only the earlier run had: ${t}`);
  for (const s of c.steps) {
    if (s.kind === 'same') continue;
    if (s.kind === 'new') {
      lines.push(`  ${stepName(s)}: a new step`);
      continue;
    }
    if (s.kind === 'gone') {
      lines.push(`  ${stepName(s)}: gone (only the earlier run had it)`);
      continue;
    }
    lines.push(`  ${stepName(s)}`);
    if (s.status) lines.push(`     ${s.status.was} before, ${s.status.now} now`);
    if (s.photo) {
      const boxes = s.photo.regions.filter((r) => !r.gone);
      const out = s.photo.regions.find((r) => r.gone);
      lines.push(
        `     its photo: ${boxes.length ? `${boxes.length} region${boxes.length === 1 ? '' : 's'} changed` : 'nothing new on it'}` +
          `${out ? `, something taken out at y ${out.y}` : ''}` +
          `${s.photo.moved ? `, what is below moved ${s.photo.moved > 0 ? 'down' : 'up'} ${Math.abs(s.photo.moved)} px` : ''}` +
          `${s.photo.heights.now !== s.photo.heights.was ? `, the page ${s.photo.heights.was} → ${s.photo.heights.now} px tall` : ''}: ${photoPath(s.seq)}`,
      );
      if (boxes.length) lines.push(`       at ${boxes.slice(0, 4).map((r) => `${r.x},${r.y} ${r.w}×${r.h}`).join('; ')}${boxes.length > 4 ? '; …' : ''}`);
    }
    for (const x of s.actions ?? []) {
      if (x.new) lines.push(`     action ${x.n}: new`);
      else if (x.label) lines.push(`     action ${x.n}: «${x.label.was}» before, «${x.label.now}» now`);
      if (x.photo) lines.push(`     action ${x.n}'s photo: ${x.photo.regions.length} region${x.photo.regions.length === 1 ? '' : 's'} changed: ${photoPath(x.seq)}`);
    }
    if (s.actionsGone) lines.push(`     ${s.actionsGone} action${s.actionsGone === 1 ? '' : 's'} fewer`);
    const r = s.requests;
    if (r) {
      for (const x of r.new) lines.push(`     a new request: ${x}`);
      for (const x of r.gone) lines.push(`     a request gone: ${x}`);
      for (const x of r.status) lines.push(`     ${x.what}: ${x.was} before, ${x.now} now`);
      for (const x of r.count) lines.push(`     ${x.what}: ${x.was} call${x.was === 1 ? '' : 's'} before, ${x.now} now`);
    }
    for (const e of s.errors ?? []) lines.push(`     a page error it did not have: ${e}`);
  }
  if (!changed && !added && !gone && !c.tests.onlyNow.length && !c.tests.onlyThen.length) lines.push('  Nothing changed: every step, its photos, requests and errors, as before.');
  return lines;
}
