// QA Cockpit for {{NAME}}: the whole contract between the app and the
// cockpit. Paths are relative to this file (`base`). Fill every TODO, then
// run `npx qa-cockpit doctor` until everything says ok. SKILL.md, beside
// this file, says how («Setting it up in a project»); an agent can do it.
import { defineConfig } from 'qa-cockpit';
import { composeStack } from 'qa-cockpit/compose';
import { processStack } from 'qa-cockpit/process';

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
  // of the app only: their passwords may sit here.
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
    command: 'npm',
    args: ['run', 'dev'],
    cwd: '{{ROOT}}',
    env: { PORT: '4400' },
    app: 'http://127.0.0.1:4400',
    health: null,
    // Fresh data for a replay: a test-only endpoint of the app, a script...
    // reset: async ({ urls }) => { await fetch(`${urls.app}/api/test/reset`, { method: 'POST' }) },
  }),
  //
  // Docker Compose, as a project of its own (its ports, its volumes):
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
});
