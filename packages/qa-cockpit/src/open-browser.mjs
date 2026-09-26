// «Play as …»: a NEW browser window signed in as one person of the cast,
// from their saved session, for a human to poke at the app by hand. It is
// not the browser a recording drives; that one is watched live from the
// cockpit's inspector.
//
//   QA_COCKPIT_CONFIG=<config file> FRONTEND_URL=<app> node open-browser.mjs <person>
//
// Prints READY once the page has loaded, which is what the cockpit waits
// for; the window then stays until somebody closes it. It appears on the
// desktop of whoever started the process (see server/server.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { playwrightOf } from './playwright.mjs';

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
  const { chromium } = playwrightOf(config);
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    storageState: sessionFile,
    viewport: null,
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
  });
  const page = await context.newPage();
  await page.goto(new URL(config.browser.landing, front).href);
  console.log('READY');
  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
    context.on('close', resolve);
    page.on('close', resolve);
  });
  await browser.close().catch(() => {});
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
