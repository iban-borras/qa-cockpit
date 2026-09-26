// The cockpit's page. The server is the source of truth (GET /api/state,
// then server-sent events); this file only draws it, in the reader's
// language (i18n.js).
//
// What is on screen is always the suite that is picked:
//   - the PICKER lists every suite with whether it can run, what it tests
//     and who plays in it; picking one shows its newest run, or its cast
//     waiting when it never ran;
//   - the TABLE: one card per person, and a timeline over every step of the
//     run; scrubbing it shows everybody's screen at that moment;
//   - the INSPECTOR of one person: their steps, their photos, and their
//     browser LIVE while the run goes (an MJPEG stream the server relays);
//   - the TRACE of a test, Playwright's own viewer, for every click.

import { LANGS, applyI18n, getLang, locale, preferLang, setGlobals, setLang, t } from './i18n.js';

const $ = (id) => document.getElementById(id);

// Lucide icons, inlined: no emoji, no CDN.
const ICONS = {
  // The kinds of device a person plays on (devices.mjs): an allegory on the
  // card, never the device's outline (Iban, 2026-09-26).
  dev_phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  dev_tablet: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><line x1="12" x2="12.01" y1="18" y2="18"/>',
  dev_laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  dev_desktop: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  first: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
  last: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  listChecks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const withIcon = (el, name, text = '') => (el.innerHTML = icon(name) + (text ? `<span>${esc(text)}</span>` : ''));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const hhmmss = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale(), { hour12: false }) : '');
const when = (iso) =>
  iso ? new Date(iso).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const pathOf = (url) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url || '';
  }
};
const testShort = (t) => (t === 'Sessions' ? 'S' : String(t ?? '').split(' · ')[0].split(':')[0].trim().slice(0, 6));
const stepShort = (s) => {
  const head = String(s ?? '').split(' · ')[0].trim();
  return /^[\w]{1,4}$/.test(head) && head !== s ? head : '';
};
const frameLabel = (f) => [testShort(f.test), stepShort(f.step)].filter(Boolean).join('·');
const stepText = (f) => (stepShort(f.step) ? f.step.slice(f.step.indexOf(' · ') + 3) : f.step);
const frameUrl = (f) => `/out/${f.file}`;

// A person's device: the one of the photo on screen (a suite may put them on
// another than their usual one), else the usual one the config gives them.
const deviceOf = (p, f) => f?.device ?? p?.device ?? null;
const deviceHtml = (d) =>
  d
    ? `<span class="dev" data-tip="${esc(`${d.name}${d.width ? ` · ${d.width}×${d.height}` : ''}`)}">${icon(`dev_${d.kind}` in ICONS ? `dev_${d.kind}` : 'dev_desktop', 'sm')}${esc(d.name)}</span>`
    : '';
const lastDeviceOf = (actor) => S.frames.findLast((f) => f.actor === actor && f.device)?.device ?? S.state?.cast.find((c) => c.id === actor)?.device ?? null;

/** Under a card's name: the device on a line of its own, then the badge and
 *  the email (Iban, 2026-09-26: no line starting with a separator). */
function whoLines(p, f) {
  const d = deviceOf(p, f);
  const rest = [p.badge, p.email].filter(Boolean).map(esc).join(' · ');
  return `${d ? `<span>${deviceHtml(d)}</span>` : ''}${rest ? `<span>${rest}</span>` : ''}`;
}

/** The inspector's subtitle: the device on a line of its own, then the
 *  suite and the badge. Never a line that starts with a separator. */
function insSubHtml(actor) {
  const p = S.state.cast.find((c) => c.id === actor);
  const d = lastDeviceOf(actor);
  const rest = [S.run?.suite ?? S.suite ?? '', p?.badge ?? ''].filter(Boolean).map(esc).join(' · ');
  return `${d ? `<span class="line">${deviceHtml(d)}</span>` : ''}${rest ? `<span class="line">${rest}</span>` : ''}`;
}

// The card shows what the person had on screen: their whole viewport, fitted
// into the card (16:9) and centred, so a laptop fills it and a phone stands
// in the middle, every card the same size. The photo is the whole page (at
// CSS scale), so it is scaled and moved to that window; the page's width is
// taken as the viewport's.
function viewportStyle(f) {
  const vp = f.viewport;
  if (!vp?.width || !vp?.height) return '';
  const k = Math.min(1 / vp.width, 0.5625 / vp.height); // the card's width is 1
  const sx = f.scroll?.x ?? 0;
  const sy = f.scroll?.y ?? 0;
  const left = ((1 - vp.width * k) / 2 - sx * k) * 100;
  const top = ((1 - (vp.height * k) / 0.5625) / 2 - (sy * k) / 0.5625) * 100;
  return `width:${(vp.width * k * 100).toFixed(3)}%;left:${left.toFixed(3)}%;top:${top.toFixed(3)}%`;
}

