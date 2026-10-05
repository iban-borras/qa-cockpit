// NOTES ON THE PHOTOS: what whoever reviews a run wants the next one (a
// person, or the agent on duty) to know, each pinned to the very point of a
// photo it is about. They live with the run, in <out>/cockpit/<run>/
// notes.json, and a copy of each photo with its pins drawn goes to
// notes/<seq>.jpg: the page draws it, since the browser has the photo
// already and the package has no image library. A run with notes is kept
// past `keepRuns` (server.mjs): somebody is still working on it.
//
// A pin is a point of its photo, in CSS pixels from its top-left corner: a
// step's photo is the whole page at CSS scale, an action's the window just
// before it (worker.mjs). The copy with the pins drawn is what tells an
// agent, beyond doubt, which thing a note means; bare coordinates alone are
// easy to misread.
import fs from 'node:fs';
import path from 'node:path';

export const NOTE_ID = /^[a-z0-9-]{6,40}$/;
const MAX_TEXT = 4000;
// How near a pin must fall to an action of the step to be said to be about
// it, in the page's pixels: on it, or near it.
const ON_MARK = 20;
const NEAR_MARK = 60;

/**
 * @typedef {{ id: string, seq: number, actor: string, x: number, y: number,
 *   text: string, createdAt: string, updatedAt: string }} Note
 */

export const notesFileOf = (dir) => path.join(dir, 'notes.json');
export const pinnedFileOf = (dir, seq) => path.join(dir, 'notes', `${seq}.jpg`);

