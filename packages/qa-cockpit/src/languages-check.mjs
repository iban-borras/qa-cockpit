// `languages check`: the project's change of language (`languages.switchTo`
// in the config) tried on one person's first screen, before a run relies on
// it. Each other language and back: whether its words change, whether the
// page loads again (then what is open on a screen is lost at each step),
// whether the screen comes back word for word; a photo of each, for the
// agent who wrote it to look at.
import fs from 'node:fs';
import path from 'node:path';
import { contextOptions, deviceFor } from './devices.mjs';
import { compare, langSaid, nameless, notReady, printOf, scanTexts, settle, switchTo } from './languages.mjs';
import { playwrightOf } from './playwright.mjs';

const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

/**
 * @param {any} config the resolved config
 * @param {string} id the person whose saved session plays it
 * @param {(line: string) => void} say
 * @returns {Promise<boolean>} whether a run can rely on it
 */
export async function checkLanguages(config, id, say) {
  const { base, others, names } = config.languages;
  const said = (code) => langSaid(config, code);
  const person = config.cast.find((p) => p.id === id) ?? { id, name: id };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(config.paths.out, 'languages', `check-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const { chromium } = playwrightOf(config);
  const browser = await chromium.launch();
  let ok = true;
  try {
    const device = deviceFor(config, id);
    const context = await browser.newContext({ ...contextOptions(config, id, device), storageState: path.join(config.paths.state, `${id}.json`) });
    const page = await context.newPage();
    await page.goto(new URL(config.browser.landing, config.stack.urls().app).href, { waitUntil: 'load' });
    // A first screen is often still filling in after its load: the screen
    // to come back to is the one at rest, its requests over and its words
    // still, as a step's end is (lookInLanguages).
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const why = await notReady(config, page, person);
    if (why) {
      say(`${person.name} at ${page.url()}: ${why}. The first screen must be one the change can be made on.`);
      await context.close();
      return false;
    }
    await settle(page, () => true, 5_000, 1_000);
    const shoot = async (name) => {
      const file = path.join(dir, `${name}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 70, fullPage: true });
      return file;
    };
    let loads = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) loads += 1;
    });
    say(`${person.name} on ${device.name}, at ${page.url()}`);
    const before = await page.evaluate(printOf);
    const baseScan = await page.evaluate(scanTexts);
    say(`  ${said(base)}, the suites' own: ${await shoot(base)}`);
    const told = new Set();
    for (const lang of others) {
      const at = await page.evaluate(printOf);
      const loadsBefore = loads;
      const t0 = Date.now();
      try {
        await switchTo(config, page, lang, person);
      } catch (e) {
        ok = false;
        say(`  ${said(lang)}: the change failed: ${firstLine(e)}`);
        continue;
      }
      const changed = await settle(page, (p) => p !== at, 4_000);
      const file = await shoot(lang);
      const reloaded = loads > loadsBefore;
      say(
        `  ${said(lang)}: ${changed ? `its words changed, in ${Date.now() - t0} ms` : 'NO WORD CHANGED: does the change reach this screen?'}` +
          `${reloaded ? '; the page loaded again (in a run, what is open on a screen, a dialog or a form half filled, would be lost at each step)' : ''}: ${file}`,
      );
      if (!changed) ok = false;
      for (const x of compare(baseScan, await page.evaluate(scanTexts), lang, told, '')) say(`    ${x.rule}: «${x.text}»`);
      try {
        await switchTo(config, page, base, person);
      } catch (e) {
        ok = false;
        say(`  back to ${said(base)}: the change failed: ${firstLine(e)}`);
        break;
      }
      const same = await settle(page, (p) => p === before, 4_000);
      say(`  back to ${said(base)}: ${same ? 'the very same screen' : 'NOT THE SAME SCREEN: a run would stop looking at languages there'}`);
      if (!same) {
        ok = false;
        break;
      }
    }
    // The languages the browser cannot name, which the cockpit would show
    // by their code: the config's `languages.names` names them.
    const unnamed = (await page.evaluate(nameless, [base, ...others])).filter((code) => !names[code]);
    if (unnamed.length) {
      const one = unnamed.length === 1;
      say(
        `  The browser has no name for ${unnamed.join(', ')}: the cockpit shows ${one ? 'its code' : 'their codes'}. ` +
          `\`languages.names\` in the config names ${one ? 'it' : 'them'} ({ ${unnamed[0]}: '…' }).`,
      );
    }
    await context.close();
  } finally {
    await browser.close();
  }
  say(ok ? `Each language changes, and comes back: a run can rely on it. Photos in ${dir}` : `Not to rely on as it is (above). Photos in ${dir}`);
  return ok;
}
