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
      const near = Object.keys(devices).filter((n) => n.toLowerCase().includes(wanted.toLowerCase().split(' ')[0])).slice(0, 5);
      throw new Error(`No device named «${wanted}» in Playwright's list${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}.`);
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
