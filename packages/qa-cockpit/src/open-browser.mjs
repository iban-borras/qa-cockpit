// «Play as …»: a NEW browser window signed in as one person of the cast,
// from their saved session, for a human to poke at the app by hand. It is
// not the browser a recording drives; that one is watched live from the
// cockpit's inspector.
//
//   QA_COCKPIT_CONFIG=<config file> FRONTEND_URL=<app> node open-browser.mjs <person>
//
// On the person's usual device, or the one QA_DEVICE names (the cockpit
// passes the device they last played on). A desktop opens maximized; a phone
// or a tablet opens at its own size, with touch and its density.
//
// Prints READY once the page has loaded, which is what the cockpit waits
// for; the window then stays until somebody closes it. It appears on the
// desktop of whoever started the process (see server/server.mjs).
//
// Opened by the cockpit (QA_PLAY_SESSION and the rest), the window is
// followed for a report (play.mjs): the person's actions, each with the
// window just before it, the page's requests and errors. For the package's
// own tests only, QA_PLAY_HEADLESS=1 and QA_PLAY_DEBUG_PORT=<port> let a
// script play in it.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { deviceFor, deviceLabel, personContext, resolveDevice } from './devices.mjs';
import { followPlay } from './play.mjs';
import { playwrightOf } from './playwright.mjs';

/**
 * The device the cockpit names (the one the person last played on), or their
 * usual one when that name is nobody's: a window on another size is better
 * than none.
 */
function lastOrUsual(config, id) {
  if (process.env.QA_DEVICE) {
    try {
      return resolveDevice(config, process.env.QA_DEVICE);
    } catch (error) {
      console.error(`${error.message} The usual device instead.`);
    }
  }
  return deviceFor(config, id);
}

const person = process.argv[2];
if (!person || !/^[a-z][a-z0-9_]*$/.test(person)) {
  console.error('Usage: node open-browser.mjs <person>');
  process.exit(1);
}

try {
  const config = await loadConfig(process.env.QA_COCKPIT_CONFIG || process.cwd());
  const sessionFile = path.join(config.paths.state, `${person}.json`);
  if (!fs.existsSync(sessionFile)) {
    console.error(`No saved session for ${person}: ${sessionFile}. Run: ${config.cli} setup <suite>`);
    process.exit(1);
  }
  const front = process.env.FRONTEND_URL || config.stack.urls().app;
  const device = lastOrUsual(config, person);
  const big = device.kind === 'laptop' || device.kind === 'desktop';
  const { chromium } = playwrightOf(config);
  const debug = Number(process.env.QA_PLAY_DEBUG_PORT) || null;
  const browser = await chromium.launch({
    headless: process.env.QA_PLAY_HEADLESS === '1',
    args: [...(big ? ['--start-maximized'] : []), ...(debug ? [`--remote-debugging-port=${debug}`] : [])],
  });
  // A computer's window is the person's own, maximized: no fixed size, and
  // then Playwright takes no density, touch or mobile flag either (only the
  // browser's name). A phone's or a tablet's window is the device's own.
  const { viewport, screen, deviceScaleFactor, isMobile, hasTouch, ...rest } = device.context;
  // The person's own options from the cast (a locale, headers...) win, but
  // a computer's window keeps the size the person gives it.
  const own = personContext(config, person);
  const { viewport: ownViewport, screen: ownScreen, ...ownRest } = own;
  const context = await browser.newContext({
    ...(big ? { ...rest, viewport: null } : device.context),
    storageState: sessionFile,
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    ...(big ? ownRest : own),
  });
  const page = await context.newPage();
  // Followed for a report, from its first page on.
  const session = process.env.QA_PLAY_SESSION;
  const followed =
    session && process.env.QA_PLAY_DIR && process.env.COCKPIT_URL
      ? await followPlay({
          context,
          device: deviceLabel(device),
          dir: process.env.QA_PLAY_DIR,
          send: (events) =>
            fetch(`${process.env.COCKPIT_URL}/api/play/event`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session, token: process.env.QA_PLAY_TOKEN, events }),
              signal: AbortSignal.timeout(5_000),
            }),
        }).catch(() => null)
      : null;
  await page.goto(new URL(config.browser.landing, front).href);
  console.log('READY');
  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
    context.on('close', resolve);
    page.on('close', resolve);
  });
  await followed?.stop();
  await browser.close().catch(() => {});
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
