// Fresh saved sessions for the whole cast: `qa-cockpit sessions`, and
// `replay` first when the saved ones are old.
import { test } from '@playwright/test';
import { saveSessions } from 'qa-cockpit/sessions';
import config from './qa-cockpit.config.mjs';

test('Sessions', async ({ browser }) => {
  await saveSessions(browser, config);
});
