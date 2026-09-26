// The setup of suites/example.md: one test per row of its «Setup» table,
// each with the check the row names. A setup half done gives suites that lie.
// `npx qa-cockpit setup example` runs it, after `reset`.
import { test, expect } from '@playwright/test';
import { saveSession } from 'qa-cockpit/sessions';
import config from '../qa-cockpit.config.mjs';

test.describe.configure({ mode: 'serial' });

test('S1 · A fresh app', async ({ page }) => {
  // `reset` ran before this; here, only its check.
  const response = await page.goto('/');
  expect(response?.ok()).toBeTruthy();
});

test('S2 · Alice and Bob sign in once', async ({ browser }) => {
  for (const id of ['alice', 'bob']) await saveSession(browser, config, id);
});
