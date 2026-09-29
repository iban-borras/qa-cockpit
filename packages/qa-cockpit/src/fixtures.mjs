// The cast as fixtures. In a recording, `alice`, `bob`, ... are pages, each
// in its own browser context signed in from the session saved for them
// (<state>/<id>.json):
//
//   test('T1 · Bob sees Alice's message', async ({ alice, bob }) => { ... })
//
// Only the people a test names get a browser; the others cost nothing. The
// project's helpers (config.helpers: a `db`, a `mail` reader...) are
// fixtures too.
//
// Each person plays on their device (devices.mjs): the cast's, or the one a
// suite's recording says for its tests:
//
//   test.use({ devices: { marta: 'iPad Pro 11 landscape', bernat: 'iPhone 15' } });
//
// The package never imports Playwright itself: two copies of @playwright/test
// in one run make Playwright refuse to start. The project hands over its own
// `test`, in its fixtures file:
//
//   import { test as base, expect } from '@playwright/test';
//   import { cockpitFixtures } from 'qa-cockpit/fixtures';
//   import config from './qa-cockpit.config.mjs';
//   export const { test } = cockpitFixtures(base, config);
//   export { expect };
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.mjs';
import { contextOptions, deviceFor, deviceLabel } from './devices.mjs';
import * as cockpit from './worker.mjs';

/**
 * @param {any} base the project's `test`, from its own @playwright/test
 * @param {any} rawConfig the project's config (qa-cockpit.config.mjs)
 */
export function cockpitFixtures(base, rawConfig) {
  const config = resolveConfig(rawConfig);
  cockpit.configure(config);

  const statePath = (id) => path.join(config.paths.state, `${id}.json`);

  async function contextFor(browser, id, device = deviceFor(config, id)) {
    const state = statePath(id);
    if (!fs.existsSync(state)) {
      throw new Error(`No saved session for ${id} (${state}). Run: ${config.cli} setup <suite>`);
    }
    return browser.newContext({ ...contextOptions(config, id, device), storageState: state });
  }

  const person = (id) =>
    async ({ browser, devices }, use) => {
      const device = deviceFor(config, id, devices);
      const context = await contextFor(browser, id, device);
      const page = await context.newPage();
      await cockpit.register(id, page, deviceLabel(device));
      try {
        await use(page);
      } finally {
        await cockpit.unregister(id);
        await context.close();
      }
    };

  // `devices`: a test's own devices, by person (an option, set with test.use).
  const fixtures = { devices: [{}, { option: true }] };
  for (const p of config.cast) fixtures[p.id] = person(p.id);
  for (const [name, value] of Object.entries(config.helpers)) {
    // Playwright reads a fixture's dependencies from its first parameter,
    // which must be a destructuring pattern, even an empty one.
    fixtures[name] = async ({}, use) => {
      await use(value);
    };
  }
  const extended = base.extend(fixtures);

  // With the cockpit on, every step of a recording ends in a photo of the
  // people its title names (worker.mjs). The recordings keep calling
  // `test.step`; only this wrapper knows. The step's location is passed on
  // so reports still point at the recording's line, not at this file.
  // Without COCKPIT_URL nothing is wrapped and a replay runs as it always did.
  if (cockpit.enabled) {
    const plainStep = extended.step;
    const withPhotos = async (title, body, options = {}) => {
      const location = options.location ?? cockpit.callerLocation();
      return plainStep(
        title,
        async (info) => {
          const testInfo = extended.info();
          const where = { test: testInfo.title, location: cockpit.showLocation(location), outputDir: testInfo.outputDir };
          // A soft expect records its failure and lets the step go on: the
          // step that added one is a red step all the same, with its photo.
          const softBefore = testInfo.errors.length;
          // When the step began: its photo says how long it took, and each
          // click in it how long after the start it came.
          const began = Date.now();
          try {
            const result = await body(info);
            const soft = testInfo.errors.slice(softBefore);
            if (soft.length) {
              const error = new Error(soft.map((e) => e.message ?? String(e.value ?? '')).join('\n\n'));
              await cockpit.stepEnded({ title, status: 'failed', error, began, ...where });
            } else {
              await cockpit.stepEnded({ title, status: 'passed', began, ...where });
            }
            return result;
          } catch (error) {
            await cockpit.stepEnded({ title, status: 'failed', error, began, ...where });
            throw error;
          }
        },
        { ...options, location },
      );
    };
    Object.assign(withPhotos, { skip: plainStep.skip });
    extended.step = withPhotos;
  }

  return { test: extended, statePath, contextFor, config };
}
