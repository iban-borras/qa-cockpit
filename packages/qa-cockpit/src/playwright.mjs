// The project's playwright.config, made from its QA Cockpit config:
//
//   import { playwrightConfig } from 'qa-cockpit/playwright';
//   import config from './qa-cockpit.config.mjs';
//   export default playwrightConfig(config);
//
// The suites share ONE database and go in order: no parallelism between
// tests. The people of a suite act in parallel inside a test, each in their
// own browser context (fixtures.mjs). With the cockpit on (COCKPIT_URL, set
// for the runs it starts or follows), a reporter tells it about every step,
// and every test keeps its trace: the per-action detail behind each photo.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.mjs';
import { resolveDevice } from './devices.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The project's own @playwright/test (never a second copy: see fixtures.mjs). */
export function playwrightOf(config) {
  return createRequire(path.join(config.paths.project, 'package.json'))('@playwright/test');
}

/**
 * @param {any} rawConfig the project's config
 * @param {object} [overrides] merged over the result, `use` included
 */
export function playwrightConfig(rawConfig, overrides = {}) {
  const config = resolveConfig(rawConfig);
  const cockpit = Boolean(process.env.COCKPIT_URL);
  const reporters = [['list'], ['html', { open: 'never', outputFolder: path.join(config.paths.out, 'report') }]];
  if (cockpit) {
    reporters.push([path.join(HERE, 'reporter.mjs'), { cast: config.cast.map(({ id, name }) => ({ id, name })) }]);
  }
  const testDir = config.playwright.testDir ? path.resolve(config.paths.project, config.playwright.testDir) : config.paths.project;
  const rel = (abs) => path.relative(testDir, abs).split(path.sep).join('/');
  const testMatch = config.playwright.testMatch ?? [
    `${rel(config.paths.recordings)}/**/*.spec.{ts,mjs,js}`,
    `${rel(config.paths.setups)}/**/*.setup.{ts,mjs,js}`,
    ...(config.paths.sessionsSetup ? [rel(config.paths.sessionsSetup)] : []),
    ...(config.paths.smoke ? [rel(config.paths.smoke)] : []),
  ];
  const { use: extraUse, ...rest } = overrides;
  // A video's run (`qa-cockpit video`, video/capture.mjs) brings its own
  // screencast per person. The trace's and Playwright's video would be two
  // more on the same page, and they starve each other: measured, the trace
  // got half its frames, late. The trace keeps its DOM snapshots, the part
  // that serves to debug. In «motion» the app's animations are what the
  // video is for: the capture turns them on, page by page, in the tests the
  // video shows (video/capture.mjs); the tests that only build their data
  // keep the config's reducedMotion.
  const video = process.env.QA_VIDEO_DIR ? process.env.QA_VIDEO_MODE || 'guide' : null;
  const trace = video
    ? { mode: cockpit ? 'on' : 'retain-on-failure', screenshots: false, snapshots: true, sources: true }
    : cockpit
      ? 'on'
      : 'retain-on-failure';
  return {
    testDir,
    testMatch,
    testIgnore: ['**/node_modules/**'],
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: config.playwright.timeout ?? 120_000,
    expect: { timeout: config.playwright.expectTimeout ?? 30_000 },
    // In a container, the container's own disk (docker/runner-entry.mjs
    // copies it back at the end): tracing zips its resources while other
    // contexts are still writing them, and on a bind mount from Windows that
    // race is lost.
    outputDir: process.env.QA_OUTPUT_DIR || path.join(config.paths.out, 'test-results'),
    reporter: reporters,
    use: {
      // The config's device for any page a person does not own (a setup's
      // `page`, a guest); each person's own comes from the fixtures.
      ...resolveDevice(config).context,
      // Resolved from the running stack; refuses when it is down.
      baseURL: config.stack.urls().app,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId,
      // An app that honours this preference turns its animations off: no
      // entrance animation to wait out, and photos come out settled.
      reducedMotion: config.browser.reducedMotion,
      trace,
      screenshot: 'only-on-failure',
      video: video ? 'off' : 'retain-on-failure',
      ...config.playwright.use,
      ...extraUse,
    },
    projects: [{ name: 'chromium' }],
    ...rest,
  };
}
