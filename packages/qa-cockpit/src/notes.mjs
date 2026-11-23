// NOTES ON THE PHOTOS: what whoever reviews a run wants the next one (a
// person, or the agent on duty) to know, each pinned to the very point of a
// photo it is about. They live with the run, in <out>/cockpit/<run>/
// notes.json, and a copy of each photo with its pins drawn goes to
// notes/<seq>.jpg: the page draws it, since the browser has the photo
// already and the package has no image library. A run with notes still to
// deal with is kept past `keepRuns` (server.mjs): somebody is working on it.
//
// A note has a STATE, and a THREAD under it. Deleting a note was the only
// way to close one, and what it asked went with it (found in CritKeep,
// 2026-11-21). Now it is closed and stays on its photo, a record:
//   - open: to act on (no `state` in the file);
//   - verify: the agent says it is fixed, for the person to look at;
//   - resolved: done, as the person said;
//   - dismissed: not a fault, or so by a decision, as the person said.
// The thread is what was said about it since, oldest first: replies, by the
// person in the cockpit or by an agent (`notes reply`), and each change of
// state, with its words if any. An agent never closes a note on its own
// word; it says «verify», and a person looks.
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
 * @typedef {{ id: string, at: string, by: string, text?: string,
 *   state?: State }} Said
 *   One entry of a note's thread: a reply, a change of state, or both. `by`:
 *   'page' for the person in the cockpit, else who said it ('Claude').
 * @typedef {'open'|'verify'|'resolved'|'dismissed'} State
 * @typedef {{ id: string, seq: number, actor: string, x: number, y: number,
 *   text: string, createdAt: string, updatedAt: string,
 *   state?: Exclude<State, 'open'>, thread?: Said[] }} Note
 */

export const STATES = ['open', 'verify', 'resolved', 'dismissed'];
const CLOSED = new Set(['resolved', 'dismissed']);
const MAX_THREAD = 200;
const MAX_BY = 60;

/** A note somebody wrote: an empty one (the page keeps it until then) is not one. */
export const isWritten = (n) => Boolean(String(n?.text ?? '').trim());
/** Written and closed: resolved or dismissed. */
export const isClosed = (n) => isWritten(n) && CLOSED.has(n.state);
/** Written and not closed: open, or fixed and waiting for a person. */
export const isPending = (n) => isWritten(n) && !CLOSED.has(n.state);
/** Written and open: the agent's to act on. */
export const isOpen = (n) => isWritten(n) && !n.state;
export const stateOf = (n) => n.state ?? 'open';

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

/** A note as the page sends it, checked against the run's photos, or null.
 *  Its state and thread are not the page's to send: they stay as they were
 *  (`said` changes them), so a save as the note is typed never undoes a
 *  reply or a state an agent gave it meanwhile. */
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
    ...(before?.state ? { state: before.state } : {}),
    ...(before?.thread?.length ? { thread: before.thread } : {}),
  };
}

/**
 * The note with one more entry in its thread: a reply (`text`), a change of
 * state (`state`), or both. Null when it says nothing: no words, and the
 * state it already has.
 * @param {Note} note
 * @param {{ by?: unknown, text?: unknown, state?: unknown }} body
 * @returns {Note | null}
 */
export function said(note, body) {
  const text = String(body?.text ?? '').trim().slice(0, MAX_TEXT);
  const state = STATES.includes(body?.state) ? body.state : null;
  const moves = state !== null && state !== stateOf(note);
  if (!text && !moves) return null;
  const at = new Date().toISOString();
  const by = String(body?.by ?? '').trim().slice(0, MAX_BY) || 'page';
  const entry = {
    id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at,
    by,
    ...(text ? { text } : {}),
    ...(moves ? { state } : {}),
  };
  const next = { ...note, thread: [...(note.thread ?? []), entry].slice(-MAX_THREAD) };
  if (moves) {
    if (state === 'open') delete next.state;
    else next.state = state;
  }
  return next;
}

