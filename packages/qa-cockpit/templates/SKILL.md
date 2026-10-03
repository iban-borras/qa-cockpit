---
name: qa-cockpit
description: Set up, run, record and heal multi-person Playwright suites with QA Cockpit. Use when asked to configure QA Cockpit in a project, write a suite, record one (the director), repair a red replay (the healer), run a suite, start the stack or the cockpit, or make a demo video of a suite (only when a person asks for one). Read «Before you launch anything» first: one run at a time, through the cockpit when it is up.
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
   config's `cockpit.port`, 3150 by default). Not up and a person wants to
   watch: open it for them (below, «Opening the cockpit»). If it answers, a command from
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

## Opening the cockpit for a person

When somebody asks you to open (or start, or restart) the cockpit:

```bash
npx qa-cockpit cockpit --detach      # or: --restart, for a fresh one
```

Never `npx qa-cockpit cockpit` in your own terminal for them: a cockpit
started in your session dies with it, and whatever it opens with a window
(«Play as», a headed run) opens on the desktop of whoever started it, which
may not be theirs. `--detach` takes care of both, and returns at once:

- one already answers, this version: it says so and opens the page;
- one of another version answers: it says so; `--restart` replaces it
  (never while a run is going: wait for it, or stop it in the cockpit);
- none: it starts one that outlives you. On Windows, in a window of its
  own called «QA Cockpit», minimised; if your terminal is on a desktop
  nobody sees (some agents' terminals are, and the cockpit warns about it),
  through the Task Scheduler, whose interactive tasks start on the desktop
  of the person logged on; the task lives a few seconds. On macOS and Linux,
  in the background, its output in `<out>/cockpit.log`.

Say the address it prints (`http://localhost:<port>`). If it adds that the
cockpit's windows will not show, the person must run
`npx qa-cockpit cockpit` in a terminal of their own: tell them so.

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
   - Its own ports may meet rules written for the development ones: a
     frontend whose CSP (`connect-src`) names the API's origin, an API
     whose CORS allows only the dev app. Give the QA copy the same rules
     for its own ports, or a small proxy that serves the app and the API
     from one origin.
   - Made-up data, not a copy of production: the photos, traces and
     reports keep whatever the screens show, and the report and the notes
     are written for an agent, which sends them to its model. With a copy
     of production, anonymise it first.
2. **The cast:** the people every suite shares, the same names and
   accounts everywhere (`alice`, `bob`, an `admin` if the app has one).
   Fake accounts of the QA stack only; their passwords may sit in the
   config. Each may say their usual `device` (below), and their own
   browser `context`: Playwright's context options for them alone, such as
   `locale: 'es-ES'` and `timezoneId` for a person who reads the app in
   another language, or the headers of the gotcha on one IP, below.
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
npx qa-cockpit cockpit --detach # the cockpit for a person (--restart; «Opening the cockpit»)
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
npx qa-cockpit video check      # what a demo video needs from this machine (only when asked for one)
npx qa-cockpit video script <suite>   # a first video script, in the suite's words
npx qa-cockpit video voices <suite>   # its narration in the system's own voice (no voice service)
npx qa-cockpit video <suite>    # a demo video (--motion, --clips, --script <file>); «Demo videos»
npx qa-cockpit video render latest    # draw the last capture again (a new narration)
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
`reset` and `setup` before it. The CLI keeps what the stack's data is
(`<out>/stack-data.json`, written by every `reset`, `setup` and
`replay`): when a `replay` says «The stack's data is not this suite's
setup», stop and run `reset` and `setup <suite>` first, unless you are
running one test again on purpose.

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
6. The first time you record a new suite for somebody, tell them once, in
   one sentence, that a green suite can also become a demo video (below,
   «Demo videos»), and how: with subtitles and a cursor, with narration,
   or in real time with the app's animations. Do not make one unless they
   ask, and do not say it again for every suite.

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

## Demo videos (only when a person asks)

A green suite can become a video that shows the app to people: its real
screens, a macOS cursor gliding to each control with a ripple and a «tic» on
every press, a subtitle per step taken from the suite, a card per test, music
underneath and, if asked, a narration. Nothing is filmed by hand and nothing
is edited by hand: when the app changes, the video is made again in minutes.

**Never make one unasked.** It replays the suite (reset, setup, recording),
which takes the stack, and it is something a person wants, not a check.

### Can you make it? Ask yourself first

Say plainly which of these you lack, and stop there:

1. **Can you look at images?** A video is not done until you have looked at
   its contact sheet (`<suite>-sheet.jpg`) and it is right. Without eyes,
   you cannot check it: say so, and leave the video to an agent that can.
2. **`npx qa-cockpit video check`**: ffmpeg with libx264, and Playwright's
   Chromium. ffmpeg is the person's to install (`winget install ffmpeg`,
   `brew install ffmpeg`, `apt install ffmpeg`), or to name in the config's
   `video.ffmpeg`.