/** The photos of a run whose copy with the pins exists. */
export function pinnedSeqs(dir) {
  try {
    return fs
      .readdirSync(path.join(dir, 'notes'))
      .map((f) => /^(\d+)\.jpg$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** @returns {Note[]} */
export function readNotes(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(notesFileOf(dir), 'utf8'));
    return Array.isArray(raw.notes) ? raw.notes : [];
  } catch {
    return [];
  }
}

/** Written whole and then renamed, so a reader never finds half a file. */
export function writeNotes(dir, notes) {
  const file = notesFileOf(dir);
  if (!notes.length) return fs.rmSync(file, { force: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ notes }, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/** A note as the page sends it, checked against the run's photos, or null. */
export function cleanNote(id, body, frames, before) {
  const seq = Number(body?.seq);
  const frame = frames.find((f) => f.seq === seq);
  const x = Math.round(Number(body?.x));
  const y = Math.round(Number(body?.y));
  if (!NOTE_ID.test(id) || !frame || !(x >= 0 && x < 100_000) || !(y >= 0 && y < 100_000)) return null;
  const now = new Date().toISOString();
  return {
    id,
    seq,
    actor: frame.actor,
    x,
    y,
    text: String(body.text ?? '').slice(0, MAX_TEXT),
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Each note's number on its photo: 1, 2, 3 in the order they were pinned. */
export function numbered(notes) {
  const bySeq = new Map();
  const out = new Map();
  for (const n of [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const k = (bySeq.get(n.seq) ?? 0) + 1;
    bySeq.set(n.seq, k);
    out.set(n.id, k);
  }
  return out;
}

/** The step's actions drawn on this photo: those on the page photographed
 *  (cockpit.js, marksOf, numbers them the same way). */
function drawnMarks(frame) {
  const key = (u) => {
    try {
      const a = new URL(u);
      return a.pathname + a.search;
    } catch {
      return null;
    }
  };
  const here = key(frame.url);
  return (frame.marks ?? []).filter((m) => here !== null && key(m.url) === here);
}

/** The action of the step nearest the pin, if it is on it or near it: its
 *  number among the step's actions (in a run from before, among the marks
 *  drawn). */
export function markAt(frame, x, y) {
  let best = null;
  drawnMarks(frame).forEach((m, i) => {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d <= NEAR_MARK && (!best || d < best.d)) best = { n: m.n ?? i + 1, mark: m, d: Math.round(d) };
  });
  return best;
}

/** Whether the pin was on the person's screen when the photo was taken: an
 *  action's photo is that screen, so nothing to say. */
function onScreen(frame, y) {
  const vh = frame.viewport?.height;
  if (!vh || frame.kind === 'action') return null;
  const top = frame.scroll?.y ?? 0;
  return y < top ? 'above what was on screen' : y > top + vh ? 'below what was on screen' : 'on screen';
}

/** A run's own files, as the cockpit keeps them: run.json and frames.jsonl. */
export function readRunFiles(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const framesFile = path.join(dir, 'frames.jsonl');
  const frames = fs.existsSync(framesFile)
    ? fs
        .readFileSync(framesFile, 'utf8')
        .split('\n')
        .flatMap((l) => {
          try {
            return l ? [JSON.parse(l)] : [];
          } catch {
            return []; // a line cut short by a stop
          }
        })
    : [];
  return { meta, frames };
}

/** The runs under <out>/cockpit that have notes, newest first. */
export function runsWithNotes(cockpitDir) {
  if (!fs.existsSync(cockpitDir)) return [];
  return fs
    .readdirSync(cockpitDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && readNotes(path.join(cockpitDir, e.name)).length > 0)
    .map((e) => e.name)
    .sort()
    .reverse();
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The notes of a run as Markdown, for a person or an agent to act on: one
 * section per photo, where it is and what was there, then each pin with
 * what it falls on and its text.
 *
 * @param {{ runId: string, dir: string, frames: any[], notes: Note[],
 *   out: string, project: string, level?: number }} o
 *   `out` and `project` are the paths as shown to the reader.
 */
export function notesMarkdown({ runId, dir, frames, notes, out, project, level = 2 }) {
  const written = notes.filter((n) => n.text.trim());
  if (!written.length) return '';
  const h = '#'.repeat(level);
  const num = numbered(written);
  const lines = [
    `${h} Notes (${written.length})`,
    '',
    'Left on the photos of this run by whoever reviewed it. Each is pinned to one point of one photo, and',
    'that point is what the note is about. A position is CSS pixels from the photo\'s top-left corner: a',
    'step\'s photo is the whole page as the step left it, an action\'s photo the window just before that',
    'action. The copy «with the pins» shows each pin where it was dropped, numbered: look at it before',
    'acting on a note.',
    '',
  ];
  const seqs = [...new Set(written.map((n) => n.seq))].sort((a, b) => a - b);
  for (const seq of seqs) {
    const f = frames.find((x) => x.seq === seq);
    if (!f) continue;
    // The page draws the copy: until this run is open in a cockpit, none.
    const pinned = fs.existsSync(pinnedFileOf(dir, seq))
      ? `; with the pins: \`${out}/cockpit/${runId}/notes/${seq}.jpg\``
      : '; no copy with the pins yet (the cockpit draws it when this run is open there)';
    const d = f.device;
    const device = d ? `, ${d.name}${d.width ? ` (${d.width}×${d.height})` : ''}` : '';
    let page = f.url;
    try {
      const u = new URL(f.url);
      page = u.pathname + u.search;
    } catch {
      // The URL as it came.
    }
    // An action's photo: the window just before it, and what it was.
    const action = f.kind === 'action' ? f.marks?.[0] : null;
    const before = action ? `, just before action ${action.n ?? 1}` : '';
    const what = action ? `; the window just before action ${action.n ?? 1}: ${action.kind} «${action.label}»` : '';
    lines.push(
      `${h}# ${cap(f.actor)} · ${f.test} › ${f.step} (photo ${seq}${before})`,
      '',
      `- Photo: \`${out}/${f.file}\`${pinned}`,
      `- Page \`${page}\`${device}${f.scroll?.y ? `, scrolled down ${f.scroll.y} px` : ''}${what}`,
    );
    if (f.location) lines.push(`- Recording line: \`${project}/${f.location}\``);
    lines.push('');
    const here = written.filter((n) => n.seq === seq).sort((a, b) => num.get(a.id) - num.get(b.id));
    for (const n of here) {
      const m = markAt(f, n.x, n.y);
      const what = m
        ? `, ${m.d <= ON_MARK ? 'on' : `${m.d} px from`} action ${m.n}: ${m.mark.kind} «${m.mark.label}»`
        : '';
      const screen = onScreen(f, n.y);
      lines.push(
        `**Pin ${num.get(n.id)}** at x ${n.x}, y ${n.y}${screen ? ` (${screen})` : ''}${what}`,
        '',
        ...n.text.trim().split('\n').map((l) => `> ${l}`),
        '',
      );
    }
  }
  return lines.join('\n');
}
