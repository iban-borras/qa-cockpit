// The setup of suites/chat.md: one test per row of its «Setup» table, each
// with the check the row names. A setup half done gives suites that lie.
import { test, expect } from '@playwright/test';
import { saveSession } from 'qa-cockpit/sessions';
import config from '../qa-cockpit.config.mjs';

test.describe.configure({ mode: 'serial' });

test('S1 · A fresh app', async ({ request }) => {
  const reset = await request.post('/api/test/reset');
  expect(reset.ok(), 'the app takes the reset (its test hooks are on)').toBeTruthy();
  const history = await (await request.get('/api/messages')).json();
  expect(history.messages).toEqual([]);
});

test('S2 · Alice and Bob sign in once', async ({ browser }) => {
  for (const id of ['alice', 'bob']) await saveSession(browser, config, id);
});
