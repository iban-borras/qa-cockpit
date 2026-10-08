---
name: qa-cockpit
description: Set up, run, record and heal multi-person Playwright suites with QA Cockpit. Use when asked to configure QA Cockpit in a project, write a suite, record one (the director), repair a red replay (the healer), run a suite, start the stack or the cockpit, make a demo video of a suite (only when a person asks for one), or look at the network of a suite (load times, the calls each screen makes) when asked. Read «Before you launch anything» first: one run at a time, through the cockpit when it is up.
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

A cockpit left running while the package is updated keeps the old code,
and would take the new runs in part (clicks lost). It says so, in a red
band and in the terminal of every run, and starts or follows none until
`npx qa-cockpit cockpit --restart`.

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
   - **What differs from one machine to the next** (a port this
     machine's dev server already takes, the one a container publishes
     there) goes in `.env` beside the config, never in the config: the
     config calls `loadEnv(import.meta.url)` at its top and reads
     `process.env.QA_APP_PORT ?? '<its default>'`; `.env.example` lists
     what may be set, and `.env` is never committed. The environment
     wins over the file (a CI sets its own). Docker compose, started by
     the CLI, sees the values too: `"${QA_APP_PORT:-5174}:5173"` in a QA
     override. A config written before 0.5.0 does not read `.env`: add
     those lines (`doctor` says so when a `.env` is there and ignored).
     `doctor` also says where a stack that is down will answer.
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
4. **`languages`, when the app speaks more than one.** Nobody has to ask
   for it: look for the app's own control (a menu, a select, a flag in the
   header) and write how a person changes the language with it, as you
   write a recording:

   ```js
   languages: {
     others: ['ca', 'es', 'fr'],    // besides the suites' own, which is browser.locale's
     priority: ['es'],               // looked at when a run names none; all of them otherwise
     async switchTo({ page, lang }) {
       await page.getByTestId('lang').selectOption(lang);
     },
   },
   ```

   The control's own words change with the language: find it by what does
   not (a test id, an icon's role, a name in every language). Then
   `npx qa-cockpit languages check`: it changes one person's first screen
   to each language and back, and says whether the words change, whether
   the page loads again, and whether it comes back the same; look at its
   photos. A change that reloads the page loses what is open on a screen
   (a dialog, a form half filled): say so when you report.
5. **The first suite** in `paths.suites` (the guide beside it says how),
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
npx qa-cockpit replay <suite> --network   # each person's requests kept as HARs, without secrets; «A look at the network»
npx qa-cockpit replay <suite> --a11y      # each step's screen looked at for accessibility, with the cockpit; «Accessibility»
npx qa-cockpit replay <suite> --languages # each step's screen in the app's other languages too (--languages fr,de: those), with the cockpit; «Languages»
npx qa-cockpit languages check  # the config's change of language, tried on one screen and back
npx qa-cockpit replay <suite> --realtime  # how long what one person does takes to reach another's screen; «Real time»
npx qa-cockpit replay <suite> --chaos 5  # races between people: rounds from fresh data, each person slowed by a seed; «Races»
npx qa-cockpit replay <suite> --chaos-seed <n>  # that round again, with any look
npx qa-cockpit network [run]    # what they show, step by step (--against previous, --test <id>, --json, --list)
npx qa-cockpit open <person>    # a browser window signed in as that person (not while a run plays them)
npx qa-cockpit stamp <suite>    # write the suite's hash into the recording's first line
npx qa-cockpit pass <suite> <who> <result> <notes...>   # a row in the suite's runs table
npx qa-cockpit mcp              # .mcp.json: one Playwright MCP server per saved session
npx qa-cockpit notes [run]      # the notes a person pinned on a run's photos (--list: runs with notes)
npx qa-cockpit play [run]       # a report a person made from «Play as»: note, steps, photos, errors (--list); «Reports from Play as»
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
   line. A step's photo is the whole page as the step left it; an action's
   is the window just before that action (the report names it). Per pin:
   its point in the photo's CSS pixels, whether it was on screen, the
   action of the step it falls on, and the text.
2. Look at the copy with the pins first: the numbered tack shows the thing
   the note means, where bare coordinates are easy to misread. No copy yet:
   the cockpit draws it when the run is open there.
3. A note is about the app or about the suite: fix the app, or change the
   suite and GENERATE. Say which, note by note, in your answer.
4. Notes stay until a person deletes them in the cockpit: never delete one
   yourself.

## Reports from «Play as» (when a person says they made one)

In the cockpit, «Play as» opens a window signed in as somebody of the
cast, for a person to use the app by hand. The cockpit follows it as it
follows a run: each action (a click, a field typed in, Enter or Escape, an
option picked) with the window just before it, the page's requests and its
errors. When something goes wrong, «Make a report» asks the person what,
and turns what every window did since the last report into a run of kind
«play»: steps in a suite's words («4 · Bob: types «hola» in «Message»»),
then each window as it was when reported, with the person's note.

```bash
npx qa-cockpit play          # the newest report: the note, the steps, their photos, requests and page errors
npx qa-cockpit play --list   # every report kept
```

1. **Read the note first**, then the photos of the steps around what it
   says: each action's photo is the window just before it, its mark on what
   was done; the step's is the window after it.
2. **A page error or a failed request** in a step is often the cause: say
   which step it came in.
3. **Reproduce it as a test** when the person asks: the steps as a test of
   the suite (or of a new one), in its words, with what should have
   happened; GENERATE its recording and replay it, red until the fix turns
   it green.
4. **What was typed is in the steps**, but never what went in a password's
   field, a card's, a code's or a token's: those say «(hidden)». Use the
   cast's own, or ask.
5. While a run plays somebody, their «Play as» is off: the window would be
   the run's very session.

## A look at the network (when a person asks)

When somebody asks why a screen is slow, which calls a page makes, or how
the app loads, look at the network of a suite that goes through it. Do not
instrument the app, or write a test of your own for it.

1. «Before you launch anything» holds: it is a replay. `reset`,
   `setup <suite>`, then `npx qa-cockpit replay <suite> --network` (with
   `-g T3` for one test). Each person's requests are kept per test as HARs,
   each placed in the step that made it, under
   `<out>/network/<suite>-<time>/`. A red run keeps what it reached.
2. `npx qa-cockpit network` reads the newest: the findings first, each as a
   pattern with the places it shows up (calls one after another, one call
   per item, the same call again, slow on the server, heavy, errors, calls on
   a timer), then a table per test, step by step. `--test T3` for one test,
   `--json` for every finding.
3. **What to trust.** The counts, the chains, the repeats and the sizes are
   the app's, wherever it runs. The milliseconds are the QA copy's (its stack
   on this machine, its small data, no distance to the server): a hint, never
   a verdict. A call of 5 ms here can cost 150 in production; one of 900 here
   may be the copy's doing. A copy whose front is a development server
   (Vite, webpack, Next) shows some of its own, and the report says so at its
   top: modules arriving one by one, the parts of a page mounting as theirs
   arrive, React's StrictMode asking twice. It leaves those out (a chain
   that began while code arrived, a call asked twice at once), and what is
   left still deserves a look in the code before you call it the app's.
   For a measure, the network of the built front, served at the same
   address («A page that loads slowly», under the videos), is the one.
