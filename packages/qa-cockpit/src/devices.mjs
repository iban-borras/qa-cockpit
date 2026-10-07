// Each person on their own device: the GM on a tablet, the players on their
// phones. A device is a name from Playwright's own list (`'iPhone 15'`,
// `'iPad Pro 11 landscape'`, `'Galaxy S24'`, `'Desktop Chrome'`...) or a size
// of your own:
//
//   { name: 'Laptop 13"', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }
//
// Where it is said, the nearest wins: a test's `test.use({ devices: { bob:
// 'iPhone 15' } })`, then the person's `device` in the cast, then the
// config's `browser.device` (Desktop Chrome by default). Every browser is
// Chromium: the size, the density, touch and the mobile flag are the
// device's; the engine stays the same.
import fs from 'node:fs';
import path from 'node:path';
import { recordingOf } from './config.mjs';
import { playwrightOf } from './playwright.mjs';

export const DEFAULT_DEVICE = 'Desktop Chrome';

// What a device changes in a browser context, and nothing else (a
// descriptor also names its default engine, which is not a context option).
const CONTEXT_KEYS = ['viewport', 'screen', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent'];

/** Phone, tablet, laptop or desktop: for the icon on the cockpit's card. */
function kindOf(options, explicit) {
  if (explicit) return explicit;
  const { width = 1280, height = 720 } = options.viewport ?? {};
  if (options.isMobile) return Math.min(width, height) < 600 ? 'phone' : 'tablet';
  return width < 1500 ? 'laptop' : 'desktop';
}

/**
 * A device, resolved: its name, its kind and the options of a context that
 * plays it.
 * @param {any} config the resolved config
 * @param {string | object | undefined} spec
 * @returns {{ name: string, kind: 'phone'|'tablet'|'laptop'|'desktop', width: number, height: number, context: object }}
 */
export function resolveDevice(config, spec) {
  const wanted = spec ?? config.browser.device ?? DEFAULT_DEVICE;
  let name;
  let source;
  let kind = null;
  if (typeof wanted === 'string') {
    const { devices } = playwrightOf(config);
    source = devices[wanted];
    if (!source) {
      // A size of the project's own goes by its name too, once a run has
      // played it: «Play as» names the device a person last played on, and
      // a recording's `test.use({ devices })` may have given it as an object.
      const own = ownDeviceNamed(config, wanted);
      if (own) {
        source = own;
        kind = own.kind ?? null;
      }
    }
    if (!source) {
      const near = Object.keys(devices).filter((n) => n.toLowerCase().includes(wanted.toLowerCase().split(' ')[0])).slice(0, 5);
      throw new Error(`No device named «${wanted}» in Playwright's list, nor among the project's own sizes its runs played${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}.`);
    }
    name = wanted;
  } else {
    source = wanted;
    name = wanted.name ?? `${wanted.viewport?.width}×${wanted.viewport?.height}`;
    kind = wanted.kind ?? null;
  }
  const context = Object.fromEntries(CONTEXT_KEYS.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
  return {
    name,
    kind: kindOf(context, kind),
    width: context.viewport?.width ?? null,
    height: context.viewport?.height ?? null,
    context,
  };
}

/** The device a person plays on, given a test's own `devices` option. */
export function deviceFor(config, id, overrides = {}) {
  const person = config.cast.find((p) => p.id === id);
  return resolveDevice(config, overrides[id] ?? person?.device);
}

/**
 * The person's own browser context options, from the cast (`context`): a
 * locale, a time zone, the headers a proxy in front of the app would add...
 */
export function personContext(config, id) {
  return config.cast.find((p) => p.id === id)?.context ?? {};
}

/** A context for a person on a device: the device's options, then the person's own, which win. */
export function contextOptions(config, id, device) {
  return { ...device.context, ...personContext(config, id) };
}

/** What the cockpit shows of a device: no context options, only what it is. */
export function deviceLabel(device) {
  return { name: device.name, kind: device.kind, width: device.width, height: device.height };
}

// THE DEVICE A SUITE GIVES EACH PERSON, known before its recording runs: a
// session is signed in on it (sessions.mjs), so that the sign-in, and the
// cockpit's photo of it, are on the device the person plays on and not on
// the cast's (found in CritKeep, whose cast says no device: each suite
// gives its own). The recording says it in `test.use({ devices })`, read
// here as text: the person's first mention, a device named in quotes; or
// a constant, whose device is the one the suite's last run gave them,
// which the fixtures note in <out>/devices.json. A person the recording
// never names plays on the cast's. A suite run through the CLI is named in
// QA_SUITE, each command's run in QA_RUN_ID.

const devicesFileOf = (config) => path.join(config.paths.out, 'devices.json');

function noted(config) {
  try {
    return JSON.parse(fs.readFileSync(devicesFileOf(config), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/**
 * Each person a recording's `test.use({ devices })` names, at their first
 * mention in the file: the device's name when it is in quotes, else null
 * (a constant, an object).
 * @returns {Record<string, string | null>}
 */
function recordedDevices(config, suite) {
  let text = '';
  try {
    text = fs.readFileSync(recordingOf(config, suite) ?? '', 'utf8');
  } catch {
    return {};
  }
  const first = {};
  for (const [, block] of text.matchAll(/test\.use\(\s*\{[^)]*?\bdevices\s*:\s*\{([^}]*)\}/g)) {
    for (const [, who, , quoted] of block.matchAll(/(\w+)\s*:\s*(?:(['"`])([^'"`]+)\2|[\w.[\]]+)/g)) {
      if (!(who in first)) first[who] = quoted ?? null;
    }
  }
  return first;
}

/** A size of the project's own that a run played, by its name, as noted; null when none is so named. */
function ownDeviceNamed(config, wanted) {
  for (const people of Object.values(noted(config))) {
    for (const entry of Object.values(people ?? {})) {
      if (entry?.device?.name === wanted) return entry.device;
    }
  }
  return null;
}

/** The device a suite gives a person, or null when its recording names none for them (the cast's, then). */
export function suiteDeviceOf(config, suite, id) {
  const recorded = recordedDevices(config, suite);
  if (!(id in recorded)) return null;
  const spec = recorded[id] ?? noted(config)[suite]?.[id]?.device;
  if (!spec) return null;
  try {
    return resolveDevice(config, spec);
  } catch {
    // A name Playwright does not have: the cast's.
    return null;
  }
}

/** A test of the suite's recording gives a person this device: noted, the first one of each run. */
export function noteSuiteDevice(config, suite, id, device) {
  try {
    const all = noted(config);
    const run = process.env.QA_RUN_ID ?? null;
    if (all[suite]?.[id] && all[suite][id].run === run) return;
    all[suite] = { ...all[suite], [id]: { device: { ...device.context, name: device.name, kind: device.kind }, run } };
    const file = devicesFileOf(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 1));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // Not noted: the next session is signed in as the recording's text says, or on the cast's device.
  }
}