/** A duration as a person reads it: «0,4 s», «12 s», «2 min 05 s». */
function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  if (s < 60) return `${Math.floor(s)} s`;
  return `${Math.floor(s / 60)} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
}
// A step this long is worth a look: it is painted amber in the inspector.
const SLOW_STEP_MS = 10_000;

// ---------------------------------------------------------------- state

const S = {
  state: null,
  suite: null, // the suite picked: what the page shows
  viewRunId: null, // null: follow the newest run of the picked suite
  log: { run: null, loading: null }, // the run whose log the box shows; lines that came while it loaded
  run: null, // the run shown: summary
  frames: [],
  moments: [],
  table: { live: true, idx: 0 },
  acting: new Set(),
  ins: null, // { actor, idx, live, fresh, timer, zoom, placed }
  picker: { open: false, active: 0, query: '', hideNoSetup: false },
  runPick: { open: false, active: 0 },
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.code ? t(`err.${body.code}`, body.params ?? {}) : body.error || `HTTP ${r.status}`);
    throw e;
  }
  return body;
}

async function act(action, extra = {}) {
  try {
    const res = await api('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, suite: S.suite, headed: $('optHeaded').checked, docker: $('optDocker').checked, ...extra }),
    });
    if (res.ok === false) banner(res.error, 'err');
    else if (res.warning) banner(desktopText(res.warning), 'warn');
    return res;
  } catch (e) {
    banner(e.message, 'err');
    return { ok: false, error: e.message };
  }
}

function banner(text, kind = 'warn') {
  const b = $('banner');
  if (!text) {
    b.hidden = true;
    return;
  }
  b.className = `banner ${kind}`;
  b.innerHTML = `${icon('alert')}<div>${esc(text)}</div><button class="btn icon ghost x" aria-label="${esc(t('banner.hide'))}">${icon('x')}</button>`;
  b.querySelector('.x').onclick = () => (b.hidden = true);
  b.hidden = false;
}

const desktopText = (w) => (w && typeof w === 'object' ? t(`err.${w.code}`, w) : w);

// ---------------------------------------------------------------- suites

// Where a suite stands for whoever wants to use it. Without a setup it is
// not usable at all, recorded or not; with one and no recording it can be
// set up and played by hand («Jugar com a»).
const STANDING_ORDER = ['ready', 'stale', 'unrecorded', 'nosetup'];
const standing = (s) => (!s.setup ? 'nosetup' : s.status);

/** The tags of a suite: what it is, or each thing it lacks. */
function tagsOf(s, { running: withRunning = false } = {}) {
  const tags = [];
  // The suite running now, the cockpit's own run or a terminal's it follows:
  // first, and alive, in the picker. Not at the head of the suite's panel,
  // where the run's own chip right under it already says so.
  const task = S.state?.task;
  const running =
    withRunning && task?.suite === s.name
      ? `<span class="chip accent live"><span class="dot"></span>${esc(t('status.running'))}${task.who ? ` · ${esc(task.who)}` : ''}</span>`
      : '';
  if (s.status === 'ready') tags.push(['ok', 'status.ready']);
  if (s.status === 'stale') tags.push(['warn', 'status.stale']);
  if (!s.recorded) tags.push(['', 'status.unrecorded']);
  if (!s.setup) tags.push(['err', 'status.nosetup']);
  return running + tags.map(([cls, key]) => `<span class="chip ${cls}">${esc(t(key))}</span>`).join('');
}

const suiteOf = (name) => S.state?.suites.find((s) => s.name === name) ?? null;
const runsOf = (name) => (S.state?.runs ?? []).filter((r) => r.suite === name);

function kindLabel(r) {
  if (!r) return '';
  if (!r.kind) return r.label ?? r.id;
  // A run launched from a terminal says whose it is.
  return `${t(`kind.${r.kind}`)}${r.docker ? ` ${t('kind.docker')}` : ''}${r.who ? ` · ${r.who}` : ''}`;
}

function defaultSuite() {
  const kept = localStorageGet('suite');
  if (kept && suiteOf(kept)) return kept;
  return (S.state.suites.find((s) => s.status === 'ready') ?? S.state.suites[0])?.name ?? null;
}

/** Pick a suite: the page now shows it, at its newest run if it has one. */
async function pickSuite(name) {
  if (!suiteOf(name)) return;
  S.suite = name;
  localStorageSet('suite', name);
  S.viewRunId = null;
  if (S.ins) closeInspector();
  closePicker();
  await viewRun(runsOf(name)[0]?.id ?? null);
}

function renderSuitePanel() {
  const s = suiteOf(S.suite);
  $('suitePanel').hidden = !s;
  if (!s) return;
  $('suiteTitle').textContent = s.title;
  $('suiteStatus').innerHTML = tagsOf(s);
  $('suiteSummary').textContent = s.summary;
  $('suiteWhy').textContent = t(`status.${s.status}_why`);
  renderTodo(s);
  $('suiteTests').textContent = t('suite.tests', { n: s.tests });
  $('suiteCast').innerHTML = s.cast
    .map((p) => `<span class="avatar" title="${esc(cap(p))}">${esc(p[0])}</span>`)
    .join('');
  $('suiteLast').textContent = s.lastPass ? t('suite.last_pass', { date: s.lastPass.date, result: s.lastPass.result }) : t('suite.no_pass');
  const last = runsOf(s.name)[0];
  $('suiteRun').textContent = last ? t('suite.last_run', { when: when(last.startedAt), status: t(`run.${last.status}`).toLowerCase() }) : '';
  $('suiteBrief').textContent = [$('suiteTests').textContent, $('suiteRun').textContent].filter(Boolean).join(' · ');

  const btn = $('pickerBtn');
  $('pickerDot').className = `sdot ${standing(s)}`;
  $('pickerName').textContent = s.title;
  btn.title = [s.name, ...[...$('suiteStatus').children].map((c) => c.textContent)].join(' · ');
}

/**
 * A suite that cannot run says, in plain sight, what it lacks, which buttons
 * that leaves dead, and the words to hand an agent: a tooltip on a disabled
 * button is where nobody looks.
 */
function renderTodo(s) {
  const ready = s.status === 'ready';
  $('suiteWhy').hidden = !ready;
  $('suiteTodo').hidden = ready;
  if (ready) return;
  // Set up and not recorded: nothing replays it, but a person can play it
  // now. The cockpit is enough for that, so the notice says so first, short
  // and green, and what an agent would do folds away under it.
  const hand = standing(s) === 'unrecorded';
  $('suiteTodo').classList.toggle('soft', hand);
  $('suiteTodoIcon').innerHTML = icon(hand ? 'hand' : 'info', 'lg');
  $('suiteTodoTitle').textContent = t(hand ? 'todo.hand_title' : 'todo.title');
  $('suiteTodoLead').hidden = !hand;
  $('suiteTodoLead').textContent = hand ? t('todo.hand_lead') : '';
  $('suiteTodoMoreSum').textContent = t('todo.more');
  if (renderTodo.shown !== s.name) {
    renderTodo.shown = s.name;
    $('suiteTodoMore').open = !hand;
  }
  const withFile = (key, file) => esc(t(key, { file: '' })).replace('', `<code>${esc(file)}</code>`);
  const lacks = [];
  const recording = `${S.state.paths.recordings}/${s.name}${S.state.recordingExt}`;
  if (!s.recorded) lacks.push(withFile('todo.no_recording', recording));
  if (s.status === 'stale') lacks.push(withFile('todo.stale', recording));
  if (!s.setup) lacks.push(withFile('todo.no_setup', `${S.state.paths.setups}/${s.name}${S.state.setupExt}`));
  $('suiteTodoList').innerHTML = lacks.map((l) => `<li>${l}</li>`).join('');

  const off = [
    [!s.setup, 'btn.setup'],
    [!s.recorded, 'btn.replay'],
    [!s.recorded || !s.setup, 'btn.full'],
  ]
    .filter(([dead]) => dead)
    .map(([, key]) => t(key));
  $('suiteTodoOff').hidden = off.length === 0;
  $('suiteTodoOff').textContent = off.length
    ? t(off.length === 1 ? 'todo.off_one' : 'todo.off_other', {
        buttons: new Intl.ListFormat(locale(), { type: 'conjunction' }).format(off),
      })
    : '';

  const prompt = s.status === 'stale' ? 'todo.prompt_stale' : s.recorded ? 'todo.prompt_setup' : 'todo.prompt_record';
  $('suiteTodoAsk').textContent = t('todo.ask');
  $('suiteTodoPrompt').textContent = t(prompt, { suite: s.name });
  if (!$('suiteTodoCopy').dataset.copied) withIcon($('suiteTodoCopy'), 'copy', t('todo.copy'));
}

$('suiteTodoCopy').onclick = async () => {
  const btn = $('suiteTodoCopy');
  await navigator.clipboard.writeText($('suiteTodoPrompt').textContent);
  btn.dataset.copied = '1';
  withIcon(btn, 'check', t('todo.copied'));
  setTimeout(() => {
    delete btn.dataset.copied;
    withIcon(btn, 'copy', t('todo.copy'));
  }, 2000);
};

// ---------------------------------------------------------------- language

// Each language by its own name, and under it the name in the one in use.
const ENDONYM = { ca: 'Català', es: 'Castellano', en: 'English' };

function renderLang() {
  const cur = getLang();
  const btn = $('langBtn');
  btn.innerHTML = `${icon('languages')}<span class="code">${cur.toUpperCase()}</span>${icon('down', 'sm')}`;
  btn.setAttribute('aria-label', `${t('lang.label')}: ${ENDONYM[cur]}`);
  $('langMenu').innerHTML = LANGS.map(
    (l) => `<button type="button" class="lang-item" data-lang="${l}" lang="${l}" aria-current="${l === cur}">
      <span class="badge">${l.toUpperCase()}</span>
      <span><b>${esc(ENDONYM[l])}</b>${l === cur ? '' : `<span class="sub" lang="${cur}">${esc(t(`lang.${l}`))}</span>`}</span>
      ${l === cur ? icon('check', 'tick') : '<span></span>'}
    </button>`,
  ).join('');
}

function changeLang(next) {
  setLang(next);
  labelButtons();
  renderLang();
  renderAll();
  if (S.ins) {
    const p = S.state.cast.find((c) => c.id === S.ins.actor);
    $('insSub').innerHTML = insSubHtml(S.ins.actor);
    withIcon($('insPlayAs'), 'external', t('card.play_as', { name: cap(S.ins.actor) }));
  }
}

$('langMenu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-lang]');
  if (!item) return;
  $('lang').open = false;
  if (item.dataset.lang !== getLang()) changeLang(item.dataset.lang);
  $('langBtn').focus();
});
$('lang').addEventListener('toggle', () => {
  if ($('lang').open) $('langMenu').querySelector('[aria-current="true"]')?.focus();
});
$('lang').addEventListener('keydown', (e) => {
  if (!$('lang').open) return;
  if (e.key === 'Escape') {
    $('lang').open = false;
    $('langBtn').focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = [...$('langMenu').querySelectorAll('.lang-item')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  } else return;
  e.preventDefault();
});

function pickerItems() {
  const q = S.picker.query.trim().toLowerCase();
  const all = (S.state?.suites ?? []).filter(
    (s) => (!q || `${s.title} ${s.name} ${s.summary}`.toLowerCase().includes(q)) && (s.setup || !S.picker.hideNoSetup),
  );
  return STANDING_ORDER.flatMap((st) => all.filter((s) => standing(s) === st));
}

function renderPicker() {
  const items = pickerItems();
  S.picker.active = Math.max(0, Math.min(items.length - 1, S.picker.active));
  let html = '';
  let group = null;
  items.forEach((s, i) => {
    if (standing(s) !== group) {
      group = standing(s);
      const n = items.filter((x) => standing(x) === group).length;
      html += `<div class="picker-group">${esc(t(`picker.${group}`))} <span class="count">${n}</span></div>`;
    }
    const last = runsOf(s.name)[0];
    const meta = [
      t('suite.tests', { n: s.tests }),
      s.cast.map(cap).join(', '),
      last ? t('suite.last_run', { when: when(last.startedAt), status: t(`run.${last.status}`).toLowerCase() }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    html += `<div class="picker-item ${standing(s)}${i === S.picker.active ? ' active' : ''}" role="option" id="opt-${esc(s.name)}" data-name="${esc(s.name)}" aria-selected="${s.name === S.suite}">
      <span class="sdot ${standing(s)}"></span>
      <span><span class="t">${esc(s.title)}</span> <span class="slug">${esc(s.name)}</span></span>
      <span class="tags">${tagsOf(s, { running: true })}</span>
      <span class="d">${esc(s.summary)}</span>
      <span class="m">${esc(meta)}</span>
    </div>`;
  });
  $('pickerList').innerHTML = html || `<p class="picker-empty">${esc(t('picker.empty'))}</p>`;
  const active = items[S.picker.active];
  $('pickerSearch').setAttribute('aria-activedescendant', active ? `opt-${active.name}` : '');
  $('pickerList').querySelector('.picker-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openPicker() {
  S.picker.open = true;
  S.picker.query = '';
  $('pickerSearch').value = '';
  const items = pickerItems();
  S.picker.active = Math.max(0, items.findIndex((s) => s.name === S.suite));
  $('pickerPop').hidden = false;
  $('pickerBtn').setAttribute('aria-expanded', 'true');
  renderPicker();
  $('pickerSearch').focus();
}

function closePicker() {
  if (!S.picker.open) return;
  S.picker.open = false;
  $('pickerPop').hidden = true;
  $('pickerBtn').setAttribute('aria-expanded', 'false');
}

$('pickerBtn').onclick = () => (S.picker.open ? closePicker() : openPicker());
S.picker.hideNoSetup = localStorageGet('hideNoSetup') === '1';
$('pickerHide').checked = S.picker.hideNoSetup;
$('pickerHide').onchange = () => {
  S.picker.hideNoSetup = $('pickerHide').checked;
  localStorageSet('hideNoSetup', S.picker.hideNoSetup ? '1' : '0');
  S.picker.active = 0;
  renderPicker();
};
$('pickerSearch').oninput = (e) => {
  S.picker.query = e.target.value;
  S.picker.active = 0;
  renderPicker();
};
$('pickerSearch').onkeydown = (e) => {
  const items = pickerItems();
  if (e.key === 'ArrowDown') S.picker.active = Math.min(items.length - 1, S.picker.active + 1);
  else if (e.key === 'ArrowUp') S.picker.active = Math.max(0, S.picker.active - 1);
  else if (e.key === 'Enter') return items[S.picker.active] && void pickSuite(items[S.picker.active].name);
  else if (e.key === 'Escape') {
    closePicker();
    return $('pickerBtn').focus();
  } else return;
  e.preventDefault();
  renderPicker();
};
$('pickerList').addEventListener('click', (e) => {
  const item = e.target.closest('[data-name]');
  if (item) void pickSuite(item.dataset.name);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#picker')) closePicker();
  if (!e.target.closest('#runPicker')) closeRunPick();
  if (!e.target.closest('#opts')) $('opts').open = false;
  if (!e.target.closest('#lang')) $('lang').open = false;
});

// ---------------------------------------------------------------- runs and moments

function buildMoments() {
  const out = [];
  for (const f of S.frames) {
    const key = `${f.test}\u0001${f.step}`;
    let m = out[out.length - 1];
    if (!m || m.key !== key) {
      m = { key, test: f.test, step: f.step, lastSeq: f.seq, actors: new Set(), failed: false };
      out.push(m);
    }
    m.lastSeq = f.seq;
    if (f.status !== 'context') m.actors.add(f.actor);
    if (f.status === 'failed') m.failed = true;
  }
  S.moments = out;
}

async function viewRun(id) {
  if (!id) {
    S.run = null;
    S.frames = [];
  } else {
    const r = await api(`/api/runs/${encodeURIComponent(id)}`);
    const { frames, ...summary } = r;
    S.run = summary;
    S.frames = frames;
  }
  buildMoments();
  S.table.live = true;
  renderAll();
  await loadRunLog(id);
}

// ---------------------------------------------------------------- the log of the run on screen

/** The log box shows the run on screen, as the table does: read from the
 *  run's own file, then its lines as they come. Lines that arrive while
 *  the file is on its way wait, and only the newer ones follow it. */
async function loadRunLog(id) {
  S.log = { run: id, loading: [] };
  $('logBox').innerHTML = '';
  renderLogWhat();
  let lines = [];
  if (id) {
    try {
      lines = await api(`/api/runs/${encodeURIComponent(id)}/log`);
    } catch {
      lines = [];
    }
  }
  if (S.log.run !== id) return; // another run was put on screen meanwhile
  const waiting = S.log.loading ?? [];
  S.log.loading = null;
  $('logBox').innerHTML = '';
  lines.forEach(logLine);
  const last = lines.at(-1)?.time ?? '';
  for (const entry of waiting) if (entry.time > last) logLine(entry);
}

/** A line from the server: the run on screen's, or the first line of a new
 *  run of the suite being followed (the box starts over with it). A line of
 *  no run (a reset on its own) is context while following; another suite's
 *  run is not this page's business. */
function onLogLine(entry) {
  const following = S.viewRunId === null;
  if (entry.run && entry.run !== S.log.run) {
    if (!following || entry.suite !== S.suite) return;
    S.log = { run: entry.run, loading: null };
    $('logBox').innerHTML = '';
    renderLogWhat();
  } else if (!entry.run && !following) return;
  if (S.log.loading) S.log.loading.push(entry);
  else logLine(entry);
}

/** Whose log it is, in the box's header. */
function renderLogWhat() {
  const r = S.log.run ? ((S.run?.id === S.log.run ? S.run : null) ?? runsOf(S.suite).find((x) => x.id === S.log.run) ?? S.state?.run) : null;
  $('logWhat').textContent = r && r.id === S.log.run ? `${kindLabel(r)} · ${when(r.startedAt)}` : '';
}

function isRunning() {
  return Boolean(S.state?.task) && S.run && S.state?.run && S.run.id === S.state.run.id && S.run.status === 'running';
}

// ---------------------------------------------------------------- header, status

// THE FAVICON WAVES WHILE A RUN GOES (Iban, 2026-09-26: «en un navegador
// multipestanya es podria saber quan està executant-se un test»). Four
// frames of the favicon's octopus, each leg rising in turn after the one
// before it, swapped while the cockpit runs or follows a run; the still
// favicon.svg otherwise. The frames are made from favicon.svg itself, so a
// new favicon waves too. The beat comes from a worker: a background tab's
// own timers are slowed to a tick a second, and a background tab is the
// very one whose favicon is being looked at.
const WAVE_MS = 100;
let waveFrames = null;
let waveTimer = null; // the worker that beats while the favicon waves

async function makeWaveFrames() {
  const svg = await fetch('favicon.svg').then((r) => r.text());
  const legs = [...svg.matchAll(/<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)" stroke="(#[0-9a-fA-F]+)"\/>/g)];
  if (legs.length === 0) return [];
  return [0, 1, 2, 3].map((k) => {
    let drawn = svg;
    legs.forEach((m, i) => {
      const [sx, sy, ex, ey] = m.slice(1, 5).map(Number);
      const phase = (2 * Math.PI * (k - i)) / 4;
      const lift = -2 * (1 - Math.cos(phase)); // 0 at rest, up to 4 units up
      const bend = 3 * Math.sin(phase); // the leg sways as it rises
      const cx = (sx + ex) / 2 + bend;
      const cy = (sy + ey) / 2;
      drawn = drawn.replace(m[0], `<path d="M${sx} ${sy} Q${cx.toFixed(2)} ${cy} ${(ex + bend / 2).toFixed(2)} ${(ey + lift).toFixed(2)}" stroke="${m[5]}"/>`);
    });
    return `data:image/svg+xml,${encodeURIComponent(drawn)}`;
  });
}

async function waveFavicon(on) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (on && !waveTimer) {
    waveFrames ??= await makeWaveFrames().catch(() => []);
    if (!waveFrames.length || waveTimer) return;
    let k = 0;
    const beat = new Blob([`setInterval(() => postMessage(0), ${WAVE_MS});`], { type: 'text/javascript' });
    waveTimer = new Worker(URL.createObjectURL(beat));
    waveTimer.onmessage = () => {
      k = (k + 1) % waveFrames.length;
      link.href = waveFrames[k];
    };
  } else if (!on && waveTimer) {
    waveTimer.terminate();
    waveTimer = null;
    link.href = 'favicon.svg';
  }
}

function renderHeader() {
  const st = S.state;
  if (!st) return;
  void waveFavicon(Boolean(st.task));
  const chip = $('stackChip');
  chip.className = `chip ${st.stack.up ? 'ok' : 'err'}`;
  chip.innerHTML = `<span class="dot"></span>${esc(t(st.stack.up ? 'stack.up' : 'stack.down', { p: st.project }))}`;
  const { front, back } = st.stack;
  $('stackSub').textContent = !front ? t('stack.sub_down') : back && back !== front ? t('stack.sub', { front, back }) : t('stack.sub_app', { front });
  // The stack taken from outside the cockpit (a terminal's run, lib/lock.mjs):
  // who, and in the tooltip what and since when. The cockpit's own task has
  // its own pill.
  const other = busyElsewhere();
  $('busyChip').hidden = !other;
  if (other) $('busyChip').innerHTML = `<span class="dot"></span>${esc(t('busy.chip', { who: other.who }))}`;
  refreshTip();
  renderSuitePanel();
  updateButtons();
  if (st.desktopWarning) banner(desktopText(st.desktopWarning), 'warn');
  $('optHeaded').disabled = Boolean(st.desktopWarning);
}

/** Who holds the stack when it is not the cockpit's own task, or null. */
const busyElsewhere = () => (S.state?.lock && !S.state.lock.mine ? S.state.lock : null);
const hhmm = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function updateButtons() {
  const st = S.state;
  if (!st) return;
  const s = suiteOf(S.suite);
  const other = busyElsewhere();
  const busy = Boolean(st.task) || Boolean(other);
  $('btnReset').disabled = busy || !st.stack.up;
  $('btnSetup').disabled = busy || !st.stack.up || !s?.setup;
  $('btnReplay').disabled = busy || !st.stack.up || !s?.recorded;
  $('btnFull').disabled = busy || !st.stack.up || !s?.recorded || !s?.setup;
  $('btnFull').hidden = Boolean(st.task);
  // A terminal's run is followed, not owned: it stops in its terminal.
  $('btnStop').hidden = !st.task || Boolean(st.task.external);
  // One primary: the whole run when there is a recording, the setup when
  // the suite is only played by hand.
  $('btnFull').classList.toggle('primary', Boolean(s?.recorded && s?.setup));
  $('btnSetup').classList.toggle('primary', Boolean(s?.setup && !s?.recorded));
  $('btnReset').dataset.tip = t('btn.reset_title');
  $('btnSetup').dataset.tip = t(s?.setup ? 'btn.setup_title' : 'btn.setup_none');
  $('btnReplay').dataset.tip = t(s?.recorded ? 'btn.replay_title' : 'btn.replay_none');
  // A button that cannot be pressed says why: the suite's own status.
  $('btnFull').dataset.tip = s && s.status !== 'ready' ? t(`status.${s.status}_why`) : t('btn.full_title');
  // Or that somebody else has the stack: one run at a time, and who.
  for (const id of ['btnReset', 'btnSetup', 'btnReplay', 'btnFull']) {
    if (other) $(id).dataset.tipKind = 'busy';
    else delete $(id).dataset.tipKind;
  }
  refreshTip();
}

// ---------------------------------------------------------------- tooltips

/** The page's own tooltip, in place of the browser's `title`: it comes at
 *  once (the browser waits about a second), it can be laid out, and the
 *  keyboard's focus shows it too. An element gives its words in `data-tip`,
 *  or names a builder of TIPS in `data-tip-kind` (which falls back on
 *  `data-tip` when it has nothing to say). Disabled buttons still get
 *  pointer events, so a dead button can say why. */
const TIP_DELAY_MS = 120;
const TIPS = {
  busy() {
    const b = busyElsewhere();
    if (!b) return null;
    const mins = Math.max(0, Math.round((Date.now() - new Date(b.since).getTime()) / 60_000));
    return `<div class="tip-head"><span class="dot"></span>${esc(t('busy.chip', { who: b.who }))}</div>
      <dl class="tip-rows">
        <dt>${esc(t('busy.doing'))}</dt><dd><code>${esc(b.command)}</code></dd>
        <dt>${esc(t('busy.since'))}</dt><dd>${esc(hhmm(b.since))} · ${esc(t('busy.ago', { n: mins }))}</dd>
      </dl>
      <div class="tip-foot">${esc(t('busy.one'))}</div>`;
  },
};
let tipFor = null;
let tipTimer = null;
const TIP_TARGET = '[data-tip], [data-tip-kind]';

function tipHtml(el) {
  const built = el.dataset.tipKind ? TIPS[el.dataset.tipKind]?.() : null;
  if (built) return built;
  if (el.dataset.tip && el.dataset.tip.trim() === el.textContent.trim() && el.scrollWidth <= el.clientWidth) return null;
  return el.dataset.tip ? `<div class="tip-text">${esc(el.dataset.tip)}</div>` : null;
}

function showTip(el) {
  const html = tipHtml(el);
  if (!html || !el.isConnected || el.closest('[hidden]')) return hideTip();
  const tip = $('tip');
  // An open modal (the inspector) is drawn over everything else: a tooltip
  // for something inside it lives inside it too.
  const host = el.closest('dialog[open]') ?? document.body;
  if (tip.parentElement !== host) host.appendChild(tip);
  tip.innerHTML = html;
  tip.hidden = false;
  // Under the element, or over it when the window has no room below; the
  // arrow keeps pointing at the element when the box is pushed in.
  const r = el.getBoundingClientRect();
  const gap = 8;
  const above = r.bottom + gap + tip.offsetHeight > innerHeight - 8 && r.top - gap - tip.offsetHeight > 8;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${above ? r.top - gap - tip.offsetHeight : r.bottom + gap}px`;
  tip.style.setProperty('--arrow-x', `${r.left + r.width / 2 - left}px`);
  tip.dataset.side = above ? 'top' : 'bottom';
  if (tipFor && tipFor !== el) tipFor.removeAttribute('aria-describedby');
  tipFor = el;
  el.setAttribute('aria-describedby', 'tip');
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  tipFor?.removeAttribute('aria-describedby');
  tipFor = null;
  $('tip').hidden = true;
}