4. **What you deliver is a report, not a refactor.** The findings ranked by
   what they cost the person who waits and what fixing them costs, the cheap
   ones first: two calls that can go together, a call made twice, a list that
   asks row by row, a response trimmed to what the screen shows. A change
   that reaches deep (a new shape for an endpoint, a cache, the data model)
   goes in as a proposal with its cost, for the person to choose. Change
   nothing until they have.
5. **After a change**, the same replay with `--network`, then
   `npx qa-cockpit network --against previous`: the steps whose calls
   changed, and the findings gone and new. Compare runs made the same way (on
   this machine; both followed by the cockpit, or neither). Milliseconds move
   from run to run: replay again before believing a small gain. It says when
   nearly every step took longer (a busier machine), and on a development
   server it leaves the chains out, which move there by chance.

The HARs are made to be read and passed on. The values of cookies, tokens,
passwords, API keys, signed URLs and the like are `REDACTED-<id>` in them,
one id per value: the same id is the same token. Read them with `jq` or
`grep` for what the report does not say (a call's headers, its timings);
DevTools draws one as a waterfall (Network, Import HAR). The text of the
responses is kept only with `--bodies`: ask for it when a finding needs it
(what a heavy response holds), cleaned the same way, its data the copy's;
with it, an error says its code («403 ACCOUNT_PAUSED»), which tells a
refusal the suite asks for from a failure. An app whose own words look
like secrets (a game's `session_id`) names them in the config's
`network.notSecret`, and their values stay. The Playwright traces under
`<out>` are not cleaned: they keep everything the browser sent, to debug a
failure. Never pass one on.

## Accessibility (when a person asks, or before a release)

`npx qa-cockpit replay <suite> --a11y`, with the cockpit following the run
(in the cockpit: the run's options menu, «Accessibility»). As each step's
photo is taken, its screen is read from Chromium's accessibility tree, as a
screen reader reads it, by four rules:

- **name**: a button, a link, a tab or a menu item with no name;
- **label**: a field with no label;
- **alt**: an image with no text alternative (an `<img>`, or what says
  `role="img"`);
- **keyboard**: a control the keyboard cannot reach (a `<div
  role="button">` without `tabindex`).

Each problem is told once a run, where it first shows: a box on that step's
photo in the cockpit, and when the run ends a list in the terminal, with the
step, the person and the element as `button#close.icon [data-testid=close]`
to find it in the code. The run report has them too, with their boxes.

1. **What you deliver is a report.** The problems, the ones every screen
   has first (a header's button), each with the element and its fix (an
   `aria-label`, a `<label for>`, an `alt`, a `<button>` instead of a
   `<div>`). Change the app only when the person says so.
2. **It is not a full audit.** Four rules that are sure, not all of them:
   no contrast, no focus order, nothing inside an `<iframe>`. Say so when
   you report.
3. **It costs time on every step** (the cockpit's own, said apart from the
   step's): not on every replay, only when asked.

## Languages (when a person asks, or before a release)

`npx qa-cockpit replay <suite> --languages`, with the cockpit following
the run and `languages` in the config (setting it up, step 4): the
config's `priority` languages, or every other one when it names none;
`--languages fr,de` for those only (the new ones, say, not the ones
already right). Never on its own: only when asked. The suite
plays in its own language, as its recording finds things by their words.
At each step's end, each person it names has their screen changed to
every other language by the config's `switchTo`, photographed, and
changed back; the change is not the step's (no marks, no photos of its
own, nothing in the trace). Against the same screen in the suite's own
language, it finds:

- **cut**: a text that no longer fits its box (cut short, or spilling out);
- **wide**: the page grown wider than the window;
- **key**: a translation key left on the screen (`nav.home`), in any
  language, the suite's own too.

In the cockpit each step's photo has a tab per language (the `I` key goes
through them), with what does not fit as boxes; when the run ends the
terminal lists them, and the run report has every language's photo.

1. **A step whose control is out of reach** (a dialog over the header, a
   page without the menu, as one signed out) is skipped, and said.
2. **A screen that does not come back word for word** in the suite's
   language stops the look for the rest of the run, and the run goes on
   in its own language: said in the log and at the end. Most often the
   change left its menu open, or the screen has words that move on their
   own (a clock): `languages check` shows which.
3. **What you deliver is a report**: the texts that do not fit, in which
   language and on which screen, with their photos; the fixes (a shorter
   word, a box that grows) are the app's, with the person's say.
4. **It costs time on every step** (the cockpit's own, said apart): only
   when asked.

## Real time between people (when a person asks)

`npx qa-cockpit replay <suite> --realtime`, with the cockpit following the
run. A suite of several people says it in its own steps: «2 · Alice:
presses «Send»», then «3 · Bob: sees it arrive». When a step ends for
somebody who did nothing since another person acted (in that step or the
one before it, in the same test), it is a hand-off, measured from that
action, on the browser's own clock:

- **sent**: the first request or WebSocket message the acting person's
  page made;
- **received**: the first message pushed to the other page (WebSocket,
  server-sent events) that carries the words the steps quote («Hello,
  Bob!»; not the «Send» pressed). With no words quoted, the first pushed
  but a stream's own welcome (what a stream the page opened late says the
  moment it opens); for an app that asks again and again, its first
  answer;
- **seen**: the first words that changed on the other person's screen: the
  quoted ones, when the steps quote some.

Words seen that no pushed message carried came another way (a history
loaded late, an answer the page asked for): the hand-off says «not live»,
with the answer they likely came with. Quote in the steps' titles what
travels from one person to the other, as the suites do, and the measure
follows it. Of what the messages say nothing is kept: only whether one
carried the quoted words.

In the cockpit the step has a badge with the time it took to be seen, and
the line under its photo says the three; the terminal lists every
hand-off when the run ends, and the run report has them.

1. **The milliseconds are the QA copy's, on this machine**, as a look at
   the network's are: a hint of where the time goes (in the server, before
   it pushes; in the app, before it paints), not production's numbers.
   Replay again before believing a small difference.
2. **A step of nobody's action measures nothing** (a page opened, a
   wait): only clicks, typing and keys pressed are actions.
