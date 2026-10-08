// How long what one person does takes to reach another's screen
// (`replay --realtime`). A recording of several people says it in its own
// steps: «2 · Alice: presses «Send»», then «3 · Bob: sees it arrive». When
// a step ends for somebody who did nothing since another person acted, that
// is a hand-off, measured from the other person's action:
//
//   sent      the first request or WebSocket message their page made
//   received  the first message pushed to this person's page (WebSocket,
//             server-sent events), or, for an app that asks again and
//             again, the first response it got
//   seen      the first words that changed on this person's screen
//
// Each page keeps the last minute of what it sent, got and showed; nothing
// of what the messages say, only when, and the first words seen.

const KEEP_MS = 60_000;
const MOST = 300;
const SKEW_MS = 15;

/** In the page: when its words change, the last few hundred times, each with the first words it showed. */
export function changeScript() {
  const changes = [];
  window.__qaChanges = changes;
  const note = (text) => {
    const words = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!words) return;
    changes.push({ t: Date.now(), text: words.slice(0, 60) });
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

/**
 * A person's page, watched for what it sends and what it is sent: its
 * requests, its WebSocket messages both ways, the server-sent events it
 * gets, and its responses, through a CDP session of its own (Chromium
 * only). Each at the browser's own time, the clock the page's screen
 * changes are noted on: an event that reaches this process does so a few
 * milliseconds late, after the screen it changed. `quietly` keeps the
 * cockpit's own calls out of the trace.
 */
export async function watchRealtime(page, rt, quietly) {
  // Chromium stamps its events on a clock of its own, and says now and then
  // where that clock stands against the wall's.
  let offset = null;
  const at = (e) => (offset !== null && Number.isFinite(e.timestamp) ? Math.round((e.timestamp + offset) * 1000) : Date.now());
  const anchor = (e) => {
    if (Number.isFinite(e.wallTime) && Number.isFinite(e.timestamp)) offset = e.wallTime - e.timestamp;
  };
  const asked = (e) => e.type === 'Fetch' || e.type === 'XHR';
  try {
    const cdp = await quietly(page, () => page.context().newCDPSession(page));
    cdp.on('Network.requestWillBeSent', (e) => {
      anchor(e);
      if (asked(e)) keep(rt.sent, { t: at(e), what: `${e.request?.method} ${where(e.request?.url)}` });
    });
    cdp.on('Network.webSocketWillSendHandshakeRequest', anchor);
    cdp.on('Network.responseReceived', (e) => {
      if (asked(e)) keep(rt.got, { t: at(e), what: `${e.response?.status} ${where(e.response?.url)}` });
    });
    cdp.on('Network.webSocketFrameSent', (e) => keep(rt.sent, { t: at(e), what: 'WebSocket' }));
    cdp.on('Network.webSocketFrameReceived', (e) => keep(rt.got, { t: at(e), what: 'WebSocket', pushed: true }));
    cdp.on('Network.eventSourceMessageReceived', (e) => keep(rt.got, { t: at(e), what: `server-sent ${e.eventName || 'message'}`, pushed: true }));
    await quietly(page, () => cdp.send('Network.enable'));
  } catch {
    // Not measured, then: the run is no worse for it.
  }
}

/**
 * The hand-off a step ends with for this person, or null: another person's
 * action since `since`, then what went and came, and the first words seen.
 * @param {{ actor: string, acts: any[], since: number, rt: any, from: (actor: string) => any, changes: (after: number) => Promise<any[]> }} o
 */
export async function handOff({ actor, acts, since, rt, from, changes }) {
  const cause = acts.findLast((a) => a.actor !== actor && a.t >= since);
  if (!cause) return null;
  // Their own action after it: what their screen did may be theirs.
  if (acts.some((a) => a.actor === actor && a.t > cause.t)) return null;
  const first = (list, after) => list.find((x) => x.t >= after) ?? null;
  const sent = first(from(cause.actor)?.sent ?? [], cause.t);
  const after = sent?.t ?? cause.t;
  const pushed = rt.got.filter((g) => g.pushed);
  const got = first(pushed.length ? pushed : rt.got, after);
  // The page's clock and Chromium's network one, read apart, may differ by
  // a millisecond or two: a screen changed by what came is looked for from
  // a little before it came, never before it was sent.
  const seen = (await changes(got ? Math.max(after, got.t - SKEW_MS) : after))[0] ?? null;
  if (!got && !seen) return null;
  const ms = (x) => (x ? Math.max(0, x.t - cause.t) : null);
  return {
    from: cause.actor,
    what: cause.label ?? cause.name,
    sent: sent && { ms: ms(sent), what: sent.what },
    received: got && { ms: ms(got), what: got.what },
    seen: seen && { ms: Math.max(ms(seen), ms(got) ?? 0), text: seen.text },
  };
}