/** The words may change under an open tooltip (the stack freed, a run
 *  started): it is drawn again, or closed when it has nothing left. */
function refreshTip() {
  if (tipFor) showTip(tipFor);
}

document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.(TIP_TARGET) ?? null;
  if (el === tipFor) return;
  clearTimeout(tipTimer);
  if (!el) return hideTip();
  // From one tooltip to the next, at once: the hand is already reading.
  tipTimer = setTimeout(() => showTip(el), tipFor ? 0 : TIP_DELAY_MS);
});
document.addEventListener('pointerout', (e) => {
  if (!e.relatedTarget) hideTip();
});
document.addEventListener('pointerdown', hideTip);
document.addEventListener('focusin', (e) => {
  const el = e.target.closest?.(TIP_TARGET);
  if (el && el.matches(':focus-visible')) showTip(el);
});
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tipFor) hideTip();
});
window.addEventListener('scroll', hideTip, { capture: true, passive: true });
window.addEventListener('resize', hideTip);

/** Every `title` of the page becomes one of these tooltips, the moment it
 *  appears: written in the HTML, set by code, filled in from a language
 *  (`data-i18n-title`) or in a card drawn later. The browser's own would
 *  come a second late, bare, and on top of ours. */
function adoptTitle(el) {
  const text = el.getAttribute('title');
  el.removeAttribute('title');
  if (text) el.dataset.tip = text;
  else delete el.dataset.tip;
  if (el === tipFor) refreshTip();
}
function adoptTitles(root) {
  if (root.hasAttribute?.('title')) adoptTitle(root);
  for (const el of root.querySelectorAll?.('[title]') ?? []) adoptTitle(el);
}
new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === 'attributes') {
      if (r.target.hasAttribute('title')) adoptTitle(r.target);
    } else for (const n of r.addedNodes) if (n.nodeType === 1) adoptTitles(n);
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
adoptTitles(document.body);

