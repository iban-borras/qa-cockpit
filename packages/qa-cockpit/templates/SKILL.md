---
name: qa-cockpit
description: Set up, run, record and heal multi-person Playwright suites with QA Cockpit. Use when asked to configure QA Cockpit in a project, write a suite, record one (the director), repair a red replay (the healer), run a suite, or start the stack or the cockpit. Read «Before you launch anything» first: one run at a time, through the cockpit when it is up.
---

# QA Cockpit

QA Cockpit runs **suites where several people use the app at once**: Alice
does something, Bob must see it arrive. A suite is a Markdown document a
person could follow by hand; a **recording** is the Playwright test that
plays it back; the **cockpit** is a local web page where people watch every
run, one card per person, step by step, with a photo of each person's screen
at every step.

Everything about the app under test is in one file, `qa-cockpit.config.mjs`
(read it first: its paths, its cast, its stack). Every command is
`npx qa-cockpit <command>` from the config's folder, or the wrapper the
project names in the config's `cli` (for instance `node qa.mjs`).

## Before you launch anything (every agent, every time)

There is ONE stack and other agents may be using it; people watch the runs
in the cockpit.

1. **Who has the stack?** `npx qa-cockpit lock`. If somebody holds it, wait
   for their run to end. Never `unlock` a lock whose holder is alive unless
   the person you work for says so.
2. **Say who you are:** set `QA_WHO` (`Claude`, `ci`, ...) in the
   environment of every command, so a refusal or the cockpit names you.
