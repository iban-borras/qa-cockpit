// How long what one person does takes to reach another's screen
// (`replay --realtime`). A recording of several people says it in its own
// steps: «2 · Alice: writes «Hello, Bob!» and presses «Send»», then «3 · Bob:
// sees it arrive». When a step ends for somebody who did nothing since
// another person acted, that is a hand-off, measured from the other
// person's action:
//
//   sent      the first request or WebSocket message their page made
//   received  the first message pushed to this person's page that carries
//             the words the steps quote («Hello, Bob!», not the «Send»
//             pressed); with no words, the first pushed but the page's own
//             welcome; for an app that asks again and again, the first
//             answer it got
//   seen      the first words that changed on this person's screen: the
//             quoted ones, when the steps quote some
//
// Words on the screen that no pushed message carried came another way (an
// answer the page asked for, a history loaded late): the hand-off says it
// was not live, and the answer it likely came with.
//
// Each page keeps the last minute of what it sent, got and showed. Of what
// the messages say, nothing: only whether one carried the quoted words.

const KEEP_MS = 60_000;
const MOST = 300;
const SKEW_MS = 15;
// What a stream says the moment it opens is its own welcome (who is here,
// the state so far), not anybody's action.
const WELCOME_MS = 300;

/** In the page: when its words change, the last few hundred times, each with the first words it showed. */
export function changeScript() {
  const changes = [];
  window.__qaChanges = changes;
  const note = (text) => {
    const words = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!words) return;
    changes.push({ t: Date.now(), text: words.slice(0, 60), full: words.slice(0, 2000) });
    if (changes.length > 300) changes.splice(0, changes.length - 300);
  };
  const start = () => {
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') note(m.target.textContent);
        for (const n of m.addedNodes ?? []) note(n.textContent);
        // Somebody gone from a list is a change on the screen too.
        if (!m.addedNodes?.length) for (const n of m.removedNodes ?? []) if (n.textContent?.trim()) note(`− ${n.textContent}`);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

/**
 * In the page, as the worker asks for them: the changes since `after`, each
 * with whether it shows one of `words`; their words stay in the page.
 * @param {[number, string[]]} args
 */
export function changesSince([after, words]) {
  return (window.__qaChanges ?? [])
    .filter((c) => c.t >= after)
    .map((c) => ({ t: c.t, text: c.text, has: words.length > 0 && words.some((w) => (c.full ?? c.text).includes(w)) }));
}

/** The words a step's title quotes, «like this»: what travels from one person to another. */
export function quotedIn(title) {
  return [...String(title ?? '').matchAll(/«([^«»]{3,120})»|“([^“”]{3,120})”|"([^"]{3,120})"/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3]).replace(/\s+/g, ' ').trim())
    .filter((w) => w.length >= 3);
}

const keep = (list, item) => {
  list.push(item);
  const old = Date.now() - KEEP_MS;
  while (list.length > MOST || (list.length && list[0].t < old)) list.shift();
};

const where = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url ?? '').slice(0, 80);
  }
};

/** Whether a message holds the words, as written or as JSON escapes them. */
const holds = (payload, word) => typeof payload === 'string' && (payload.includes(word) || payload.includes(JSON.stringify(word).slice(1, -1)));

/**
 * A person's page, watched for what it sends and what it is sent: its
 * requests, its WebSocket messages both ways, the server-sent events it
 * gets, and its responses, through a CDP session of its own (Chromium
 * only). Each at the browser's own time, the clock the page's screen
 * changes are noted on: an event that reaches this process does so a few
 * milliseconds late, after the screen it changed. `quietly` keeps the
 * cockpit's own calls out of the trace. `inFlight` names the words the
 * recent steps quote: of each message pushed, which of them it carries.
 */