/** The run a note is in, by its id (unique across runs): its id and folder. */
export function findNote(cockpitDir, noteId) {
  for (const runId of runsWithNotes(cockpitDir)) {
    const dir = path.join(cockpitDir, runId);
    const note = readNotes(dir).find((n) => n.id === noteId);
    if (note) return { runId, dir, note };
  }
  return null;
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

/** The runs under <out>/cockpit that have notes, newest first; `which`
 *  (isOpen, isPending): those with one such note. */
export function runsWithNotes(cockpitDir, which = isWritten) {
  if (!fs.existsSync(cockpitDir)) return [];
  return fs
    .readdirSync(cockpitDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && readNotes(path.join(cockpitDir, e.name)).some(which))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** How many notes a run has, by state: «3 notes: 1 open, 1 to verify, 1 closed». */
export function notesTally(notes) {
  const written = notes.filter(isWritten);
  const open = written.filter(isOpen).length;
  const verify = written.filter((n) => n.state === 'verify').length;
  const closed = written.filter(isClosed).length;
  const parts = [open && `${open} open`, verify && `${verify} to verify`, closed && `${closed} closed`].filter(Boolean);
  return `${written.length} note${written.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

// FOLLOWING A NOTE into the runs after its own. A note still to deal with
// (open, to verify) is shown on the same photo of every later run of its
// suite, where whoever reviews it sees whether it still holds, and closes
// it from there. It stays one note, in its own run: what is said or done
// from a later run goes there. Conservative, so that no note lands where it
// does not belong: the same photo is the same test, step and person (the
// nth time that step came, as changes.mjs aligns them) and, for an action's
// photo, the same action (its place in the step, kind and label); nothing
// else is taken for it, and a note with no such photo is said to be missing
// rather than guessed at. A pin on or near one of the step's actions moves
// with it: the page around a note moves between runs (in CritKeep a click
// moved 41 px between a note's run and the latest, by the median).
//
// Only the notes pinned since FOLLOW_SINCE: before 0.14.0 nothing could
// close a note but deleting it, so «open» told nothing, and a project's
// earlier notes (hundreds, in CritKeep) would bury the runs after them.
export const FOLLOW_SINCE = '2026-11-21';

/** Each photo of a run by its place in the suite (see above): `keyOf`
 *  seq -> key, `frameOf` key -> photo. */
export function photoKeys(frames) {
  const keyOf = new Map();
  const frameOf = new Map();
  const seen = new Map();
  const steps = frames.filter((f) => f.kind !== 'action' && f.status !== 'context');
  for (const f of steps) {
    const base = `${f.test}\u0001${f.step}\u0001${f.actor}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const k = `${base}\u0001${n}`;
    keyOf.set(f.seq, k);
    frameOf.set(k, f);
  }
  for (const f of steps) {
    frames
      .filter((a) => a.kind === 'action' && a.of === f.seq)
      .forEach((a, i) => {
        const m = a.marks?.[0] ?? {};
        const k = `${keyOf.get(f.seq)}\u0002${i + 1}\u0002${m.kind ?? ''}\u0002${m.label ?? ''}`;
        keyOf.set(a.seq, k);
        frameOf.set(k, a);
      });
  }
  return { keyOf, frameOf };
}

/** Where a note of one run is in another: its photo there and its point,
 *  moved with the action it sits on when that action is there too; or null
 *  when the other run has no such photo. */
export function followNote(note, fromFrames, toFrames, fromKeys = photoKeys(fromFrames), toKeys = photoKeys(toFrames)) {
  const key = fromKeys.keyOf.get(note.seq);
  const there = key ? toKeys.frameOf.get(key) : null;
  if (!there) return null;
  const here = fromFrames.find((f) => f.seq === note.seq);
  const m = here ? markAt(here, note.x, note.y) : null;
  const same = m ? drawnMarks(there).find((h, i) => (h.n ?? i + 1) === m.n && h.kind === m.mark.kind && h.label === m.mark.label) : null;
  const dx = same ? same.x - m.mark.x : 0;
  const dy = same ? same.y - m.mark.y : 0;
  return { seq: there.seq, x: Math.max(0, Math.round(note.x + dx)), y: Math.max(0, Math.round(note.y + dy)), anchored: Boolean(same) };
}

// The runs a note follows into, as changes.mjs compares them: a recording
// played (a replay, a full run), not a round of a race search nor a report.
const followable = (meta) => Boolean(meta) && !meta.chaos && (!meta.kind || meta.kind === 'replay' || meta.kind === 'full');

/**
 * The notes of earlier runs of a run's suite that follow into it: `carried`,
 * each with its own run and photo there (`from`) and its photo and point
 * here; `missing`, those this run should have shown and has no photo for:
 * their test was played here, or this is a full run, which plays every
 * test (a replay of one test is no sign another is gone).
 * @returns {{ carried: { note: Note, from: any, seq: number, x: number, y: number, anchored: boolean }[], missing: { note: Note, from: any }[] }}
 */
export function carriedInto(cockpitDir, runId) {
  const none = { carried: [], missing: [] };
  let here;
  try {
    here = readRunFiles(path.join(cockpitDir, runId));
  } catch {
    return none;
  }
  if (!followable(here.meta) || !fs.existsSync(cockpitDir)) return none;
  const toKeys = photoKeys(here.frames);
  const played = new Set([...Object.keys(here.meta.tests ?? {}), ...here.frames.map((f) => f.test)]);
  const out = { carried: [], missing: [] };
  const earlier = fs
    .readdirSync(cockpitDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}/.test(e.name) && e.name < runId)
    .map((e) => e.name)
    .sort();
  for (const id of earlier) {
    const dir = path.join(cockpitDir, id);
    const notes = readNotes(dir).filter((n) => isPending(n) && String(n.createdAt ?? '') >= FOLLOW_SINCE);
    if (!notes.length) continue;
    let from;
    try {
      from = readRunFiles(dir);
    } catch {
      continue;
    }
    if (from.meta.suite !== here.meta.suite || !followable(from.meta)) continue;
    const fromKeys = photoKeys(from.frames);
    for (const note of notes) {
      const f = from.frames.find((x) => x.seq === note.seq);
      if (!f) continue;
      const origin = { run: id, startedAt: from.meta.startedAt ?? null, seq: f.seq, test: f.test, step: f.step, actor: f.actor, kind: f.kind ?? 'step' };
      const at = followNote(note, from.frames, here.frames, fromKeys, toKeys);
      if (at) out.carried.push({ note, from: origin, ...at });
      else if (played.has(f.test) || here.meta.kind === 'full') out.missing.push({ note, from: origin });
    }
  }
  return out;
}