3. **What you deliver is a report**: the slow hand-offs, and on which leg
   the time goes. Change nothing until the person says so.

## Races between people (when a person asks, or before a release)

`npx qa-cockpit replay <suite> --chaos [N]` plays the recording in N rounds
(3 unless said; 2 to 50). Each round starts from fresh data (`reset`, then
the suite's setup, as a video does) and slows each person in their own way,
drawn from the round's seed:

- **network**: every request of theirs waits that long for its answer;
- **pushes**: what is pushed to their page (WebSocket messages, server-sent
  events) reaches the app that late, in the order it came;
- **CPU**: their page runs that many times slower.

On this machine everybody is fast and the steps come in one order; on a
slow phone they may come in another, and the app may not expect it (a
message lost between loading the history and opening the live stream, a
list redrawn from an answer older than what was pushed). **A step that
passes in some rounds and fails in others is a race**: the terminal lists
each, with the rounds it failed in, how each person was slowed there and the
error; the cockpit shows each round as a run of its own, with its seed, and
under the run what the rounds found. A step that fails in every round is
not a race: the app, the recording, or a slowness it cannot take.

1. **A seed plays its round again**: `replay <suite> --chaos-seed <n>`, from
   fresh data, each person slowed the same way. It takes any look, so
   `--chaos-seed <n> --realtime` says where the time went, and the trace
   and photos of that run show what each person saw. Timing is never exact:
   a round may need two or three tries to fail again.
2. **Several people at once**: `together` (a fixture, like the cast) starts
   their actions in the same instant; in a round, each at the offset its
   seed says, one before the other or both at once:

   ```js
   test('T4 · Both save at once', async ({ alice, bob, together }) => {
     await test.step('1 · Alice, Bob: both press «Save»', async () => {
       await together(
         () => alice.getByRole('button', { name: 'Save' }).click(),
         () => bob.getByRole('button', { name: 'Save' }).click(),
       );
     });
   });
   ```

   Write it only where the suite says the people act at the same time.
3. **No round proves there is no race**: three rounds are a quick look, ten
   a closer one (a race that needs one person very slow shows in about one
   round in six), and more look further. A search costs N runs of the suite
   with their setups: say how long before you start a long one.
4. **What you deliver is a report**: each race, its seed, and what you think
   the order was. Change nothing until the person says so; a fix is proved
   by the same seed passing several times, then a new search.

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
2. **`npx qa-cockpit video check`**: ffmpeg with libx264, which it tries
   on a few seconds of a video's sound (4.2 and newer can), and
   Playwright's Chromium. ffmpeg is the person's to install (`winget
   install ffmpeg`, `brew install ffmpeg`, `apt install ffmpeg`), or to
   name in the config's `video.ffmpeg`. On Windows, ImageMagick brings an
   ffmpeg of its own, an old one, which may be the first on the PATH.
3. **Only for a narration: a voice**, the first of these you have:
   1. **A voice service among your tools**: any text-to-speech a
      connector of the person's gives you (look at your tools for one that
      makes speech). It speaks best, and it spends the
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
   no real data from the screens. The music is the config's `video.music`
   (the package makes one when it names none). A project's own track goes
   there, once, for all its videos; a video that wants another says so in
   its script's `music`, which wins: from the same service when it makes
   music, with the same yes, or a file of theirs.

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
  app itself. The moment the script's `cover` names (or, unnamed, the end
  of the step that shows most of the app) rises from the bottom in a flat
  browser, with a phone beside it when somebody plays on one, and rests
  just under the title, cut by the frame's bottom edge: the viewer sees
  which app this is before a word is said. The video's first frame is that
  cover, finished, so a player shows it before play (not black); it is
  also saved beside the video as `<suite>-poster.jpg`, for a page's
  `<video poster>` or a README.