3. **Only for a narration: a voice**, the first of these you have:
   1. **A voice service among your tools**: ElevenLabs, or any other
      text-to-speech a connector of the person's gives you (look at your
      tools for one that makes speech). It speaks best, and it spends the
      person's credits: say which service and roughly how much text (the
      narration's characters), and wait for their yes. Its account and its
      sign-in are theirs, never yours.
   2. **None, or they would rather not: the system's own voice.**
      `npx qa-cockpit video voices <suite>` speaks every narration of the
      script with Windows' System.Speech, macOS's `say` or Linux's
      espeak-ng (`--list` shows the voices, `--voice <name>` picks one).
      Offline and free, and plainer: say so, and offer it as a draft (for
      the timing, for a video that stays inside) that a better voice can
      replace later with the same script.
   3. **No narration:** the subtitles tell the story on their own.

   What goes to a service is the narration's text only: no customer names,
   no real data from the screens. The music is made by the package unless
   the person wants another track: from the same service (ElevenLabs makes
   music too), with the same yes, or a file of theirs; it goes in `music`.

### The kinds

| Kind | What | How |
|---|---|---|
| **Guide** (default) | For training: each press shows the screen just before it, the cursor gliding to the control, then the screen after; each step lasts what its subtitle takes to read. | `video <suite>` |
| **Narrated** | Either kind with a voice over each step and card; a step lasts at least what its narration does, and the music steps back while the voice speaks. | a video script with `audio` |
| **Motion** | For a richer demo: the app's animations on, the pointer moved like a hand (hover effects included), the text typed key by key, every painted frame in real time, the still moments cut short. | `video <suite> --motion` |
| **Clips** | For a designer who edits the video themselves: each step of each person as it really played, 60 fps, with nothing drawn on it, and the pointer's path beside it (`.cursor.json`). | `--clips`, with either kind |

Ask what is not said: which kind, which tests (a training video is better
one task at a time than the whole suite), and in which language the
narration speaks.

### How a video looks

The design is the package's, the same for every video; what a project
says is in its config (`video`: the product's name, each person's role, a
logo for a dark background, the colours, the address the cover shows) and
in each video's script.

- **The cover:** the product's name, the title and its subtitle over the
  app itself. The end of the step that shows most of the app (or the
  script's `cover`) rises from the bottom in a flat browser, with a phone
  beside it when somebody plays on one, and rests just under the title,
  cut by the frame's bottom edge: the viewer sees which app this is before
  a word is said.
- **Nothing stops dead.** What enters slides in and slows down to rest,
  one element a beat after the other (the tag, the title, its rule, the
  subtitle, then the screens, from much further and settling longer); what
  leaves fades. Each step's subtitle rises into place. The cursor glides as
  a hand does, easing in and out, and every press is a ripple and a tic.
- **The rhythm:** a step lasts what its subtitle takes to read (`pace`) or
  its narration to say, whichever is longer; a test's card 1.8 s; the cover
  3.8 s; the end 3 s. Cards fade over the steps beside them.
- **The screens:** one 1280×720 screen fills the picture 1:1, as sharp as
  the app; several share it, scaled, each with its label (name · role).

### Making it

1. **A green recording that matches its suite** (`decide` says REPLAY).
   Recordings film well when their actions are on locators
   (`page.getByRole(...).click()`, `.fill()`): those are the ones the video
   paces and brings into view before acting. Never `waitForTimeout`: the
   video sets the rhythm, not the recording.
2. **The script**, when there is more to say than the suite says:
   `npx qa-cockpit video script <suite>` writes `<videos>/<suite>.json` with
   every test and step in the suite's words. Choose the tests, reword a
   subtitle, leave a step out (`"skip": true`), title the cards. For a
   narration, write each step's and card's `narration` as the voice will say
   it: short, present tense, one idea, what the viewer needs to understand
   (not the subtitle read aloud); context first, then the action, then what
   it means, in the script's `language`. Then the audio, with the voice you
   have (above): from a service, one file per narration in
   `<videos>/<suite>/`, named by its key (`intro.mp3`, `T1-2.mp3`), its path
   in that entry's `audio`; with the system's voice, `video voices <suite>`
   does all of that. The script's other keys: `quality` (`guide` or
   `motion`), `title`, `subtitle`, `cover` (the step whose end the cover
   shows), `music` (`"generated"`, a file, or `null`), `musicVolume`,
   `pace`, `idle` and `speed` (motion).