const STATUS_CHIP = {
  running: 'accent live',
  passed: 'ok',
  failed: 'err',
  stopped: 'warn',
  interrupted: 'warn',
};

function renderStatus() {
  const st = S.state;
  const r = S.run;
  renderLogWhat();
  $('runReport').hidden = !r;
  const txt = r ? t(`run.${r.status}`) : t('run.none');

  // THE STATUS, SAID ONCE (Iban, 2026-09-26: a «Red» chip beside a picker
  // that ends in «red»): the picker's face ends in the status word, in its
  // colour, with the live dot while it runs.
  const runs = runsOf(S.suite);
  const chosen = runs.find((x) => x.id === r?.id) ?? runs[0];
  const status = runStatus(chosen);
  $('runFace').innerHTML = chosen
    ? `${esc(runHead(chosen))} · <span class="st" data-st="${esc(status)}">${status === 'running' ? '<span class="dot"></span>' : ''}${esc(t(`run.${status}`).toLowerCase())}</span>`
    : esc(t('run.none_option'));
  $('runBtn').disabled = runs.length === 0;
  if (S.runPick.open) renderRunPop();

  // A run of ANOTHER suite is going: say so, and offer the way to it.
  const other = st?.task?.suite && st.task.suite !== S.suite ? suiteOf(st.task.suite) : null;
  const pill = $('elsewhere');
  pill.hidden = !other;
  if (other) withIcon(pill, 'radio', `${t('elsewhere', { suite: other.title })} · ${t('elsewhere.go')}`);

  const now = $('nowText');
  now.classList.remove('err');
  if (st?.task && isRunning()) {
    const c = r.current;
    now.textContent = c?.step ? `${c.test} › ${c.step}` : c?.test ? c.test : kindLabel(st.task);
    if (c?.error) now.classList.add('err');
  } else if (r) {
    const failed = Object.entries(r.tests ?? {}).find(([, x]) => x.status === 'failed' || x.status === 'timedOut');
    now.textContent = failed
      ? t('now.failed', { test: failed[0] })
      : t('now.done', { label: kindLabel(r), status: txt.toLowerCase(), n: r.frameCount ?? S.frames.length });
    if (failed) now.classList.add('err');
  } else if (suiteOf(S.suite)) now.textContent = t('now.never');
  else now.textContent = t('now.idle');

  const ph = r?.phase;
  const pct = ph && ph.total ? Math.round((100 * ph.done) / ph.total) : r && r.status !== 'running' ? 100 : 0;
  $('phaseText').textContent = ph ? t('progress.phase', { files: ph.files.join(', '), done: ph.done, total: ph.total }) : t('progress.label');
  $('progressText').textContent = `${pct}%`;
  $('progressBar').style.width = `${pct}%`;
  tickElapsed();
}

// ---------------------------------------------------------------- the run picker
//
// The suite picker's button and panel, for the runs of the suite shown
// (Iban, 2026-09-26: «un div més ric»). A row per run: its status in
// colour, when and whose, how long it took, how far its tests got and
// where it broke. Keys as in a listbox: arrows, Home/End, Enter, Escape.

const runHead = (x) => `${when(x.startedAt)} · ${kindLabel(x)}`;
// The run on screen has the freshest status; the list's copy may lag.
const runStatus = (x) => (x && S.run && x.id === S.run.id ? S.run.status : x?.status);

