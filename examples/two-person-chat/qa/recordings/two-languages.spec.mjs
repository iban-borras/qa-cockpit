// suite: two-languages.md sha256:024e3e29a6d8dceb5f74b7bc2d964988fc222ddfb4c213c15b83366c8e0196a2
// The recording of suites/two-languages.md: Alice in English and Bob in
// Spanish, in one room. Bob picks his language in the header's menu, as a
// person would; each test opens his browser fresh, so each picks it again.
// The lists and labels are found by their words in each one's language.
import { test, expect } from '../fixtures.mjs';

const messages = (page, name) => page.getByRole('list', { name }).getByRole('listitem');

test('T1 · Each one reads it in their own language', async ({ alice, bob }) => {
  await test.step('1 · Bob: opens the chat and picks «Español»', async () => {
    await bob.goto('/');
    await bob.getByLabel('Language').selectOption('es');
    await expect(bob.getByText('Todavía no hay mensajes.')).toBeVisible();
  });

  await test.step('2 · Alice: opens the chat', async () => {
    await alice.goto('/');
    await expect(alice.getByText('No messages yet.')).toBeVisible();
  });

  await test.step('3 · Alice: writes «Hello, Bob!» and presses «Send»', async () => {
    await alice.getByLabel('Message', { exact: true }).fill('Hello, Bob!');
    await alice.getByRole('button', { name: 'Send' }).click();
    await expect(messages(alice, 'Messages').filter({ hasText: 'Hello, Bob!' })).toHaveText('Alice: Hello, Bob!');
  });

  await test.step('4 · Bob: sees it arrive, in Spanish around it', async () => {
    await expect(messages(bob, 'Mensajes').filter({ hasText: 'Hello, Bob!' })).toHaveText('Alice: Hello, Bob!', { timeout: 30_000 });
  });

  await test.step('5 · Bob: writes «¡Hola, Alice!» and presses «Enviar»', async () => {
    await bob.getByLabel('Mensaje', { exact: true }).fill('¡Hola, Alice!');
    await bob.getByRole('button', { name: 'Enviar' }).click();
    await expect(messages(bob, 'Mensajes').filter({ hasText: '¡Hola, Alice!' })).toHaveText('Bob: ¡Hola, Alice!');
  });

  await test.step('6 · Alice: sees it arrive, in English around it', async () => {
    await expect(messages(alice, 'Messages').filter({ hasText: '¡Hola, Alice!' })).toHaveText('Bob: ¡Hola, Alice!', { timeout: 30_000 });
    await expect(alice.getByRole('heading', { name: 'Who is here' })).toBeVisible();
  });
});

test('T2 · An empty message is refused in Spanish', async ({ bob }) => {
  await test.step('1 · Bob: opens the chat and picks «Español»', async () => {
    await bob.goto('/');
    await bob.getByLabel('Language').selectOption('es');
    await expect(bob.getByRole('button', { name: 'Enviar' })).toBeVisible();
  });

  await test.step('2 · Bob: presses «Enviar» with «Mensaje» empty', async () => {
    await bob.getByRole('button', { name: 'Enviar' }).click();
    await expect(bob.getByRole('alert').filter({ hasText: 'Escribe algo primero.' })).toBeVisible();
  });
});
