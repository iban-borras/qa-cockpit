// suite: chat.md sha256:fc5be4c2065b094bba03ec0be9ce82e2b0841b1a465e2c242ec06bb7cf2e7386
// The recording of suites/chat.md: one test per test of the suite, one
// `test.step` per row, named «n · Who: what they do». The people whose
// screen must show something are on their page before the step that causes
// it, and nothing is reloaded to make it arrive: arriving on its own is what
// is being proven. The first line is the suite's hash (`qa-cockpit stamp`).
import { test, expect } from '../fixtures.mjs';

const messages = (page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem');
const whoIsHere = (page) => page.getByRole('region', { name: 'Who is here' }).getByRole('listitem');

test('T1 · A message reaches the other person live', async ({ alice, bob }) => {
  await test.step('1 · Bob: opens the chat', async () => {
    await bob.goto('/');
    await expect(bob.getByText('No messages yet.')).toBeVisible();
  });

  await test.step('2 · Alice: writes «Hello, Bob!» and presses «Send»', async () => {
    await alice.goto('/');
    await alice.getByLabel('Message', { exact: true }).fill('Hello, Bob!');
    await alice.getByRole('button', { name: 'Send' }).click();
    await expect(messages(alice).filter({ hasText: 'Hello, Bob!' })).toHaveText('Alice: Hello, Bob!');
    await expect(alice.getByLabel('Message', { exact: true })).toHaveValue('');
  });

  await test.step('3 · Bob: sees it arrive', async () => {
    await expect(messages(bob).filter({ hasText: 'Hello, Bob!' })).toHaveText('Alice: Hello, Bob!', { timeout: 30_000 });
  });
});

test('T2 · An empty message is refused', async ({ alice }) => {
  await test.step('1 · Alice: presses «Send» with «Message» empty', async () => {
    await alice.goto('/');
    await alice.getByRole('button', { name: 'Send' }).click();
    await expect(alice.getByRole('alert').filter({ hasText: 'Write something first.' })).toBeVisible();
  });
});

test('T3 · Who is here (destructive: signs Bob out, the last)', async ({ alice, bob }) => {
  await test.step('1 · Alice: opens the chat', async () => {
    await alice.goto('/');
    await expect(whoIsHere(alice)).toHaveText(['Alice']);
  });

  await test.step('2 · Bob, Alice: Bob opens the chat', async () => {
    await bob.goto('/');
    await expect(whoIsHere(bob)).toHaveText(['Alice', 'Bob']);
    await expect(whoIsHere(alice)).toHaveText(['Alice', 'Bob'], { timeout: 30_000 });
  });

  await test.step('3 · Bob: presses «Sign out»', async () => {
    await bob.getByRole('button', { name: 'Sign out' }).click();
    await expect(bob.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  await test.step('4 · Alice: sees Bob go', async () => {
    await expect(whoIsHere(alice)).toHaveText(['Alice'], { timeout: 30_000 });
  });
});