const STATE_WORDS = { open: 'open', verify: 'to verify', resolved: 'resolved', dismissed: 'dismissed' };
const whoSaid = (by) => (by === 'page' ? 'the person, in the cockpit' : by);
// A moment as a person reads it, on this machine's clock: 2026-11-21 16:02.
const when = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const firstLine = (text) => {
  const s = text.trim().split('\n')[0];
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A note's thread as Markdown lines, oldest first: who, when, the state it
 *  was given, and what was said. */
export function threadLines(n) {
  return (n.thread ?? []).flatMap((s) => {
    const head = `- ${cap(whoSaid(s.by))}, ${when(s.at)}${s.state ? ` · ${STATE_WORDS[s.state]}` : ''}`;
    if (!s.text) return [head];
    const [first, ...more] = s.text.split('\n');
    return [`${head}: ${first}`, ...more.map((l) => `  ${l}`)];
  });
}

/** A note's state in words: open, to verify, resolved, dismissed. */
export const stateWords = (n) => STATE_WORDS[stateOf(n)];

// A REPORT FROM «PLAY AS» (play.mjs) is a run whose note is the person's
// own, on what went wrong. It has a state and a thread as a pinned note has,
// kept in its run.json beside that note (`play.state`, `play.thread`), and
// is answered, fixed and closed the same way.
/** A report's note, as a note: its words, state and thread. */
export const reportNote = (meta) => ({
  id: 'report',
  text: meta?.play?.note || 'Reported from «Play as», with no note.',
  ...(meta?.play?.state ? { state: meta.play.state } : {}),
  ...(meta?.play?.thread?.length ? { thread: meta.play.thread } : {}),
});

/** A report's run.json with one more entry in its note's thread, or null
 *  when it says nothing (said). */
export function reportSaid(meta, body) {
  const next = said(reportNote(meta), body);
  if (!next) return null;
  const play = { ...meta.play, thread: next.thread };
  if (next.state) play.state = next.state;
  else delete play.state;
  return { ...meta, play };
}

/**
 * The notes of a run as Markdown, for a person or an agent to act on: one
 * section per photo, where it is and what was there, then each pin with
 * what it falls on, its state, its text and its thread. A closed note is a
 * line, unless `all`: a record, nothing left to do.
 *
 * @param {{ runId: string, dir: string, frames: any[], notes: Note[],
 *   out: string, project: string, level?: number, all?: boolean }} o
 *   `out` and `project` are the paths as shown to the reader.
 */
export function notesMarkdown({ runId, dir, frames, notes, out, project, level = 2, all = false }) {
  const written = notes.filter(isWritten);
  if (!written.length) return '';
  const h = '#'.repeat(level);
  const num = numbered(written);
  const full = (n) => all || !isClosed(n);
  const tally = notesTally(written).replace(/^\d+ notes?/, '');
  const closed = written.filter(isClosed).length;
  const lines = [
    `${h} Notes (${written.length}${written.some((n) => n.state) ? tally : ''})`,
    '',
    'Left on the photos of this run by whoever reviewed it. Each is pinned to one point of one photo, and',
    'that point is what the note is about. A position is CSS pixels from the photo\'s top-left corner: a',
    'step\'s photo is the whole page as the step left it, an action\'s photo the window just before that',
    'action. The copy «with the pins» shows each pin where it was dropped, numbered: look at it before',
    'acting on a note.',
    '',
    'Each note has a state. Open: to act on. To verify: an agent fixed it, for the person to look at.',
    `Resolved or dismissed: closed by the person, and kept as a record${closed && !all ? ', one line each' : ''}. Under a note,`,
    'its thread: what was said about it since, oldest first. Its id (`n-…`) names it to `notes reply`.',
    '',
  ];
  const thread = threadLines;
  const line = (n) => `**Pin ${num.get(n.id)}** (${STATE_WORDS[stateOf(n)]}, \`${n.id}\`): «${firstLine(n.text)}»`;
  const seqs = [...new Set(written.filter(full).map((n) => n.seq))].sort((a, b) => a - b);
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
      if (!full(n)) {
        lines.push(line(n), '');
        continue;
      }
      const m = markAt(f, n.x, n.y);
      const what = m
        ? `, ${m.d <= ON_MARK ? 'on' : `${m.d} px from`} action ${m.n}: ${m.mark.kind} «${m.mark.label}»`
        : '';
      const screen = onScreen(f, n.y);
      const talk = thread(n);
      lines.push(
        `**Pin ${num.get(n.id)}** (${STATE_WORDS[stateOf(n)]}, \`${n.id}\`) at x ${n.x}, y ${n.y}${screen ? ` (${screen})` : ''}${what}`,
        '',
        ...n.text.trim().split('\n').map((l) => `> ${l}`),
        '',
        ...(talk.length ? ['Thread:', '', ...talk, ''] : []),
      );
    }
  }
  // The closed notes on photos with nothing else to do: a line each.
  const rest = written.filter((n) => !full(n) && !seqs.includes(n.seq));
  if (rest.length) {
    lines.push(`${h}# Closed (${rest.length})`, '');
    for (const n of rest.sort((a, b) => a.seq - b.seq || num.get(a.id) - num.get(b.id))) {
      const f = frames.find((x) => x.seq === n.seq);
      lines.push(`- ${line(n)} on photo ${n.seq}${f ? ` (${cap(f.actor)} · ${f.test} › ${f.step})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The notes that follow into a run from earlier ones (carriedInto), as
 * Markdown: where each is in this run, and where it was pinned. Each is the
 * note of its own run, printed whole there; what is said under it goes
 * there too.
 * @param {{ carried: any[], missing: any[], level?: number }} o
 */
export function carriedMarkdown({ carried, missing, level = 2 }) {
  if (!carried.length && !missing.length) return '';
  const h = '#'.repeat(level);
  const where = (c) => `${cap(c.from.actor)} · ${c.from.test} › ${c.from.step}, photo ${c.from.seq} of the run ${c.from.run}`;
  const lines = [
    `${h} From earlier runs (${carried.length + missing.length})`,
    '',
    'Notes pinned on an earlier run of this suite and still to deal with (open, or to verify). Each is the',
    'note of its own run (`notes <run>` prints it whole, with its photo and the copy with the pins), and',
    'what you say under it goes there. Here it sits on the same photo: the same test, step and person',
    '(and action). The page may have moved since: a pin on an action moves with it; any other stays where',
    'it was on the old photo. Look at this run\'s photo before saying it holds or not.',
    '',
  ];
  for (const c of carried) {
    lines.push(
      `- \`${c.note.id}\` (${STATE_WORDS[stateOf(c.note)]}): «${firstLine(c.note.text)}»`,
      `  Here on photo ${c.seq}, at x ${c.x}, y ${c.y}${c.anchored ? ' (moved with the action it is on)' : ''}. Pinned on ${where(c)}.`,
    );
  }
  for (const m of missing) {
    lines.push(
      `- \`${m.note.id}\` (${STATE_WORDS[stateOf(m.note)]}): «${firstLine(m.note.text)}»`,
      `  **Not in this run:** it has no such photo (the step or the test changed, or is gone). Pinned on ${where(m)}.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
