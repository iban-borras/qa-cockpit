// QA Cockpit for the two-person chat in ../app: the whole contract between
// the app and the cockpit. Paths are relative to this file (`base`).
import { defineConfig } from 'qa-cockpit';
import { processStack } from 'qa-cockpit/process';

const PORT = '4310';

export default defineConfig({
  base: import.meta.url,
  name: 'Two-person chat',
  // Paths shown to people and agents (reports, copied messages) are
  // relative to this folder: the example's own root.
  root: '..',
  paths: {
    suites: 'suites',
    recordings: 'recordings',
    setups: 'setups',
    sessionsSetup: 'sessions.setup.mjs',
    skill: '../../../packages/qa-cockpit/templates/SKILL.md',
  },

  // The people of every suite, always the same, so a step can say «Alice»
  // without explaining who Alice is. Demo accounts of an app that only runs
  // here: the password is public on purpose.
  cast: {
    alice: { name: 'Alice', password: 'demo-pass-1' },
    bob: { name: 'Bob', password: 'demo-pass-1' },
  },

  // The app is one Node process this config starts and stops. Its test hooks
  // (DEMO_TEST_HOOKS) are what make `reset` possible.
  stack: processStack({
    base: import.meta.url,
    name: 'two-person-chat',
    command: process.execPath,
    args: ['../app/server.mjs'],
    env: { PORT, DEMO_TEST_HOOKS: '1' },
    app: `http://127.0.0.1:${PORT}`,
    health: '/health',
    reset: async ({ urls }) => {
      const r = await fetch(`${urls.app}/api/test/reset`, { method: 'POST' });
      if (!r.ok) throw new Error(`The app refused the reset (${r.status}): are its test hooks on?`);
      return 'Messages and sessions cleared.';
    },
  }),

  // How a person signs in: the real form, as they would.
  signIn: async ({ page, person }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill(person.id);
    await page.getByLabel('Password').fill(person.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText(`Signed in as ${person.name}`).waitFor();
  },

  browser: { locale: 'en-GB' },
  // Its own port, so it never meets another project's cockpit.
  cockpit: { port: 3160 },
});