3. **Make it:** `npx qa-cockpit video <suite>` (`--motion`, `--clips`,
   `--script <file>`, `--out <file>`). «Before you launch anything» holds:
   it takes the stack, resets it and runs the setup. A red run makes no
   video. It prints where the video and its contact sheet are, under
   `<out>/videos/<suite>-<kind>-<time>/`.
4. **Look at the contact sheet before you say it is done.** For each press:
   the cursor on the very control the subtitle names, and the screen as it
   was before the press. For each step's end: that step's result, not the
   next one's. The number of presses it printed matches the clicks of the
   recording (typing in a field counts as one in a guide; a file upload
   does not). Then say where the video is.
5. **A new narration or wording, same run:** `npx qa-cockpit video render
   latest --script <file>` draws the capture again, without replaying.

| What you see | Why | What to do |
|---|---|---|
| The cursor lands where nothing is | The control was off screen and the action was not on a locator | Act through a locator; it is brought into view first |
| A step is missing | Its `test.step` is not «n · Who: …», or its test is not «T1 · …» | Name it so |
| A step shows nobody | Its title names nobody of the cast before the colon | Name who acts |
| «No video: the run must be green» | The recording failed | It is a red replay: the healer, not the video |
| A voice speaks over the wrong step, or never | Its key in `steps` is not `<test id>/<row number>` (`"T1/2"`) | Key it by the suite's test and row |

**What the video shows is what the stack showed.** With a copy of real data,
the video is for inside the company only; keep it in `<out>` (never
committed) and say so. For anybody outside, a stack with made-up data.

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
videos/                 <suite>.json: video scripts, and their narration's audio
.qa-cockpit/            runs, photos, traces, videos, saved sessions (never committed)
```

(Defaults; the config's `paths` can put each elsewhere.)

## Gotchas

- Saved sessions may go stale (short-lived tokens, rotated refresh tokens):
  `replay` renews them unless every one is younger than
  `sessions.freshFor`.
- The whole cast browses from one machine, so from one IP: a rate limit per
  IP (on sign-in, or 60 requests a minute) counts everybody together, where
  production counts each person. A setup followed by a replay also signs
  everybody in twice. Raise the limits in the QA copy; or, when the app
  trusts a proxy's header, give each person their own address:
  `context: { extraHTTPHeaders: { 'X-Forwarded-For': '10.0.0.2' } }` in the
  cast. A test that hits a limit may also be a finding: an app that makes
  dozens of requests for one screen.
- The project installs with its own package manager: npm, pnpm, yarn or
  bun, whichever its lockfile (or `packageManager`) says, also a
  workspace's lockfile above the config. `doctor` names it and heals
  `node_modules`. `--in-docker` installs with npm: it needs a
  `package-lock.json` beside the config.
- Two copies of `@playwright/test` refuse to run together: the package
  never imports Playwright itself, the project hands its own over (the
  fixtures file does).
- The cockpit must be launched from a terminal on a desktop somebody sees:
  what it opens with a window («Play as», headed runs) appears there. Some
  agents' terminals run on a hidden desktop; the cockpit warns.
- It listens on the loopback only and answers only its own page. Keep it
  that way: it can reset a database and start processes.
