// QA Cockpit for {{NAME}}: the whole contract between the app and the
// cockpit. Paths are relative to this file (`base`). Fill every TODO, then
// run `npx qa-cockpit doctor` until everything says ok. SKILL.md, beside
// this file, says how («Setting it up in a project»); an agent can do it.
import { defineConfig, loadEnv } from 'qa-cockpit';
import { composeStack } from 'qa-cockpit/compose';
import { processStack } from 'qa-cockpit/process';

// What differs from one machine to the next (a port this machine's own dev
// server already takes...) goes in .env beside this file, never committed;
// .env.example lists what may go there. The environment wins over it.
loadEnv(import.meta.url);
const APP_PORT = process.env.QA_APP_PORT ?? '4400';

export default defineConfig({
  base: import.meta.url,
  name: '{{NAME}}',
  // The repository's root: paths shown to people and agents are relative to it.
  root: '{{ROOT}}',
  paths: {
    suites: 'suites',
    recordings: 'recordings',
    setups: 'setups',
    sessionsSetup: 'sessions.setup.mjs',
    skill: 'SKILL.md',
  },

  // TODO: the people of every suite, always the same, so a step can say
  // «Alice» without explaining who Alice is. Fake accounts of the QA copy
  // of the app only: their passwords may sit here. A person may also say
  // their `device` ('iPhone 15'...) and their own browser `context`
  // (Playwright's options: `locale: 'es-ES'`, `timezoneId`, or the
  // `extraHTTPHeaders` a proxy in front of the app would add).
  cast: {
    alice: { name: 'Alice', email: 'alice@example.com', password: 'change-me' },
    bob: { name: 'Bob', email: 'bob@example.com', password: 'change-me' },
  },

  // TODO: a copy of the app that tests may break, never the developer's own
  // instance. Keep ONE of the two and delete the other.
  //
  // One process of your own (`npm run dev`, `node server.mjs`):
  stack: processStack({
    base: import.meta.url,
    name: '{{PROJECT}}',
    command: 'npm',
    args: ['run', 'dev'],
    cwd: '{{ROOT}}',
    env: { PORT: APP_PORT },
    app: `http://127.0.0.1:${APP_PORT}`,
    health: null,
    // Fresh data for a replay: a test-only endpoint of the app, a script...
    // reset: async ({ urls }) => { await fetch(`${urls.app}/api/test/reset`, { method: 'POST' }) },
  }),
  //
  // Docker Compose, as a project of its own (its ports, its volumes). Its
  // host ports are the QA override's; there, `"${QA_APP_PORT:-4400}:3000"`
  // takes this machine's port from .env too:
  // stack: composeStack({
  //   base: import.meta.url,
  //   project: '{{PROJECT}}-qa',
  //   cwd: '{{ROOT}}',
  //   files: ['docker-compose.yml', 'qa/compose.qa.yml'],
  //   app: { service: 'web', port: 3000 },
  //   api: { service: 'api', port: 8000, health: '/health' },
  // }),

  // TODO: the app's real sign-in, as the person uses it, ending when the app
  // shows them signed in. The package saves the session; every fixture
  // reuses it.
  signIn: async ({ page, person }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(person.email);
    await page.getByLabel('Password').fill(person.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  },

  browser: { locale: 'en-GB' },

  // If the app speaks other languages: which, and how a person changes it,
  // with its own control (`replay --languages`; `languages check` tries it).
  // The suites play in browser.locale's.
  // languages: {
  //   others: ['ca', 'es'],
  //   priority: ['es'],   // looked at when a run names none; all of them otherwise
  //   names: { tlh: 'Klingon' },   // for a code no browser names
  //   async switchTo({ page, lang }) {
  //     await page.getByTestId('lang').selectOption(lang);
  //   },
  //   // Before each step's look: wait until its screen can be changed, or
  //   // return why not (that step is skipped, untouched).
  //   // async ready({ page }) {
  //   //   if (await page.getByRole('dialog').isVisible()) return 'a dialog is open';
  //   // },
  // },

  // What changes on a screen by itself (a clock, a date, an avatar), as
  // selectors: left out when a run is compared with an earlier one
  // (`replay --changes`).
  // changes: {
  //   mask: ['[data-testid=clock]', '.last-seen'],
  // },

  // Demo videos of the suites (`qa-cockpit video`), if you ever make them:
  // the product's name on the cards, each person's role on their label, a
  // logo for a dark background, the colours, the words of the subtitles.
  // video: {
  //   product: '{{NAME}}',
  //   roles: { alice: 'Host', bob: 'Guest' },
  //   logo: 'brand/logo-on-dark.svg',
  //   colors: { accent: '#5b9dff' },
  //   labels: { sees: 'Sees' },
  //   music: 'brand/soundtrack.mp3',     // your own track; the package makes one otherwise
  //   loudness: -16,                     // LUFS; null leaves the sound as mixed
  //   warm: ['/dashboard'],              // pages opened first, to load warm (no side effects)
  //   cache: ['script', 'stylesheet', 'font', 'image'], // 'image' if no image changes at the same address
  // },
});