3. **Is the cockpit up?** `curl -s http://localhost:<port>/api/state` (the
   config's `cockpit.port`, 3150 by default). If it answers, a command from
   your terminal is followed there on its own, as yours. **A whole sequence
   (reset, setup, replay) goes through the cockpit's API**, which holds the
   stack across its steps; three commands of your own let go of it between
   them:

   ```bash
   curl -s -X POST http://localhost:3150/api/action -H 'Content-Type: application/json' \
     -d '{"action":"full","suite":"<suite>"}'          # or reset, setup, replay
   while curl -s http://localhost:3150/api/state | grep -q '"task":{'; do sleep 10; done
   ```

   The result is in `<out>/cockpit/<run id>/`: `run.json` (each test's
   status and errors) and `log.jsonl` (the whole log).
4. **The terminal for single commands:** one test of a recording
   (`replay <suite> -g T3`), a setup while you write it. They take the lock
   too, and the cockpit follows them.
5. **Never touch the stack behind the lock's back:** no writes to its
   database, no restart of its services, while somebody else's run is
   going. If the stack runs your working tree with hot reload, **saving app
   code counts**: the server restarts or the page reloads under the running
   suite, and its requests fail.

## Setting it up in a project (the first time)

`npx qa-cockpit init [folder]` (default `qa`) writes a commented
`qa-cockpit.config.mjs`, the fixtures, the Playwright config, the sessions
setup, the suites folder with its guide and an example suite, this skill,
and a section in the repo's `AGENTS.md`. Then make the config true for this
app, in this order, and run `npx qa-cockpit doctor` after each step until
everything says ok:

1. **The stack: a copy of the app that tests may break.** Never the
   developer's own instance, never anything shared. Find how the app starts
   (its README, `docker-compose.yml`, `package.json` scripts):
   - Docker Compose: `composeStack({ project: '<app>-qa', files: [...], app: { service, port }, api: { service, port, health } })`.
     Give the QA copy its own compose project (and, with an override file,
     its own ports and volumes): that is what keeps it apart.
   - One process (`npm run dev`, `node server.mjs`): `processStack({ command, args, env, app, health })`.
   - Anything else: write `urls()` (throws when it is down), `up`, `down`
     and `reset` yourself.
   - `reset` gives the app fresh data: drop and recreate the database, or
     call a test-only endpoint the app exposes in its QA mode. Without it,
     a suite cannot be replayed twice.
   - `guard()`, when the app can tell: refuse unless the running stack is
     the QA one (its mode, its mail sent nowhere). It is what makes an
     accident impossible by construction rather than by care.
2. **The cast:** the people every suite shares, the same names and
   accounts everywhere (`alice`, `bob`, an `admin` if the app has one).
   Fake accounts of the QA stack only; their passwords may sit in the
   config. Each may say their usual `device` (below).
3. **`signIn({ page, person })`:** the app's real sign-in form, as the
   person would use it, ending when the app shows them signed in. The
   package saves the session and every fixture reuses it.
4. **The first suite** in `paths.suites` (the guide beside it says how),
   its setup in `paths.setups`, then record it (the director, below).

`doctor` checks the config, the dependencies, Chromium, and whether the
stack answers.

## Commands

```bash
npx qa-cockpit doctor           # what this machine and this config have and lack
npx qa-cockpit cockpit          # the cockpit (--port <p>, --no-open)
npx qa-cockpit lock             # who holds the stack; unlock removes a hung lock
npx qa-cockpit up               # start the stack and wait until it answers
npx qa-cockpit status           # where it answers, saved sessions
npx qa-cockpit suites           # every suite and what it needs next
npx qa-cockpit reset            # fresh data; saved sessions cleared
npx qa-cockpit setup <suite>    # the suite's setup, sessions saved
npx qa-cockpit sessions         # fresh saved sessions for the cast
npx qa-cockpit decide <suite>   # REPLAY | GENERATE <why> | ENV <why>
npx qa-cockpit replay <suite>   # fresh sessions if old, then the recording
npx qa-cockpit replay <suite> -g T1   # one test; extra args go to Playwright
npx qa-cockpit open <person>    # a browser window signed in as that person
npx qa-cockpit stamp <suite>    # write the suite's hash into the recording's first line
npx qa-cockpit pass <suite> <who> <result> <notes...>   # a row in the suite's runs table
npx qa-cockpit mcp              # .mcp.json: one Playwright MCP server per saved session
npx qa-cockpit notes [run]      # the notes a person pinned on a run's photos (--list: runs with notes)
npx qa-cockpit down | purge     # stop the stack; purge removes its data too
```

`--in-docker` (setup, sessions, smoke, replay) runs Playwright in the
official image of the pinned version, for a stack made with `composeStack`.

## Running a suite

0. «Before you launch anything» (above).
1. `up` if the stack is down.
2. `decide <suite>` says what to do:
   - `ENV <why>`: fix the stack first.
   - `REPLAY`: the recording matches the suite. `reset`, `setup <suite>`,
     `replay <suite>` (or «full» through the cockpit). Green:
     `pass <suite> playwright green "<notes>"`. Red: the healer (below).
   - `GENERATE <why>`: no recording, or the suite changed since it was
     recorded. `reset`, `setup <suite>`, then the director writes or
     extends the recording, runs it until green, `stamp <suite>`, and
     `pass <suite> "agent (<model>)" green "<notes>"`.
3. No setup for that suite: write it after an existing one, mirroring the
   suite's setup table row by row, each row with the check it names.
4. Whatever the result, the runs row (date, who, result, notes) is the
   trace, and a failure is also a note wherever the team keeps them, never
   a silent fix. After a change in the app, replay every recording: the
   ones that fail are the suites the change touched.

The hash in a recording's first line is of the suite WITHOUT its runs
table, so writing a row never makes the recording look stale. Recordings
change the data (they send, delete, sign out), so a replay always wants
`reset` and `setup` before it.

## The director (GENERATE)

1. Read the suite. Every row is a `test.step` named «n · Who: what they
   do»; every «Must see» is an `expect` on the exact text between «».
2. Write the recording: the person who acts is the fixture that acts; the
   people who must SEE something arrive are put on their page before the
   step that causes it; dialogs by role and name, rows by
   `getByRole('listitem').filter({ hasText })`, sections by their
   accessible name; a text a page repeats is disambiguated by what the
   suite means, not by the first match. A label that is a prefix of another
   («Message», «Messages») needs `{ exact: true }`.
3. Read the app's code for the structure and its exact strings instead of
   guessing; when a locator cannot be derived from the code, drive the
   person's browser through the per-person MCP servers (`mcp`).
4. Run it (through the cockpit when it is up), read the failure (the error,
   the photo, the trace under `<out>`), fix the recording, run again. A
   failure that is the APP's, not the recording's, is not fixed in the
   recording: it is a runs row and a note.
5. `stamp <suite>` when green; then `pass`.

A suite of the eyes and the hand (sizes, colours, a drag) is recorded with
SOFT expects for its claims: each claim the app does not keep is a red step
with its photo and the run goes on, so one run shows them all. What the next
step needs stays a hard expect.

## The healer (a red REPLAY)

Two verdicts, and only two:

- **The screen changed**: a text or a control moved, the behaviour is the
  one the suite describes. Repair the recording, run it green, `stamp`,
  `pass` with «repaired: …» in the notes.
- **The app is broken**: what the suite says should happen does not. Do not
  touch the recording. `pass <suite> playwright red "<what and where>"`, and
  a note with the step, the expected text and what was seen.

When the suite ITSELF is wrong (it quotes a text the app never had, or
describes a rule that changed by decision), say so in the notes and leave
the suite's edit to its author.

## Notes pinned on the photos

A person reviewing a run in the cockpit can pin notes on its photos: each
one a tack on the very point of the page it is about, and a text. When you
are asked to act on them:

1. `npx qa-cockpit notes` prints the newest run's notes (`notes <run>`
   for another, `--list` for the runs that have some). Per photo: the
   photo, the copy «with the pins», the page, the device and the recording
   line. Per pin: its point in the page's CSS pixels, whether it was on
   screen, the action of the step it falls on, and the text.