function runDuration(x) {
  if (!x.endedAt) return null;
  const secs = Math.max(0, Math.round((new Date(x.endedAt) - new Date(x.startedAt)) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** How far its tests got («9 de 11 proves passen») and where it broke, as
 *  HTML. The index brings a `tally` (server.mjs, tallyOf); the run going
 *  now brings its tests whole, and is counted here the same way. */
function runTests(x) {
  const all = Object.entries(x.tests ?? {});
  const broke = all.find(([, v]) => v.status === 'failed' || v.status === 'timedOut');
  const tally = x.tally ?? {
    total: x.phase?.total || x.testOrder?.length || all.length,
    done: x.phase?.done ?? null,
    passed: all.filter(([, v]) => v.status === 'passed').length,
    failedAt: broke?.[0] ?? null,
  };
  const n = tally.total;
  if (!n) return '';
  if (runStatus(x) === 'running') return esc(t('runs.done', { done: tally.done ?? 0, n }));
  const where = tally.failedAt ? ` · <span class="bad">${esc(t('runs.failed_at', { test: tally.failedAt.split(' · ')[0] }))}</span>` : '';
  return esc(t('runs.pass', { ok: tally.passed, n })) + where;
}

function renderRunPop({ scroll = false } = {}) {
  const runs = runsOf(S.suite);
  S.runPick.active = Math.max(0, Math.min(runs.length - 1, S.runPick.active));
  $('runPop').innerHTML = runs
    .map((x, i) => {
      const st = runStatus(x);
      const meta = [runDuration(x), runTests(x)].filter(Boolean).join(' · ');
      return `<div class="run-item${i === S.runPick.active ? ' active' : ''}" role="option" id="run-opt-${esc(x.id)}" data-run="${esc(x.id)}" data-st="${esc(st)}" aria-selected="${x.id === S.run?.id}">
      <span class="rdot"></span>
      <span class="k"><b>${esc(when(x.startedAt))}</b> · ${esc(kindLabel(x))}</span>
      <span class="chip ${STATUS_CHIP[st] ?? ''}">${st === 'running' ? '<span class="dot"></span>' : ''}${esc(t(`run.${st}`))}</span>
      ${meta ? `<span class="m">${meta}</span>` : ''}
    </div>`;
    })
    .join('');
  const active = runs[S.runPick.active];
  $('runPop').setAttribute('aria-activedescendant', active ? `run-opt-${active.id}` : '');
  if (scroll) $('runPop').querySelector('.run-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openRunPick() {
  const runs = runsOf(S.suite);
  if (!runs.length) return;
  S.runPick.open = true;
  S.runPick.active = Math.max(0, runs.findIndex((x) => x.id === S.run?.id));
  $('runPop').hidden = false;
  $('runBtn').setAttribute('aria-expanded', 'true');
  renderRunPop({ scroll: true });
  $('runPop').focus();
}

function closeRunPick(refocus = false) {
  if (!S.runPick.open) return;
  S.runPick.open = false;
  $('runPop').hidden = true;
  $('runBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('runBtn').focus();
}

async function pickRun(id) {
  closeRunPick(true);
  if (!id || id === S.run?.id) return;
  S.viewRunId = id === runsOf(S.suite)[0]?.id ? null : id;
  if (S.ins) closeInspector();
  await viewRun(id);
}

$('runChev').innerHTML = icon('down', 'sm');
$('runBtn').onclick = () => (S.runPick.open ? closeRunPick() : openRunPick());
$('runBtn').onkeydown = (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  openRunPick();
};
$('runPop').onkeydown = (e) => {
  const runs = runsOf(S.suite);
  if (e.key === 'ArrowDown') S.runPick.active = Math.min(runs.length - 1, S.runPick.active + 1);
  else if (e.key === 'ArrowUp') S.runPick.active = Math.max(0, S.runPick.active - 1);
  else if (e.key === 'Home') S.runPick.active = 0;
  else if (e.key === 'End') S.runPick.active = runs.length - 1;
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    return void pickRun(runs[S.runPick.active]?.id);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    return closeRunPick(true);
  } else if (e.key === 'Tab') return closeRunPick();
  else return;
  e.preventDefault();
  renderRunPop({ scroll: true });
};
$('runPop').addEventListener('click', (e) => {
  const item = e.target.closest('[data-run]');
  if (item) void pickRun(item.dataset.run);
});

function tickElapsed() {
  const r = S.run;
  if (!r) return ($('runWhen').textContent = '');
  const end = r.endedAt ? new Date(r.endedAt) : new Date();
  const secs = Math.max(0, Math.round((end - new Date(r.startedAt)) / 1000));
  $('runWhen').textContent = `${hhmmss(r.startedAt)} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- the table

/** The suite's people, in the cast's order, and anybody else a photo shows. */
function people() {
  const st = S.state;
  if (!st) return [];
  const wanted = new Set([...(suiteOf(S.suite)?.cast ?? []), ...S.frames.map((f) => f.actor)]);
  if (wanted.size === 0) st.sessions.forEach((p) => wanted.add(p));
  return st.cast.filter((p) => wanted.has(p.id));
}

/** The frame a person shows at the table's moment (or their newest). */
function frameAtTable(actor) {
  const limit = S.table.live || !S.moments.length ? Infinity : S.moments[S.table.idx].lastSeq;
  let best = null;
  for (const f of S.frames) if (f.actor === actor && f.seq <= limit) best = f;
  return best;
}

function renderTableHead() {
  const n = S.moments.length;
  const range = $('tRange');
  range.max = String(Math.max(0, n - 1));
  if (S.table.live) S.table.idx = Math.max(0, n - 1);
  range.value = String(S.table.idx);
  range.disabled = n === 0;
  const m = S.moments[S.table.idx];
  $('tLabel').textContent = n ? `${m.test} › ${m.step}` : S.run ? t('table.empty') : '';
  $('tLabel').title = $('tLabel').textContent;
  // Only while a run goes: after it, the ⏭ button beside the timeline
  // already goes to the end (Iban, 2026-09-23: one door per thing).
  const live = $('tLive');
  live.hidden = S.table.live || n === 0 || !isRunning();
  withIcon(live, 'radio', t('table.live'));
  for (const id of ['tFirst', 'tPrev']) $(id).disabled = n === 0 || S.table.idx <= 0;
  for (const id of ['tNext', 'tLast']) $(id).disabled = n === 0 || S.table.idx >= n - 1;
  const never = $('tableNever');
  never.hidden = Boolean(S.run) || !suiteOf(S.suite);
  if (!never.hidden) never.textContent = t('table.never', { suite: suiteOf(S.suite).title });
}

function tableGo(idx) {
  const n = S.moments.length;
  if (!n) return;
  S.table.idx = Math.max(0, Math.min(n - 1, idx));
  // The last moment is the live one: new photos keep it at the end.
  S.table.live = S.table.idx === n - 1;
  renderTableHead();
  renderCast();
}

function cardHtml(p, moment, running) {
  const f = frameAtTable(p.id);
  // Acting now: the step that has begun names them (a page opened in the
  // middle of a step knows it from the run's own `current`).
  const acting = running && S.table.live && (S.acting.has(p.id) || (S.run?.current?.actors ?? []).includes(p.id));
  // While they act, the card shows their screen as it moves, over their last
  // photo: a long step has nothing else to show until it ends, when its
  // photo comes and the picture stops. Only the people acting, and only
  // while this page is on screen: every live picture is a screencast the
  // run pays for (lib/cockpit.mjs).
  const liveShot = acting && !document.hidden;
  const failed = f?.status === 'failed';
  const cls = ['card', acting ? 'acting' : '', failed ? 'failed' : '', moment ? (moment.actors.has(p.id) ? 'here' : 'dim') : ''].join(' ');
  const [chipCls, chipTxt] = acting
    ? ['accent live', t('card.acting')]
    : failed
      ? ['err', t('card.error')]
      : f
        ? ['ok', t('card.done')]
        : ['', t('card.waiting')];
  const watching = S.state.watched?.includes(p.id);
  const name = cap(p.id);
  return `<article class="${cls}" data-actor="${esc(p.id)}">
    <div class="card-head">
      <div class="who"><b>${esc(p.name ?? p.id)}</b>${whoLines(p, f)}</div>
      <span class="chip ${chipCls}">${chipCls.includes('live') ? '<span class="dot"></span>' : ''}${esc(chipTxt)}</span>
    </div>
    <button class="shot" data-open="${esc(p.id)}" aria-label="${esc(t('card.inspect_aria', { name }))}">
      ${f ? `<img src="${esc(frameUrl(f))}" alt="" loading="lazy"${f.viewport ? ` class="vp" style="${viewportStyle(f)}"` : ''}>` : `<span class="empty">${esc(t('card.no_photos'))}</span>`}
      ${liveShot ? `<img class="live-shot" src="/api/live/${encodeURIComponent(p.id)}" alt="">` : ''}
      ${watching && !acting ? `<span class="chip accent live" style="position:absolute;top:8px;left:8px"><span class="dot"></span>${esc(t('card.live'))}</span>` : ''}
    </button>
    <div class="card-cap" title="${esc(f ? `${f.test} › ${f.step}` : '')}">${f ? `<span class="faint mono">${esc(frameLabel(f))}</span> ${esc(stepText(f))}` : `<span class="faint">${esc(t('card.nothing'))}</span>`}</div>
    <div class="card-meta"><span>${esc(f ? pathOf(f.url) : '')}</span><span>${esc(f ? hhmmss(f.time) : '')}</span></div>
    <div class="card-actions">
      <button class="btn" data-open="${esc(p.id)}">${icon('eye', 'sm')}<span>${esc(t('card.inspect'))}</span></button>
      <button class="btn" data-play="${esc(p.id)}" ${S.state.sessions.includes(p.id) ? '' : `disabled title="${esc(t('card.no_session'))}"`}>${icon('external', 'sm')}<span>${esc(t('card.play_as', { name }))}</span></button>
    </div>
  </article>`;
}

const drawn = new Map(); // actor -> the html last drawn

/** A card's live picture ends with it: an image taken out of the page does
 *  not always close its stream, and an open stream keeps the person
 *  «watched» and their screencast going. */
function stopLiveShots(el) {
  for (const img of el.querySelectorAll('img.live-shot')) img.src = 'data:,';
}
// A page put away stops its cards' live pictures; back on screen, they
// start again.
document.addEventListener('visibilitychange', () => renderCast());

function renderCast() {
  const box = $('cast');
  const list = people();
  if (!list.length) {
    drawn.clear();
    box.innerHTML = `<p class="muted" style="margin:4px 2px">${esc(t('cast.empty'))}</p>`;
    return;
  }
  box.querySelector('p.muted')?.remove();
  const moment = !S.table.live ? S.moments[S.table.idx] : null;
  const running = isRunning();
  const keep = new Set(list.map((p) => p.id));
  for (const el of [...box.children]) {
    if (!keep.has(el.dataset.actor)) {
      drawn.delete(el.dataset.actor);
      stopLiveShots(el);
      el.remove();
    }
  }
  list.forEach((p, i) => {
    const html = cardHtml(p, moment, running);
    let el = box.querySelector(`[data-actor="${CSS.escape(p.id)}"]`);
    if (!el || drawn.get(p.id) !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      if (el) {
        stopLiveShots(el);
        el.replaceWith(fresh);
      }
      el = fresh;
      drawn.set(p.id, html);
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
  });
}

$('cast').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openInspector(open.dataset.open);
  const play = e.target.closest('[data-play]');
  if (play) return playAs(play.dataset.play);
});

async function playAs(actor) {
  const name = cap(actor);
  if (S.state?.task && !confirm(t('play.confirm', { name }))) return;
  banner(t('play.opening', { name }), 'warn');
  const res = await act('play-as', { actor });
  if (res.ok && !res.warning) banner(t('play.opened', { name }), 'warn');
  else if (!res.ok) banner(t('play.failed', { name, error: res.error }), 'err');
}

// ---------------------------------------------------------------- the inspector

const dlg = $('inspector');

function insFrames() {
  return S.ins ? S.frames.filter((f) => f.actor === S.ins.actor) : [];
}

function openInspector(actor) {
  const list = S.frames.filter((f) => f.actor === actor);
  S.ins = { actor, idx: Math.max(0, list.length - 1), live: isRunning(), fresh: 0, timer: null, zoom: false };
  const p = S.state.cast.find((c) => c.id === actor);
  $('insName').textContent = cap(actor);
  $('insSub').innerHTML = insSubHtml(actor);
  $('insPlayAs').disabled = !S.state.sessions.includes(actor);
  withIcon($('insPlayAs'), 'external', t('card.play_as', { name: cap(actor) }));
  dlg.showModal();
  renderInspector(true);
}

function closeInspector() {
  if (!S.ins) return;
  stopPlay();
  $('insLive').removeAttribute('src');
  $('insLive').hidden = true;
  S.ins = null;
  if (dlg.open) dlg.close();
}

dlg.addEventListener('close', () => {
  const actor = S.ins?.actor;
  closeInspector();
  if (actor) document.querySelector(`[data-open="${CSS.escape(actor)}"]`)?.focus();
});

function setLive(on) {
  const ins = S.ins;
  ins.live = on && isRunning();
  ins.fresh = 0;
  const live = $('insLive');
  if (ins.live) {
    stopPlay();
    if (!live.getAttribute('src')) {
      live.hidden = true;
      live.onload = () => {
        if (S.ins?.live) {
          live.hidden = false;
          $('insSheet').hidden = true;
        }
      };
      live.src = `/api/live/${encodeURIComponent(ins.actor)}`;
    }
    ins.idx = Math.max(0, insFrames().length - 1);
  } else {
    live.removeAttribute('src');
    live.hidden = true;
  }
}

function insGo(idx) {
  const n = insFrames().length;
  if (!n || !S.ins) return;
  if (S.ins.live) setLive(false);
  S.ins.idx = Math.max(0, Math.min(n - 1, idx));
  if (S.ins.idx === n - 1) S.ins.fresh = 0;
  renderInspector();
}

function renderInspector(first = false) {
  const ins = S.ins;
  if (!ins) return;
  if (first) setLive(ins.live);
  const list = insFrames();
  const f = list[ins.idx];

  // Header chip
  const chip = $('insChip');
  if (ins.live) {
    chip.className = 'chip accent live';
    chip.innerHTML = `<span class="dot"></span>${esc(t('ins.live'))}`;
  } else if (f) {
    chip.className = `chip ${f.status === 'failed' ? 'err' : 'warn'}`;
    chip.textContent = t('ins.reviewing', { label: frameLabel(f) || f.step });
  } else {
    chip.className = 'chip';
    chip.textContent = t('ins.no_photos');
  }

  renderInsState();

  // Steps, grouped by test; each test says when it is over, each step how
  // long it took (a slow one in amber).
  let html = '';
  let lastTest = null;
  list.forEach((x, i) => {
    if (x.test !== lastTest) {
      html += `<h4><span class="tn" title="${esc(x.test)}">${esc(x.test)}</span>${testState(x.test)}</h4>`;
      lastTest = x.test;
    }
    const st = x.status === 'failed' ? 'failed' : x.status === 'context' ? 'context' : 'passed';
    const ic = st === 'failed' ? 'alert' : st === 'context' ? 'dot' : 'check';
    const sel = !ins.live && i === ins.idx ? ' sel' : '';
    const dur = Number.isFinite(x.ms) ? `<span class="dur${x.ms >= SLOW_STEP_MS ? ' slow' : ''}">${esc(fmtDur(x.ms))}</span>` : '';
    html += `<button class="step${sel}" data-i="${i}"><span class="st ${st}">${icon(ic, 'sm')}</span><span class="sx">${esc(x.step)}</span>${dur}</button>`;
  });
  $('insSteps').innerHTML = html || `<p class="muted" style="margin:12px">${esc(t('ins.no_photos_long'))}</p>`;
  $('insSteps').querySelector('.step.sel')?.scrollIntoView({ block: 'nearest' });

  // Stage: the whole page, its seen part framed, the step's marks on it.
  const img = $('insImg');
  const sheet = $('insSheet');
  const empty = $('insEmpty');
  if (f) {
    const src = frameUrl(f);
    if (img.getAttribute('src') !== src) {
      img.onload = () => placeOnSheet(f);
      img.src = src;
    } else placeOnSheet(f);
    sheet.hidden = ins.live && !$('insLive').hidden;
    empty.hidden = true;
  } else {
    sheet.hidden = true;
    img.removeAttribute('src');
    empty.hidden = false;
    empty.textContent = ins.live ? t('ins.live_waiting') : t('ins.no_photos');
  }
  sheet.classList.toggle('zoom', ins.zoom);

  const showErr = !ins.live && f?.error;
  $('insError').hidden = !showErr;
  if (showErr) $('insErrorText').textContent = f.error;

  if (ins.live) {
    const c = S.run?.current;
    $('insCap').textContent = c?.step ? t('ins.now', { test: c.test, step: c.step }) : t('ins.live');
    $('insWhere').textContent = f ? t('ins.last_photo', { label: frameLabel(f), time: hhmmss(f.time) }) : '';
  } else if (f) {
    $('insCap').textContent = `${f.test} › ${f.step}`;
    const took = Number.isFinite(f.ms) ? t('ins.took', { d: fmtDur(f.ms) }) : null;
    const into = f.began && S.run?.startedAt ? t('ins.into', { d: fmtDur(Date.parse(f.began) - Date.parse(S.run.startedAt)) }) : null;
    // The slowest call to the app's backend: a page load is the front's
    // dev server in the QA stack, not something production pays.
    const slowest = [...(f.requests ?? [])].filter((q) => q.kind !== 'page' && Number.isFinite(q.ms)).sort((a, b) => b.ms - a.ms)[0];
    const reqs = f.requests?.length
      ? t('ins.requests', { n: f.requests.length, req: slowest ? `${slowest.method} ${slowest.path.split('?')[0]} ${slowest.ms} ms` : '' })
      : null;
    $('insWhere').textContent = [pathOf(f.url), hhmmss(f.time), took, into, reqs, f.location].filter(Boolean).join(' · ');
  } else {
    $('insCap').textContent = '';
    $('insWhere').textContent = '';
  }
  $('insMarksList').innerHTML = !ins.live && f ? marksList(f) : '';

  // Filmstrip
  $('insStrip').innerHTML = list
    .map((x, i) => {
      const cls = ['thumb', !ins.live && i === ins.idx ? 'sel' : '', x.status === 'failed' ? 'failed' : ''].join(' ');
      return `<button class="${cls}" data-i="${i}" title="${esc(`${x.test} › ${x.step}`)}"><img src="${esc(frameUrl(x))}" alt="" loading="lazy"><span>${esc(frameLabel(x) || '·')}</span></button>`;
    })
    .join('');
  const selThumb = $('insStrip').querySelector('.thumb.sel') ?? $('insStrip').lastElementChild;
  selThumb?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // Transport
  const n = list.length;
  $('pCount').textContent = ins.live ? t('ins.photos', { n }) : `${n ? ins.idx + 1 : 0} / ${n}`;
  $('pFirst').disabled = $('pPrev').disabled = !n || (!ins.live && ins.idx <= 0);
  $('pNext').disabled = $('pLast').disabled = !n || ins.live || ins.idx >= n - 1;
  withIcon($('pPlay'), ins.timer ? 'pause' : 'play');
  $('pPlay').setAttribute('aria-label', t(ins.timer ? 'ins.pause' : 'ins.play'));
  $('pPlay').disabled = n < 2;
  // Only while a run goes: after it, ⏭ goes to the last photo, and a
  // second button for the same thing was one too many (Iban, 2026-09-23).
  const pl = $('pLive');
  pl.hidden = ins.live || !isRunning();
  const fresh = ins.fresh === 1 ? t('ins.fresh_one') : ins.fresh > 1 ? t('ins.fresh_many', { n: ins.fresh }) : '';
  withIcon(pl, 'radio', `${fresh}${t('table.live')}`);

  // Header actions
  const trace = f && S.run?.tests?.[f.test]?.trace;
  $('insTrace').disabled = !trace;
  $('insTrace').title = t(trace ? 'ins.trace' : 'ins.trace_later');
  $('insDownload').disabled = !f;
}

/** The marks of a step: those on the page photographed are drawn and
 *  numbered; a click that took the person elsewhere is listed with where it
 *  happened. */
// ---------------------------------------------------------------- the run's report

/** The whole run as Markdown, written for a person or a model to read end
 *  to end: every step in order, who acted, how long it took, what they
 *  clicked and when, the requests their page made (slowest first), every
 *  error in full, and the paths to each photo, trace and recording line. */
function runReport() {
  const r = S.run;
  if (!r) return '';
  const P = S.state.paths;
  const OUT = P.out;
  const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'n/a');
  const t0 = Date.parse(r.startedAt);
  const lines = [
    `# QA run: ${r.suite} · ${r.id}`,
    '',
    `- Suite: \`${P.suites}/${r.suite}.md\`; recording: \`${P.recordings}/${r.suite}${S.state.recordingExt}\``,
    `- Run: ${kindLabel(r)}, ${r.status}, started ${r.startedAt}${r.endedAt ? `, took ${secs(Date.parse(r.endedAt) - t0)}` : ''}`,
    `- Log: \`${OUT}/cockpit/${r.id}/log.jsonl\`; photos and traces under \`${OUT}/\``,
    `- People: ${[...new Set(S.frames.map((f) => f.actor))]
      .map((a) => {
        const d = lastDeviceOf(a);
        return `${cap(a)}${d ? ` on ${d.name}${d.width ? ` (${d.kind}, ${d.width}×${d.height})` : ` (${d.kind})`}` : ''}`;
      })
      .join('; ')}`,
    '',
    'How to read it: one section per test, in the order they ran. A step\'s time runs from its start to its',
    'photo and includes the recording\'s own waits; the requests are the app\'s, with their own time, so a',
    'step slow because of the app shows there. A «page load» is the front\'s own server, not the API.',
    'Actions and requests carry their offset from the step\'s start. «context» photos are people a failed',
    'step does not name, photographed as they were.',
    ...(S.state.reportNotes?.length ? ['', ...S.state.reportNotes.map((n) => `Note: ${n}`)] : []),
    '',
  ];
  // THE API BY ENDPOINT: every request of every person, ids folded into
  // `{id}`, so the run doubles as a latency check. Page loads (the front's
  // own server under test) are left out: production does not pay them.
  const byEndpoint = new Map();
  for (const f of S.frames) {
    for (const q of f.requests ?? []) {
      if (q.kind === 'page' || !Number.isFinite(q.ms)) continue;
      const path = q.path
        .split('?')[0]
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')
        .replace(/\/\d+(?=\/|$)/g, '/{n}');
      const key = `${q.method} ${path}`;
      if (!byEndpoint.has(key)) byEndpoint.set(key, []);
      byEndpoint.get(key).push(q.ms);
    }
  }
  if (byEndpoint.size) {
    const rows = [...byEndpoint.entries()]
      .map(([key, ms]) => {
        ms.sort((a, b) => a - b);
        return { key, n: ms.length, p50: ms[Math.floor(ms.length / 2)], max: ms.at(-1), total: ms.reduce((a, b) => a + b, 0) };
      })
      .sort((a, b) => b.total - a.total);
    lines.push(
      '## The API by endpoint',
      '',
      'Every call to the backend in this run, slowest in total first. Times are the browser\'s (network',
      'included), against a stack under test: compare them with each other more than with production.',
      '',
      '| Endpoint | Calls | p50 | Max | Total |',
      '|---|---:|---:|---:|---:|',
      ...rows.slice(0, 25).map((x) => `| \`${x.key}\` | ${x.n} | ${x.p50} ms | ${x.max} ms | ${x.total} ms |`),
      '',
    );
  }

  const order = [...new Set([...(r.testOrder ?? []), ...S.frames.map((f) => f.test)])];
  for (const test of order) {
    const info = r.tests?.[test] ?? {};
    lines.push(`## ${test}: ${info.status ?? 'not run'}${Number.isFinite(info.duration) ? ` (${secs(info.duration)})` : ''}`, '');
    if (info.trace) lines.push(`- Trace: \`${OUT}/${info.trace}\``);
    for (const e of info.errors ?? []) lines.push('- Test error:', '', '```text', String(e.message ?? e), '```', '');
    const frames = S.frames.filter((f) => f.test === test);
    const steps = [...new Set(frames.map((f) => f.step))];
    for (const step of steps) {
      const all = frames.filter((f) => f.step === step);
      const main = all.filter((f) => f.status !== 'context');
      const head = main[0] ?? all[0];
      lines.push(
        `### ${frameLabel(head) ? `${frameLabel(head)} · ${stepText(head)}` : step}`,
        '',
        `- ${head.status}, ${secs(head.ms)}${head.began ? `, began ${secs(Date.parse(head.began) - t0)} into the run` : ''}`,
      );
      if (head.location) lines.push(`- Recording line: \`${P.project}/${head.location}\``);
      for (const f of all) {
        const began = f.began ? Date.parse(f.began) : null;
        const off = (at) => (began && Number.isFinite(at) ? ` ${at < began ? '-' : '+'}${secs(Math.abs(at - began))}` : '');
        lines.push(`- ${cap(f.actor)}${f.status === 'context' ? ' (context)' : ''}: page \`${pathOf(f.url)}\`, photo \`${OUT}/${f.file}\``);
        const marks = f.marks ?? [];
        if (marks.length) lines.push(`  - Actions: ${marks.map((m, i) => `${i + 1}. ${m.kind} «${m.label}»${off(m.at)}`).join('; ')}`);
        const reqs = [...(f.requests ?? [])].sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1));
        if (reqs.length) {
          const shown = reqs.slice(0, 10).map((q) => `${q.kind === 'page' ? 'page load ' : ''}${q.method} ${q.path} ${q.status || 'failed'} in ${Number.isFinite(q.ms) ? `${q.ms} ms` : 'n/a'}${off(q.at)}`);
          lines.push(`  - Requests (${reqs.length}, slowest first): ${shown.join('; ')}${reqs.length > 10 ? '; …' : ''}`);
        }
      }
      if (head.error) lines.push('- Error:', '', '```text', head.error, '```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

$('runReport').onclick = () => {
  const md = runReport();
  if (!md) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  a.download = `${S.state.project}-${S.run.id}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/** Whether the person under inspection acts now, waits for their turn, or
 *  the run is over: a finished run says so, so nobody waits on it. */
function renderInsState() {
  const el = $('insState');
  const ins = S.ins;
  el.hidden = !ins || !S.run;
  if (el.hidden) return;
  if (isRunning()) {
    const acting = S.acting.has(ins.actor) || (S.run.current?.actors ?? []).includes(ins.actor);
    el.className = `chip ${acting ? 'accent live' : ''}`;
    el.innerHTML = `${acting ? '<span class="dot"></span>' : ''}${esc(t(acting ? 'card.acting' : 'card.waiting'))}`;
  } else {
    const red = S.run.status !== 'passed';
    el.className = `chip ${red ? 'err' : 'ok'}`;
    el.textContent = t(red ? 'ins.run_done_red' : 'ins.run_done');
  }
}

/** A test's end, beside its name in the inspector's list. */
function testState(title) {
  const status = S.run?.tests?.[title]?.status;
  const [cls, ic, key] =
    status === 'passed'
      ? ['ok', 'check', 'ins.test_passed']
      : status === 'failed' || status === 'timedOut' || status === 'interrupted'
        ? ['err', 'alert', 'ins.test_failed']
        : status === 'running'
          ? ['live', 'dot', 'ins.test_running']
          : [null];
  return cls ? `<span class="tstate ${cls}">${icon(ic, 'sm')}${esc(t(key))}</span>` : '';
}

function marksOf(f) {
  const here = (u) => {
    try {
      const a = new URL(u);
      const b = new URL(f.url);
      return a.pathname + a.search === b.pathname + b.search;
    } catch {
      return false;
    }
  };
  const marks = f.marks ?? [];
  return { drawn: marks.filter((m) => here(m.url)), elsewhere: marks.filter((m) => !here(m.url)) };
}

function marksList(f) {
  const { drawn, elsewhere } = marksOf(f);
  if (!drawn.length && !elsewhere.length) return '';
  const verb = (m) => t(m.kind === 'type' ? 'mark.type' : 'mark.click');
  // How long after the step's start each action came: the gaps between
  // them are where a slow screen shows.
  const at = (m) => {
    if (!Number.isFinite(m.at) || !f.began) return '';
    const d = m.at - Date.parse(f.began);
    return ` <span class="at">${d < 0 ? '-' : '+'}${esc(fmtDur(Math.abs(d)))}</span>`;
  };
  const parts = drawn.map((m, i) => `<span class="n ${m.kind}">${i + 1}</span>${esc(verb(m))} «${esc(m.label)}»${at(m)}`);
  for (const m of elsewhere) parts.push(`${esc(verb(m))} «${esc(m.label)}» ${esc(t('mark.elsewhere', { path: pathOf(m.url) }))}${at(m)}`);
  return parts.join(' · ');
}

/** Once the photo has its size: the seen frame, the dots, and the view
 *  scrolled to where the person was looking (once per photo). */
function placeOnSheet(f) {
  const img = $('insImg');
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (!W || !H || !S.ins) return;
  // Never wider than the photo itself: a phone's page stands at its own
  // size in the middle, instead of stretched and blurred to the pane's width.
  $('insSheet').style.maxWidth = `${W}px`;
  const seen = $('insSeen');
  const vh = f.viewport?.height ?? H;
  const sy = f.scroll?.y ?? 0;
  seen.hidden = H <= vh + 2;
  seen.style.top = `${(100 * sy) / H}%`;
  seen.style.height = `${(100 * Math.min(vh, H - sy)) / H}%`;
  const { drawn } = marksOf(f);
  const layer = $('insMarks');
  layer.classList.toggle('off', !$('optMarks').checked);
  layer.innerHTML = drawn
    .map(
      (m, i) =>
        `<span class="pin ${m.kind}" style="left:${(100 * m.x) / W}%;top:${(100 * m.y) / H}%" title="${esc(m.label)}">${i + 1}</span>`,
    )
    .join('');
  if (S.ins.placed !== f.seq) {
    S.ins.placed = f.seq;
    const view = $('insView');
    view.scrollTop = Math.max(0, (sy / H) * img.clientHeight - 12);
  }
}

function stopPlay() {
  if (S.ins?.timer) {
    clearInterval(S.ins.timer);
    S.ins.timer = null;
  }
}

function togglePlay() {
  const ins = S.ins;
  if (!ins) return;
  if (ins.timer) {
    stopPlay();
    return renderInspector();
  }
  const n = insFrames().length;
  if (n < 2) return;
  if (ins.live) setLive(false);
  if (ins.idx >= n - 1) ins.idx = 0;
  ins.timer = setInterval(() => {
    if (!S.ins) return;
    if (S.ins.idx >= insFrames().length - 1) {
      stopPlay();
      return renderInspector();
    }
    S.ins.idx += 1;
    renderInspector();
  }, 1000);
  renderInspector();
}

function goLiveOrEnd() {
  if (!S.ins) return;
  if (isRunning()) setLive(true);
  else S.ins.idx = Math.max(0, insFrames().length - 1);
  S.ins.fresh = 0;
  renderInspector();
}

$('insSteps').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b) insGo(Number(b.dataset.i));
});
$('insStrip').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (b) insGo(Number(b.dataset.i));
});
$('pFirst').onclick = () => insGo(0);
$('pPrev').onclick = () => insGo(S.ins.live ? insFrames().length - 1 : S.ins.idx - 1);
$('pNext').onclick = () => insGo(S.ins.idx + 1);
$('pLast').onclick = () => insGo(insFrames().length - 1);
$('pPlay').onclick = togglePlay;
$('pLive').onclick = goLiveOrEnd;
$('insClose').onclick = () => dlg.close();
$('insImg').onclick = () => {
  S.ins.zoom = !S.ins.zoom;
  $('insSheet').classList.toggle('zoom', S.ins.zoom);
};
$('insPlayAs').onclick = () => playAs(S.ins.actor);
$('insDownload').onclick = () => {
  const f = insFrames()[S.ins.idx];
  if (!f) return;
  const a = document.createElement('a');
  a.href = frameUrl(f);
  a.download = `${S.ins.actor}-${frameLabel(f) || f.seq}.jpg`;
  a.click();
};
$('insTrace').onclick = () => {
  const f = insFrames()[S.ins.idx];
  const trace = f && S.run?.tests?.[f.test]?.trace;
  if (trace) window.open(`/trace/index.html?trace=${encodeURIComponent(`${location.origin}/out/${trace}`)}`, '_blank', 'noopener');
};
$('insCopy').onclick = async () => {
  const f = insFrames()[S.ins.idx];
  if (!f) return;
  const trace = S.run?.tests?.[f.test]?.trace;
  const md = [
    `### ${t('copy.title', { suite: S.run?.suite ?? '' })}`,
    `- ${t('copy.where')}: ${cap(f.actor)} · ${frameLabel(f) || f.step}`,
    `- ${t('copy.run')}: \`${S.run?.id}\``,
    `- ${t('copy.test')}: ${f.test}`,
    `- ${t('copy.step')}: ${f.step}`,
    `- ${t('copy.who')}: ${f.actor}, \`${pathOf(f.url)}\``,
    f.location ? `- ${t('copy.line')}: \`${S.state.paths.project}/${f.location}\`` : null,
    `- ${t('copy.photo')}: \`${S.state.paths.out}/${f.file}\``,
    trace ? `- ${t('copy.trace')}: \`${S.state.paths.out}/${trace}\`` : null,
    `- ${t('copy.error')}:`,
    '```',
    f.error ?? '',
    '```',
  ]
    .filter((l) => l !== null)
    .join('\n');
  await navigator.clipboard.writeText(md);
  withIcon($('insCopy'), 'check', t('ins.copied'));
  setTimeout(() => withIcon($('insCopy'), 'copy', t('ins.copy')), 2000);
};

dlg.addEventListener('keydown', (e) => {
  if (!S.ins || e.target.closest('input, select, textarea')) return;
  const n = insFrames().length;
  const keys = {
    ArrowLeft: () => insGo(S.ins.live ? n - 2 : S.ins.idx - 1),
    ArrowRight: () => insGo(S.ins.idx + 1),
    Home: () => insGo(0),
    End: () => insGo(n - 1),
    ' ': togglePlay,
    l: goLiveOrEnd,
    L: goLiveOrEnd,
    c: toggleMarks,
    C: toggleMarks,
  };
  const fn = keys[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

// ---------------------------------------------------------------- log

function logLine(entry) {
  const box = $('logBox');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  const div = document.createElement('div');
  if (entry.isError) div.className = 'e';
  else if (entry.text.startsWith('[cockpit]') || entry.text.startsWith('$ ')) div.className = 'c';
  div.textContent = `${hhmmss(entry.time)}  ${entry.text}`;
  box.appendChild(div);
  while (box.childElementCount > 3000) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

$('logToggle').onclick = () => {
  const open = $('logToggle').getAttribute('aria-expanded') !== 'true';
  $('logToggle').setAttribute('aria-expanded', String(open));
  $('logBox').hidden = !open;
  fitLog();
};

/** The log reaches down to the window's bottom edge when the page leaves
 *  room for it, and keeps its 220 px when it does not. Measured again when
 *  a panel above it changes height and when the window does. */
const LOG_MIN = 220;
function fitLog() {
  const box = $('logBox');
  if (box.hidden) return;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  const top = box.getBoundingClientRect().top + window.scrollY;
  // Under the box: its own margin (12), the panel's border (1) and the
  // body's padding (16). Floored: a fraction too many is a scrollbar.
  const room = Math.floor(document.documentElement.clientHeight - top - 12 - 1 - 16);
  box.style.height = `${Math.max(LOG_MIN, room)}px`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}
window.addEventListener('resize', fitLog);
window.visualViewport?.addEventListener('resize', fitLog);
if (typeof ResizeObserver !== 'undefined') {
  const above = new ResizeObserver(() => fitLog());
  for (const el of document.querySelectorAll('body > header, body > section:not(#log)')) above.observe(el);
}
$('logErrors').onchange = (e) => $('logBox').classList.toggle('errors-only', e.target.checked);
$('logDownload').onclick = () => {
  const blob = new Blob([$('logBox').innerText], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.state?.project ?? 'qa-cockpit'}-${S.run?.id ?? 'log'}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---------------------------------------------------------------- live updates

function renderAll() {
  renderHeader();
  renderStatus();
  renderTableHead();
  renderCast();
  if (S.ins) renderInspector();
  if (S.picker.open) renderPicker();
}

function connect() {
  const es = new EventSource('/api/events');
  // The browser retries a stream that broke on its own; one that it gave up
  // on (CLOSED) is opened again here, every few seconds, until it answers.
  es.onerror = () => {
    serverLost();
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, OFFLINE_AFTER_MS);
  };
  es.addEventListener('hello', async (e) => {
    serverBack();
    S.state = JSON.parse(e.data);
    // The project's own words and language (the person's choice wins).
    setGlobals({ cli: S.state.cli, skill: S.state.paths?.skill });
    preferLang(S.state.language);
    document.title = `${S.state.name} · QA Cockpit`;
    if (!S.suite || !suiteOf(S.suite)) S.suite = defaultSuite();
    const id = S.viewRunId ?? runsOf(S.suite)[0]?.id ?? null;
    await viewRun(id);
  });
  es.addEventListener('stack', (e) => {
    S.state.stack = JSON.parse(e.data);
    renderHeader();
  });
  es.addEventListener('lock', (e) => {
    S.state.lock = JSON.parse(e.data);
    renderHeader();
  });
  es.addEventListener('desktop', (e) => {
    S.state.desktopWarning = JSON.parse(e.data).desktopWarning;
    renderHeader();
  });
  es.addEventListener('task', async (e) => {
    S.state.task = JSON.parse(e.data);
    void waveFavicon(Boolean(S.state.task));
    if (!S.state.task) S.acting.clear();
    await refreshState();
  });
  es.addEventListener('run', async (e) => {
    const r = JSON.parse(e.data);
    const isNew = !S.state.run || S.state.run.id !== r.id;
    S.state.run = r;
    if (isNew) {
      S.state.runs = (await api('/api/state')).runs;
      // A new run of the suite on screen is followed; one of another suite
      // only lights the «is running» pill.
      if (S.viewRunId === null && r.suite === S.suite) {
        S.run = r;
        S.frames = [];
        buildMoments();
        S.acting.clear();
        if (S.ins) closeInspector();
        void loadRunLog(r.id);
      }
    } else if (S.run && S.run.id === r.id) {
      S.run = r;
    }
    renderStatus();
    renderTableHead();
    renderSuitePanel();
    if (S.ins) renderInspector();
  });
  es.addEventListener('frame', (e) => {
    const f = JSON.parse(e.data);
    if (!S.run || !S.state.run || S.run.id !== S.state.run.id) return;
    S.frames.push(f);
    buildMoments();
    renderTableHead();
    renderCast();
    if (S.ins && S.ins.actor === f.actor) {
      if (S.ins.live) S.ins.idx = insFrames().length - 1;
      else S.ins.fresh += 1;
      renderInspector();
    }
  });
  es.addEventListener('report', (e) => {
    const r = JSON.parse(e.data);
    if (!S.run || !S.state.run || S.run.id !== S.state.run.id) return;
    if (r.type === 'step:begin') {
      S.acting = new Set(r.actors);
      renderCast();
    } else if (r.type === 'test:end' || r.type === 'run:end') {
      S.acting.clear();
      renderCast();
    }
    if (S.ins) renderInsState();
  });
  es.addEventListener('watch', (e) => {
    S.state.watched = JSON.parse(e.data).actors;
    renderCast();
  });
  es.addEventListener('log', (e) => onLogLine(JSON.parse(e.data)));
}

async function refreshState() {
  S.state = await api('/api/state');
  const newest = runsOf(S.suite)[0]?.id ?? null;
  if (S.viewRunId === null && newest && S.run?.id !== newest) await viewRun(newest);
  else {
    if (S.run && S.state.run && S.run.id === S.state.run.id) S.run = S.state.run;
    renderAll();
  }
}

function localStorageGet(k) {
  try {
    // The key before the package had its own name, kept so a choice survives.
    return localStorage.getItem(`qa-cockpit-${k}`) ?? localStorage.getItem(`ck-cockpit-${k}`);
  } catch {
    return null;
  }
}
function localStorageSet(k, v) {
  try {
    localStorage.setItem(`qa-cockpit-${k}`, v);
  } catch {
    // Private windows may refuse; the page works without it.
  }
}

// ---------------------------------------------------------------- wiring

/** Every label that carries an icon, in the current language. */
function labelButtons() {
  withIcon($('btnReset'), 'database', t('btn.reset'));
  withIcon($('btnSetup'), 'listChecks', t('btn.setup'));
  withIcon($('btnReplay'), 'rotate', t('btn.replay'));
  withIcon($('btnFull'), 'play', t('btn.full'));
  withIcon($('btnStop'), 'stop', t('btn.stop'));
  withIcon($('insCopy'), 'copy', t('ins.copy'));
  withIcon($('logToggle'), 'chevron', t('log.toggle'));
  withIcon($('logDownload'), 'download', t('log.download'));
  withIcon($('runReport'), 'fileText');
  $('runReport').setAttribute('aria-label', t('run.report'));
  $('runReport').dataset.tip = t('run.report');
  foldLabel();
  renderOffline();
}

// ---------------------------------------------------------------- the suite panel, folded

/** The panel folds to its title line, to give the table the room; the
 *  choice is remembered. */
function foldLabel() {
  const folded = $('suitePanel').classList.contains('folded');
  const label = t(folded ? 'suite.unfold' : 'suite.fold');
  $('suiteFold').setAttribute('aria-expanded', String(!folded));
  $('suiteFold').setAttribute('aria-label', label);
}
$('suiteFold').innerHTML = icon('down');
$('suitePanel').classList.toggle('folded', localStorageGet('suiteFolded') === '1');
$('suiteFold').onclick = () => {
  const folded = !$('suitePanel').classList.contains('folded');
  $('suitePanel').classList.toggle('folded', folded);
  localStorageSet('suiteFolded', folded ? '1' : '0');
  foldLabel();
};

// ---------------------------------------------------------------- the server, gone

/** The cockpit's own server can stop under the page: an update of the app
 *  that started it ends it too. A page cannot start a program, so it says
 *  how, with the exact command, and goes away by itself when the server
 *  answers again. A blink (a restart) does not show it: only three seconds
 *  without the server. */
const OFFLINE_AFTER_MS = 3000;
let offlineTimer = null;
function renderOffline() {
  const dir = S.state?.projectDir;
  const cmd = `${S.state?.cli ?? 'npx qa-cockpit'} cockpit --no-open`;
  $('offlineIcon').innerHTML = icon('alert', 'lg');
  $('offlineTitle').textContent = t('offline.title');
  $('offlineLead').textContent = t('offline.lead');
  $('offlineCmd').textContent = dir ? `cd "${dir}"; ${cmd}` : cmd;
  $('offlineAfter').textContent = t('offline.after');
  if (!$('offlineCopy').dataset.copied) withIcon($('offlineCopy'), 'copy', t('todo.copy'));
  $('offlineClose').innerHTML = icon('x');
  $('offlineClose').setAttribute('aria-label', t('banner.hide'));
}
function serverLost() {
  if (offlineTimer || !$('offline').hidden || $('offline').dataset.dismissed) return;
  offlineTimer = setTimeout(() => {
    offlineTimer = null;
    renderOffline();
    $('offline').hidden = false;
  }, OFFLINE_AFTER_MS);
}
function serverBack() {
  clearTimeout(offlineTimer);
  offlineTimer = null;
  $('offline').hidden = true;
  delete $('offline').dataset.dismissed;
}
$('offlineClose').onclick = () => {
  $('offline').hidden = true;
  $('offline').dataset.dismissed = '1';
};
$('offlineCopy').onclick = async () => {
  const btn = $('offlineCopy');
  await navigator.clipboard.writeText($('offlineCmd').textContent);
  btn.dataset.copied = '1';
  withIcon(btn, 'check', t('todo.copied'));
  setTimeout(() => {
    delete btn.dataset.copied;
    withIcon(btn, 'copy', t('todo.copy'));
  }, 2000);
};

$('opts').querySelector('summary').innerHTML = icon('sliders');
$('pickerChev').innerHTML = icon('down', 'sm');
for (const [id, name] of [
  ['tFirst', 'first'],
  ['tPrev', 'prev'],
  ['tNext', 'next'],
  ['tLast', 'last'],
  ['pFirst', 'first'],
  ['pPrev', 'prev'],
  ['pNext', 'next'],
  ['pLast', 'last'],
  ['insTrace', 'route'],
  ['insDownload', 'download'],
  ['insClose', 'x'],
]) {
  withIcon($(id), name);
}
applyI18n();
labelButtons();

renderLang();

$('btnReset').onclick = () => act('reset');
$('btnSetup').onclick = () => act('setup');
$('btnReplay').onclick = () => act('replay');
$('btnFull').onclick = () => act('full');
$('btnStop').onclick = () => act('stop');
$('elsewhere').onclick = () => S.state?.task?.suite && pickSuite(S.state.task.suite);

function toggleMarks() {
  $('optMarks').checked = !$('optMarks').checked;
  $('optMarks').onchange();
}
$('optMarks').checked = localStorageGet('optMarks') !== '0';
$('optMarks').onchange = () => {
  localStorageSet('optMarks', $('optMarks').checked ? '1' : '0');
  $('insMarks').classList.toggle('off', !$('optMarks').checked);
};
for (const id of ['optHeaded', 'optDocker']) {
  $(id).checked = localStorageGet(id) === '1';
  $(id).onchange = () => localStorageSet(id, $(id).checked ? '1' : '0');
}
$('tRange').oninput = (e) => tableGo(Number(e.target.value));
$('tFirst').onclick = () => tableGo(0);
$('tPrev').onclick = () => tableGo(S.table.idx - 1);
$('tNext').onclick = () => tableGo(S.table.idx + 1);
$('tLast').onclick = () => {
  S.table.live = true;
  renderTableHead();
  renderCast();
};
$('tLive').onclick = $('tLast').onclick;
document.addEventListener('keydown', (e) => {
  if (dlg.open || S.picker.open || S.runPick.open || e.target.closest('input, select, textarea, button, summary')) return;
  if (e.key === 'ArrowLeft') tableGo(S.table.idx - 1);
  else if (e.key === 'ArrowRight') tableGo(S.table.idx + 1);
});

setInterval(tickElapsed, 1000);
connect();
