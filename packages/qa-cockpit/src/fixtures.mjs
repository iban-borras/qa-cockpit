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
import { recordingOf, resolveConfig } from './config.mjs';
import { contextOptions, deviceFor, deviceLabel, noteSuiteDevice } from './devices.mjs';
import * as network from './network/capture.mjs';
import * as video from './video/capture.mjs';
import * as cockpit from './worker.mjs';

/**
 * @param {any} base the project's `test`, from its own @playwright/test
 * @param {any} rawConfig the project's config (qa-cockpit.config.mjs)
 */
export function cockpitFixtures(base, rawConfig) {
  const config = resolveConfig(rawConfig);
  cockpit.configure(config);
  network.configure(config);

  const statePath = (id) => path.join(config.paths.state, `${id}.json`);

  async function contextFor(browser, id, device = deviceFor(config, id), extra = {}) {
    const state = statePath(id);
    if (!fs.existsSync(state)) {
      throw new Error(`No saved session for ${id} (${state}). Run: ${config.cli} setup <suite>`);
    }
    return browser.newContext({ ...contextOptions(config, id, device), ...extra, storageState: state });
  }

  // A video's run, before the first person's browser opens: the pages the
  // config names (`video.warm`), opened by the first person with a saved
  // session, so the first screen filmed comes from a warm cache
  // (video/capture.mjs). Here and not in a fixture of the worker's: one
  // would start a browser for every run, videos or not.
  let warmed = false;
  async function warmOnce(browser) {
    if (warmed || !video.enabled || !config.video.warm.length) return;
    warmed = true;
    const id = config.people.find((p) => fs.existsSync(statePath(p)));
    if (!id) return;
    try {
      const app = config.stack.urls().app;
      const context = await contextFor(browser, id);
      await video.warm(
        context,
        config.video.warm.map((u) => new URL(u, app).href),
        config.video.cache,
      );
      await context.close();
    } catch {
      // Cold, then: the video is made all the same.
    }
  }

  const person = (id) =>
    async ({ browser, devices }, use, testInfo) => {
      await warmOnce(browser);
      const device = deviceFor(config, id, devices);
      // The device this suite gives the person, noted for the sessions of
      // its next runs (devices.mjs): the recording's tests only, a setup's
      // are not the suite's.
      const suite = process.env.QA_SUITE;
      const recording = suite ? recordingOf(config, suite) : null;
      if (recording && path.relative(testInfo.file, recording) === '') noteSuiteDevice(config, suite, id, device);
      // For `replay --network` (network/capture.mjs): Playwright's HAR of
      // this person's context, cleaned of its secrets when it closes.
      const har = network.harFor(id, testInfo);
      let context;
      try {
        context = await contextFor(browser, id, device, har?.options);
      } catch (e) {
        network.discard(har);
        throw e;
      }
      await network.watch(har, context);
      // A video's run serves the app's code from memory after its first
      // fetch, to every person (video/capture.mjs).
      await video.cacheFor(context, config.video.cache);
      const page = await context.newPage();
      await cockpit.register(id, page, deviceLabel(device));
      // For `qa-cockpit video` (video/capture.mjs): the page's own frames,
      // which the cockpit's live view then shares: two screencasts on one
      // page starve each other. Only in the tests the video shows.
      await video.startCapture(id, page, device, (frame) => cockpit.liveFrame(id, frame), testInfo.title);
      if (video.capturing(page)) cockpit.sharedFrames(id);
      try {
        await use(page);
      } finally {
        await video.stopCapture(page);
        await cockpit.unregister(id);
        try {
          await context.close();
        } finally {
          // Playwright has written its HAR on closing: the clean one goes to
          // the run, the raw one is deleted, even if the close went wrong.
          await network.saved(har, { testInfo, device: deviceLabel(device) });
        }
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
  // people its title names, after one of each action it took (worker.mjs).
  // The recordings keep calling `test.step`; only this wrapper knows. The
  // step's location is passed on so reports still point at the recording's
  // line, not at this file.
  // Without COCKPIT_URL nothing is wrapped and a replay runs as it always did.
  // A video's run (video/capture.mjs) wraps them too: it notes when each
  // step began and ended, on the clock of its frames. So does a look at the
  // network (network/capture.mjs): each request goes in the step it began in.
  if (cockpit.enabled || video.enabled || network.enabled) {
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
          let ended = null;
          // The photos' clock: the step's time is told without them.
          const photosFrom = cockpit.stepBegan();
          try {
            const result = await body(info);
            ended = Date.now();
            network.stepRecorded(testInfo, {
              title,
              began,
              ended,
              status: testInfo.errors.length > softBefore ? 'failed' : 'passed',
            });
            if (video.shows(testInfo.title)) {
              await video.settleAll();
              video.stepRecorded({
                test: testInfo.title,
                title,
                began,
                ended: Date.now(),
                people: cockpit.peopleIn(title),
                urls: video.pageUrls(),
              });
            }
            const soft = testInfo.errors.slice(softBefore);
            if (soft.length) {
              const error = new Error(soft.map((e) => e.message ?? String(e.value ?? '')).join('\n\n'));
              await cockpit.stepEnded({ title, status: 'failed', error, began, photosFrom, ...where });
            } else {
              await cockpit.stepEnded({ title, status: 'passed', began, photosFrom, ...where });
            }
            return result;
          } catch (error) {
            if (ended === null) network.stepRecorded(testInfo, { title, began, ended: Date.now(), status: 'failed' });
            await cockpit.stepEnded({ title, status: 'failed', error, began, photosFrom, ...where });
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