2. Look at the copy with the pins first: the numbered tack shows the thing
   the note means, where bare coordinates are easy to misread. No copy yet:
   the cockpit draws it when the run is open there.
3. A note is about the app or about the suite: fix the app, or change the
   suite and GENERATE. Say which, note by note, in your answer.
4. Notes stay until a person deletes them in the cockpit: never delete one
   yourself.

## Writing steps against the cast

The project's fixtures file gives one page per person, each in its own
browser context signed in from the saved session, plus the config's
`helpers` (a `db`, a `mail` reader...):

```js
import { test, expect } from '../fixtures.mjs';
test('T1 · Bob sees Alice\'s message', async ({ alice, bob }) => {
  await test.step('1 · Bob: opens the chat', async () => { /* ... */ });
});
```

- Only the people a test names get a browser.
- **The step title is a contract**: «n · Who[, Who]: what they do», with the
  cast's names before the colon. The cockpit photographs the people it
  names when the step ends (and every open page when it fails).
- Cross-person waits use `toBeVisible({ timeout: 30_000 })` and never a
  blind reload: what is being proven is that it arrives on its own.
- **An absence is proven only after a presence.** `toHaveCount(0)` right
  after a `goto` passes on a page still loading. Wait first for what the
  page must show, then check what it must not.
- When you cannot tell when to act, wait for the text the suite quotes,
  never for time.

### Devices

Each person plays on a device: a name from Playwright's list
(`'iPhone 15'`, `'Galaxy S24'`, `'iPad Pro 11 landscape'`, `'Desktop Chrome'`)
or a size of the project's own (`{ name, viewport, deviceScaleFactor,
isMobile, hasTouch }`). The nearest word wins:

1. the recording's `test.use({ devices: { bob: 'iPhone 15' } })`, at the
   top of the file (or of a `describe`);
2. the person's `device` in the config's cast;
3. the config's `browser.device` (`Desktop Chrome` when nothing says).

The suite's cast table says each person's device (a «Device» column), and
the recording follows it. A phone is another screen: menus fold, panes
stack, a button may move. **Moving a person to another device means
recording their steps again**; never change a device under a recording that
passes. Every browser is Chromium: size, density, touch and the mobile flag
are the device's, the engine is not. The cockpit shows each card's device
(icon and name), photographs each person's own window, and «Play as» opens
at that device's size.

## Files

```
qa-cockpit.config.mjs   the contract: paths, cast, stack, signIn, helpers
fixtures.mjs            the cast as fixtures (the project's own Playwright)
playwright.config.mjs   made by the package from the config
sessions.setup.mjs      fresh sessions for the cast
suites/                 the suites (Markdown) and their guide, README.md
setups/                 <suite>.setup.*: the setup table as code
recordings/             <suite>.spec.*: the recordings, hash in line 1
.qa-cockpit/            runs, photos, traces, saved sessions (never committed)
```

(Defaults; the config's `paths` can put each elsewhere.)

## Gotchas

- Saved sessions may go stale (short-lived tokens, rotated refresh tokens):
  `replay` renews them unless every one is younger than
  `sessions.freshFor`.
- Mind the app's rate limits on sign-in: a setup followed by a replay signs
  everybody in twice.
- Two copies of `@playwright/test` refuse to run together: the package
  never imports Playwright itself, the project hands its own over (the
  fixtures file does).
- The cockpit must be launched from a terminal on a desktop somebody sees:
  what it opens with a window («Play as», headed runs) appears there. Some
  agents' terminals run on a hidden desktop; the cockpit warns.
- It listens on the loopback only and answers only its own page. Keep it
  that way: it can reset a database and start processes.