export async function watchRealtime(page, rt, quietly, inFlight = () => []) {
  // Chromium stamps its events on a clock of its own, and says now and then
  // where that clock stands against the wall's.
  let offset = null;
  const at = (e) => (offset !== null && Number.isFinite(e.timestamp) ? Math.round((e.timestamp + offset) * 1000) : Date.now());
  const anchor = (e) => {
    if (Number.isFinite(e.wallTime) && Number.isFinite(e.timestamp)) offset = e.wallTime - e.timestamp;
  };
  const asked = (e) => e.type === 'Fetch' || e.type === 'XHR';
  // When each stream opened (server-sent events, WebSocket), for its welcome.
  const opened = new Map();
  const pushed = (e, what, payload) =>
    keep(rt.got, { t: at(e), what, pushed: true, opened: opened.get(e.requestId) ?? null, carries: inFlight().filter((w) => holds(payload, w)) });
  try {
    const cdp = await quietly(page, () => page.context().newCDPSession(page));
    cdp.on('Network.requestWillBeSent', (e) => {
      anchor(e);
      if (asked(e)) keep(rt.sent, { t: at(e), what: `${e.request?.method} ${where(e.request?.url)}` });
    });
    cdp.on('Network.webSocketWillSendHandshakeRequest', anchor);
    cdp.on('Network.webSocketHandshakeResponseReceived', (e) => opened.set(e.requestId, at(e)));
    cdp.on('Network.responseReceived', (e) => {
      if (e.type === 'EventSource') opened.set(e.requestId, at(e));
      if (asked(e)) keep(rt.got, { t: at(e), what: `${e.response?.status} ${where(e.response?.url)}` });
    });
    cdp.on('Network.webSocketFrameSent', (e) => keep(rt.sent, { t: at(e), what: 'WebSocket' }));
    // A text frame's words are read for the quoted ones; a binary one's are not.
    cdp.on('Network.webSocketFrameReceived', (e) => pushed(e, 'WebSocket', e.response?.opcode === 1 ? e.response.payloadData : null));
    cdp.on('Network.eventSourceMessageReceived', (e) => pushed(e, `server-sent ${e.eventName || 'message'}`, e.data));
    await quietly(page, () => cdp.send('Network.enable'));
  } catch {
    // Not measured, then: the run is no worse for it.
  }
}

const label = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * The hand-off a step ends with for this person, or null: another person's
 * action since `since`, then what went and came, and what was seen.
 * @param {{ actor: string, acts: any[], since: number, rt: any, from: (actor: string) => any, changes: (after: number, words: string[]) => Promise<any[]>, step?: string }} o
 */
export async function handOff({ actor, acts, since, rt, from, changes, step }) {
  const cause = acts.findLast((a) => a.actor !== actor && a.t >= since);
  if (!cause) return null;
  // Their own action after it: what their screen did may be theirs.
  if (acts.some((a) => a.actor === actor && a.t > cause.t)) return null;
  const first = (list, after) => list.find((x) => x.t >= after) ?? null;
  const sent = first(from(cause.actor)?.sent ?? [], cause.t);
  const after = sent?.t ?? cause.t;
  const ms = (x) => (x ? Math.max(0, x.t - cause.t) : null);
  const out = (received, seen, more = {}) => ({
    from: cause.actor,
    what: cause.label ?? cause.name,
    sent: sent && { ms: ms(sent), what: sent.what },
    received: received && { ms: ms(received), what: received.what },
    seen: seen && { ms: Math.max(ms(seen), ms(received) ?? 0), text: seen.text },
    ...more,
  });
  const pushes = rt.got.filter((g) => g.pushed && g.t >= after);
  // The words that travel: quoted by the step that acted, or by this one,
  // but the names of what was pressed (a «Send» does not travel).
  const pressed = new Set(acts.filter((a) => a.step && (a.step === cause.step || a.step === step)).map((a) => label(a.label)));
  const words = [...new Set([...(cause.words ?? []), ...quotedIn(step)])].filter((w) => !pressed.has(label(w)));
  if (words.length) {
    const carrier = pushes.find((g) => g.carries?.some((w) => words.includes(w))) ?? null;
    const shown = (await changes(after, words)).find((c) => c.has) ?? null;
    if (carrier) {
      // The page's clock and Chromium's network one, read apart, may differ
      // by a millisecond or two: a screen changed by what came is looked
      // for from a little before it came, never before it was sent.
      const seen = shown && shown.t >= carrier.t - SKEW_MS ? shown : ((await changes(Math.max(after, carrier.t - SKEW_MS), words))[0] ?? null);
      return out(carrier, seen);
    }
    if (shown) {
      // On the screen, and no pushed message carried it: it came with an
      // answer the page asked for, likely the last before it showed.
      const via = rt.got.filter((g) => !g.pushed && g.t >= after && g.t <= shown.t + SKEW_MS).at(-1) ?? null;
      return out(null, shown, { live: false, via: via?.what ?? null });
    }
  }
  // No words to follow: the first pushed but a stream's own welcome (one
  // this page opened after the action, at the moment it opened); an app
  // that pushes nothing, the first answer it got.
  const streamed = rt.got.some((g) => g.pushed);
  const welcome = (g) => Number.isFinite(g.opened) && g.opened >= cause.t && g.t - g.opened < WELCOME_MS;
  const got = streamed ? (pushes.find((g) => !welcome(g)) ?? null) : first(rt.got, after);
  // Only its own stream's welcome came: nothing of the other's to measure.
  if (streamed && !got) return null;
  const seen = (await changes(got ? Math.max(after, got.t - SKEW_MS) : after, []))[0] ?? null;
  if (!got && !seen) return null;
  return out(got, seen);
}
