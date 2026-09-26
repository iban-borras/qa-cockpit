// The cast as fixtures: a recording asks for `alice` and `bob` and gets their
// pages, each signed in from the session the setup saved. Playwright comes
// from this project, never from the package (two copies refuse to run).
import { test as base, expect } from '@playwright/test';
import { cockpitFixtures } from 'qa-cockpit/fixtures';
import config from './qa-cockpit.config.mjs';

export const { test, statePath, contextFor } = cockpitFixtures(base, config);
export { expect };
