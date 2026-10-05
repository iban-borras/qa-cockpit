// A person's saved browser session: the project's own sign-in
// (config.signIn), then the context's storageState written to
// <state>/<id>.json, where the fixtures, «Play as» and the per-person MCP
// servers read it.
//
// A saved session MAY GO STALE: many apps keep a short-lived token and
// rotate the refresh token the first time a context uses it, so a file saved
// half an hour ago opens signed out. `replay` saves them again first unless
// every one is younger than config.sessions.freshFor.
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.mjs';
import { contextOptions, deviceFor, deviceLabel, resolveDevice, suiteDeviceOf } from './devices.mjs';
import * as cockpit from './worker.mjs';

/**
 * Sign one person in and save their session.
 * @param {any} browser Playwright's `browser` fixture
 * @param {any} rawConfig the project's config
 * @param {string} id the person's cast id
 * @param {{ email?: string, device?: string | object }} [override] for a person outside the cast, or another device
 */
export async function saveSession(browser, rawConfig, id, override = {}) {
  const config = resolveConfig(rawConfig);
  cockpit.configure(config);
  if (typeof config.signIn !== 'function') {
    throw new Error('The config has no `signIn({ page, person })`: QA Cockpit cannot sign anybody in.');
  }
  const known = config.cast.find((p) => p.id === id);
  const person = { ...(known ?? { id, name: id, email: null, badge: null }), ...override };
  // Signed in on the person's own device: some apps sign a phone in
  // through another screen, and the cockpit's photo of the sign-in is that
  // device's. The one the suite being run gives them, when it says
  // (devices.mjs); else the cast's.
  const suite = process.env.QA_SUITE;
  const device = override.device
    ? resolveDevice(config, override.device)
    : ((suite ? suiteDeviceOf(config, suite, id) : null) ?? deviceFor(config, id));
  const context = await browser.newContext(contextOptions(config, id, device));
  const page = await context.newPage();
  try {
    await config.signIn({ page, person, config });
    fs.mkdirSync(config.paths.state, { recursive: true });
    await context.storageState({ path: path.join(config.paths.state, `${id}.json`) });

    // With the cockpit on, a photo of where the sign-in lands, once the
    // project says its page has settled.
    if (cockpit.enabled) {
      await config.raw.sessions?.settled?.({ page, person })?.catch?.(() => {});
      await cockpit.photo({ actor: id, page, device: deviceLabel(device), step: 'Session saved', status: 'passed', test: 'Sessions' });
    }
  } finally {
    await context.close();
  }
}

/**
 * Save the sessions of several people: `ids`, or whoever
 * config.sessions.who() says has an account, or the whole cast.
 */
export async function saveSessions(browser, rawConfig, ids) {
  const config = resolveConfig(rawConfig);
  const who = ids ?? (config.sessions.who ? await config.sessions.who({ config }) : config.people);
  for (const id of who) await saveSession(browser, config.raw, id);
  return who;
}