- **Nothing stops dead.** What enters slides in and slows down to rest,
  one element a beat after the other (the tag, the title, its rule, the
  subtitle, then the screens, from much further and settling longer); what
  leaves fades. Each step's subtitle rises into place. The cursor glides as
  a hand does, easing in and out, and every press is a ripple and a tic.
- **The sound:** the narration on top, the music stepping back while it
  speaks, the tics; the whole brought to −16 LUFS, the web's usual
  loudness (the config's `video.loudness`; `null` leaves it as mixed). A
  video of tics alone is left as it is.
- **The rhythm:** a step lasts what its subtitle takes to read (`pace`) or
  its narration to say, whichever is longer; a test's card 1.8 s; the cover
  3.8 s; the end 3 s. Cards fade over the steps beside them. The video ends
  on its last card, still: what a player shows once it is over (the
  config's `video.fadeOut: true` fades it to black).
- **A warm run:** a video's run keeps the app's code, styles and fonts in
  memory from their first fetch, for every person after (the config's
  `video.cache`), and first opens the pages the config's `video.warm`
  names (pages whose opening changes nothing): the first screen filmed
  loads as fast as the last, on a development server too. Add `'image'`
  when the app never replaces an image at the same address during a run
  (each upload gets an address of its own): it costs next to nothing, and
  a logo comes with its page instead of a second later. An avatar
  replaced in place would show the old one: then leave images out.
- **The screens:** one 1280×720 screen fills the picture 1:1, as sharp as
  the app; several share it, scaled, each with its label (name · role).
  When a step shows other screens than the step before (Alice's laptop,
  then Bob's phone), the new ones fade in over the old and settle into
  place, their labels taking turns, and the step's first press waits until
  they have; the same screen changing is the app at work, and cuts as it
  did. A screen shows its page from the page's first content (a text, an
  image): never the blank page a browser opens with, nor a bare
  background, nor the moment between two pages.
- **In motion**, a person scrolls to what they press: smoothly, never in
  one jump. A page's load until its first content takes a quarter of a
  second, however long it took; what the page does after it, spinners
  included, plays as it was.

That is the style of every video, for training and for showing the app. A
promotional cut may want another montage: ask the person what they have in
mind, case by case; the clips (`--clips`) are its raw material.

### Making it

1. **A green recording that matches its suite** (`decide` says REPLAY).
   Recordings film well when their actions are on locators
   (`page.getByRole(...).click()`, `.fill()`): those are the ones the video
   paces and brings into view before acting. Never `waitForTimeout`: the
   video sets the rhythm, not the recording. One step per row of the
   suite, numbered as its row: a step's subtitle is the row with its
   number (`video script` and the render say which steps do not match).
   **A motion video plays the recording slower**, as a person would, and
   that shows races a replay hides:
   - Find by `data-testid` what a page repeats or translates: a
     `getByText('Pending to answer')` also matches the counter «1 pending
     to answer», and fails in strict mode once the page has time to show
     both.
   - In a rich editor or a `contenteditable`, click the editable area
     itself and wait for `toBeFocused()` before typing: a click on its
     container does nothing while the editor mounts, and the first letter
     is lost («he teacher climbs»).
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
   does all of that. A step's voice starts with the step; its `voiceAt`
   starts it elsewhere: `"press"` (the step's first press), `"press 2"`,
   or a number of seconds into the step, and the step lasts until the
   voice is done. **Choose the cover** (`cover`): the moment that, seen
   alone, tells what the video is about (an effect, a result, the screen
   that makes somebody want to watch), not the first screen: `"T5/3"` (the
   step's end), `"T5/3 press 2"` (half a second after its second press;
   `"T5/3 press 2 +0.8"` waits longer), `"T5/3 2.4"` (seconds into the
   step). Look at it on the poster (`<suite>-poster.jpg`); `video render
   latest` draws another in a minute. The script's other keys: `quality`
   (`guide` or `motion`), `title`, `subtitle`, `run` (below), `music` (a
   file, `"generated"` or `null`; left out, the config's), `musicVolume`,
   `pace`, `idle` and `speed` (motion).
3. **A page that loads slowly in the video is, most likely, the
   development server's.** Each `goto` of a suite starts the app again, and
   an app served unbundled (Vite's development mode: hundreds of modules)
   evaluates them all every time, from the run's cache or not: on video, an
   app that mounts itself again on every screen. Measure before you film:
   the render says how long the captured pages took from their response to
   their first content («Pages: …»), and
   `curl -o /dev/null -s -w '%{time_total}' <app>/<a static file>` how long
   the server takes for one file. Over about 300 ms a page, or 100 ms a
   file, is the development mode (unbundled modules, a slow development
   server, a mounted file system), not the app.
   Then see whether the project can serve its production build at the same
   address for the recording only: built from the same code with the same
   environment (the API's address...), served by its preview server or a
   static one, and the development server back when the recording ends,
   also when it fails (`try`/`finally`). It changes how the stack runs: ask
   the person first. The project's code does not change, and the video
   shows what its users will get. With a compose stack, recreate the
   front's own service from a temporary override (the same port,
   environment and code; a command that builds and serves the build, such
   as `vite build --outDir /tmp/qa-build && vite preview --port <its
   port>`), and recreate it without the override afterwards. Not a one-off
   container (`docker compose run`) beside the stopped service: the stack's
   check wants its own service to publish the port, and says ENV. Measured
   in one project: pages from 0.4–0.7 s to their first content down to
   0.05–0.24 s, a static file from 600 ms to 5 ms, the recording from 3.1
   to 1.9 minutes, for a build served in 16 s. Where it cannot be done (a
   server rendering tied to the app, a build of minutes, an environment
   that cannot be reproduced), film in development mode: the run's cache
   helps from the second person on.
4. **Make it:** `npx qa-cockpit video <suite>` (`--motion`, `--clips`,
   `--script <file>`, `--out <file>`). «Before you launch anything» holds:
   it takes the stack, resets it and runs the setup. A red run makes no
   video. It prints where the video and its contact sheet are, under
   `<out>/videos/<suite>-<kind>-<time>/`.

   A video that shows only some tests (`tests`) plays every test of the
   suite through the last one it shows: a suite goes in order on one
   database, and the earlier tests build the data the later ones start
   from. Only the tests it shows are captured and drawn; the others run at
   their own pace, as in any replay. For tests that stand on their own,
   `"run": "picked"` plays only the ones shown (faster); `"run": ["T1",
   "T4"]` plays those, and the ones shown, when a test needs some earlier
   tests and not others (to leave out a destructive one, say).
5. **Look at the contact sheet before you say it is done.** For each press:
   the cursor on the very control the subtitle names, and the screen as it
   was before the press. For each step's end: that step's result, not the
   next one's. The number of presses it printed matches the clicks of the
   recording (typing in a field counts as one in a guide; a file upload
   does not). Then say where the video is.
6. **The music that plays is not a given: check it.** A script's `music`
   wins over the config's `video.music`, so a script that names one (a
   0.4.0 `video script` wrote `"generated"` into every new one) plays that
   and hides the project's own track. The render says which one played and
   where it came from («Music: …, from …»): check it against the music the
   person expects. You cannot hear the video: ask them to listen to it
   before it is shown; a wrong track is easy to miss.
7. **A new narration or wording, same run:** `npx qa-cockpit video render
   latest --script <file>` draws the capture again, without replaying.

| What you see | Why | What to do |
|---|---|---|
| The cursor lands where nothing is | The control was off screen and the action was not on a locator | Act through a locator; it is brought into view first |
| A step is missing | Its `test.step` is not «n · Who: …», or its test is not «T1 · …» | Name it so |
| A shown test waits for data that never comes | It needs an earlier test the script's `run` leaves out (`"picked"`, or a list without it) | Leave `run` out (it plays every test before the last shown), or list the test it needs |
| «This capture has no T2» from `video render` | The capture was made for other tests: only the ones shown are captured | `video <suite>` with that script makes a new capture |
| A step shows nobody | Its title names nobody of the cast before the colon | Name who acts |
| «No video: the run must be green» | The recording failed | It is a red replay: the healer, not the video |
| «No video: the run was green …, but drawing it failed» | The drawing, after the run: most often a file the script names (`music`, an `audio`) that ffmpeg cannot read | Mend what the error above it says, then the `video render <capture>` it names: the same capture, without replaying |
| A voice speaks over the wrong step, or never | Its key in `steps` is not `<test id>/<row number>` (`"T1/2"`) | Key it by the suite's test and row |
| A subtitle says another step's words | The recording's steps are numbered apart from the suite's rows (rows merged into one step, or left out); `video script` and the render name them | Number each step as its row; or give the step its own `subtitle` in the script |
| A step fails in motion and not in a replay | A race the slower pace shows: a text found twice, a field typed into before it can take focus | `data-testid`; click the editable area and wait for `toBeFocused()` (step 1) |

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
  names when the step ends (and every open page when it fails), and each
  action inside a step just before it is taken (a click, a field filled, a
  key pressed): an action outside every step has no photo of its own. The
  photos take time (tens of milliseconds each, more on a busy machine): a
  step's time in the cockpit is the step's own, and the photos' is said
  apart, in the inspector and in the run report.
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
the recording follows it. Each person's session is signed in on the device
the suite gives them: a device named in quotes in the recording's
`test.use` is read as it is; a constant, as the suite's last run used it
(`<out>/devices.json`); a person it never names, on the cast's. A phone is
another screen: menus fold, panes stack, a button may move. **Moving a
person to another device means recording their steps again**; never change
a device under a recording that passes. Every browser is Chromium: size,
density, touch and the mobile flag are the device's, the engine is not. The
cockpit shows each card's device (icon and name), photographs each person's
own window, and «Play as» opens at that device's size.

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
.qa-cockpit/            runs, photos, traces, videos, HARs, saved sessions (never committed)
```

(Defaults; the config's `paths` can put each elsewhere.)

## Gotchas

- `up` refuses with «Something already answers on …»: another app has the
  stack's port, most often the developer's own server. The QA copy could
  not listen there, and the other app would answer its health check, so
  the suites would run against it. Give the QA copy a port of its own in
  `.env` (`QA_APP_PORT`, when the config reads it), or stop what is there;
  never point the stack at it.
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
