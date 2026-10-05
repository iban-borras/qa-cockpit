# Changelog

## 0.6.0 (unreleased)

- `replay <suite> --network`: each person's requests in each test, kept
  as a HAR, each request placed in the step that made it, under
  `<out>/network/<suite>-<time>/`. Then `network` says what they show,
  step by step: calls made one after another (the page waiting for an
  answer to ask the next thing; a call the person caused, by pressing or
  typing in between, starts afresh), the same call again in one step, one
  call per item of a list, calls slow on the server, heavy responses,
  errors, calls on a timer, streams opened again and again; each finding as
  a pattern with the places it shows up. `network --against previous`
  measures a change: the steps whose calls changed, the findings gone and
  new. A request's time runs to its last byte: Playwright's HAR leaves out
  the time it waits for a connection, where calls sent together lose
  theirs (`timings.blocked` here), and counts a TLS handshake for plain
  HTTP. Asked for by a person who audited their endpoints by hand, from
  HARs exported in the browser.
- A HAR never keeps a secret. Playwright writes its own to the system's
  temporary files; only a clean one reaches the project, where the values
  of cookies, Authorization headers, and every header, query parameter,
  form field or JSON key named like a secret (a token, a password, an API
  key, a session id, a signature) are `REDACTED-<id>`, as are JWTs and
  bearer tokens anywhere, each of those values wherever else it shows, and
  this machine's own secrets (the environment's, the cast's passwords). One
  id per value within a run, from a key the run never writes down: a token
  on forty calls still reads as one. The text of the responses is kept only
  with `--bodies`, cleaned the same way.
- New config key `network.keep`: how many looks at a suite's network stay
  (5).
- The skill says when to look (a person asks), what to trust (the counts
  and the chains; the milliseconds are the copy's), and that what comes out
  is a report, cheap fixes first, with nothing changed until the person
  chooses.

From CritKeep's first `--motion` video, each checked there frame by frame:

- The config's `video.colors.background` was set where the stage never
  read it: every video came out on the default's. It is the video's
  background now.
- A screen's rounded corners no longer let a white notch through on a dark
  app: the screens have no background of their own, and an empty one is
  the video's.
- A person's screen shows their page from its first content (a text, an
  image). Before it, the screen showed the white about:blank a browser
  opens with, or the page's bare background (a dark app paints its html's
  colour first: an empty screen), whenever somebody came on screen before
  their page had painted; and so did the moment between two pages. The
  capture notes when each page first painted, and first painted content; a
  capture made before keeps every frame. In motion, a page's load until
  its content takes a quarter of a second, however long it took: the
  screen shows that content already, or the page before.
- A step of a video ends once the images on its screens have arrived and
  its fonts are ready (1.5 s at most): its last frame may stay on screen
  for seconds while a narration finishes, and a check that passed before
  the header's logo arrived held the page without it through a whole step.
- No more squashed screens: a screenshot of the whole page (the cockpit's
  photo of a step, a suite's own) made the screencast send the tall page
  squeezed into the screen's height for a moment, and the video stretched
  it back. A page's frames of another size than its own are left out, also
  in a capture made before.
- In motion, the cursor's long ways took 1.7 to 2.5 s: each move is a
  round trip to the browser, and the glide counted its steps instead of
  timing them. Now by the clock, under 0.7 s.
- In motion, a target out of view is scrolled to smoothly, as a person
  does: Playwright's own scroll jumped there in one frame, which read as
  the app's fault.
- `video script` and the render say when a recording's steps and its
  suite's rows part ways. A step's subtitle is the row with its number, so
  a recording that merged rows showed each step another step's words.
- A step's narration can start on one of its presses, or a number of
  seconds into it (the script's `voiceAt`): the step then lasts until the
  voice is done.
- The skill: one step per row; and two races a motion video shows and a
  replay hides (find by `data-testid` what a page repeats or translates;
  click a rich editor's editable area and wait for its focus before
  typing).
- The cover shows the moment the script's `cover` names, not only a step's
  end: `"T5/3 press 2"` (half a second after its second press, `+0.8` for
  longer), `"T5/3 2.4"` (seconds into the step), `"T5/3"` (its end, as
  before). The skill asks agents to choose it: the moment that, seen alone,
  tells what the video is about (in CritKeep, the burst of stars when a
  game resumes), and to look at it on the poster.
- A video ends on its last card, still, instead of fading to black: its
  last frame is what a player shows once it is over. New config key
  `video.fadeOut` (false) for the black.
- A video's run is a warm one. The files of the kinds the new config key
  `video.cache` names (by default the app's code, styles and fonts) are
  kept in memory from the first time any person's browser fetches them,
  and served from there to everybody after: on a development server, a
  page no longer fetches its hundreds of modules again for every person
  and every test, with an image waiting in line behind them. The run's
  own, filled from the server as it is: a video never films an earlier
  build's code. The first fetch of a file is the browser's own, and a copy
  of it is kept: fetched through Playwright instead, images made a run 20%
  slower in CritKeep; this way, within the noise, and the header's logo
  came 33 ms after its page's first content instead of 931. Images only
  when asked (`'image'`), for an app that never replaces one at the same
  address during a run. And the new `video.warm` names pages to open
  before the first test (ones whose opening changes nothing), so the first
  screen filmed loads warm too.
- The render says how long the captured pages took from their response to
  their first content («Pages: …»). The skill tells agents what a slow one
  means (over about 300 ms: most likely the app's development mode, its
  modules unbundled, evaluated again at every `goto`), how to measure it,
  and what to try before filming: the project's production build served
  at the same address for the recording only, asking the person first,
  and the development server back afterwards, also after a failure (in a
  compose stack, the front's own service recreated from a temporary
  override). In CritKeep, the render said 524 ms a page, and its warning;
  with the build, 173 ms, a static file in 5 ms instead of 600, and the
  recording in 1.9 minutes instead of 3.1.
- A new video of a suite no longer deletes the captures of another suite
  whose name begins with its own and a dash (`chat`, `chat-admin`): the
  captures kept (`video.keep`) are counted by the suite their capture
  names.

## 0.5.0 (2026-10-04)

- A video that shows only some tests of a suite plays every test through
  the last one it shows, since the earlier ones build the data it starts
  from. It played the ones shown alone, and one that needed an earlier
  test waited out its timeout with no video (found in CritKeep, whose
  suites chain their tests). Only the tests shown are captured and drawn;
  the others run at their own pace, uncaptured, with the config's
  `reducedMotion` even in `--motion`. A video script's new `run` says it
  otherwise: `"picked"` plays only the tests shown, a list plays its own.
  A script that names a test the suite lacks is refused before the stack
  is touched, and `video render` says when a capture lacks a test shown.
- When a step shows other screens than the step before (a laptop, then a
  phone), the new ones fade in over the old and settle into place, instead
  of a cut. The same screen changing still cuts: that is the app at work.
  Their labels take turns rather than overlap, and the step's first press
  waits for the swap, so the new screen is seen settled before a finger
  lands on it.
- `video script` no longer writes `"music": "generated"`: a script with no
  `music` plays the config's `video.music`, as it always should have. A
  project's own track there was hidden by every new script (found in
  CritKeep). A script that names its music still wins, and the render says
  so when that hides the config's.
- Every render says which music played and where it came from (the
  script, the config, the default). The skill asks agents to check it
  against the music the person expects, and to ask them to listen: an
  agent cannot hear the video.
- A video's sound is brought to −16 LUFS, the web's usual loudness, in
  two passes of loudnorm (true peak −2 dBTP in the mix, about −1.5 once
  encoded to AAC): a narration came out at
  −26. New config key `video.loudness` (LUFS, or `null` to leave the sound
  as mixed). A video of tics alone is left as it is.

- `.env` beside the config, for what differs from one machine to the
  next: `loadEnv(import.meta.url)`, exported by `qa-cockpit`, reads it into
  the environment, whose own values win (a CI sets its own). The template
  config reads `QA_APP_PORT` from it; `init` writes `.env.example` and
  ignores `.env`; docker compose, started by the CLI, sees the values too.
  `doctor` says what it read, or that a `.env` is there and ignored, and
  where a stack that is down will answer.
- `processStack` refuses to start when something else already answers on
  its port: its own process could not listen there, and the other app (a
  developer's own server, most often) answered the health check, so the
  suites ran against it.

## 0.4.0 (2026-10-03)

From the first project to use QA Cockpit outside CritKeep:

- Any package manager: npm, pnpm, yarn or bun, the one the project's
  lockfile (or `packageManager`) says, also a workspace's lockfile above
  the config. The dependency check and its healing use it, `doctor` names
  it, and the trace viewer is found where pnpm keeps Playwright.
  `--in-docker` still installs with npm, and says so to other projects.
- A person's own browser `context` in the cast: Playwright's options for
  them alone (a locale, a time zone, the headers a proxy would add), in
  their runs, their sessions and «Play as».
- The skill warns that the whole cast browses from one IP, so limits per
  IP count everybody together; that the QA copy's own ports may meet a CSP
  or a CORS written for the development ones; and that the photos and
  reports keep whatever the screens show, so made-up data beats a copy of
  production.
- The npm README opens with the demo video's poster, linking to it.
- `video <suite>`: a demo video of a green suite, from its real screens.
  Each person's page is captured by a CDP screencast of its own, at the
  page's size (the trace's is 800×450, Playwright's video 1 Mbit/s VP8,
  neither adjustable), then drawn in the project's Chromium: a macOS
  cursor gliding to each control, a ripple and a tic on each press, a
  subtitle per step from the suite, a card per test, generated music, and
  the narration a video script names (`video script <suite>`), the music
  ducking under it. `--motion` plays it in real time with the app's
  animations on and the people paced like people; `--clips` adds each step
  of each person as it played, at 60 fps, with the pointer's path as JSON.
  Every video comes with a contact sheet to check. `video render` draws a
  capture again; `video check` says what is missing (ffmpeg). In a video's
  run, the trace keeps its snapshots but not its screenshots, and the
  cockpit's live view shares the capture's frames: two screencasts on one
  page starve each other. New config keys: `video`, `paths.videos`. The
  skill tells agents to make one only when asked, after checking they can.
- A video's cover shows the app itself: the end of the step that shows most
  of it rises from the bottom in a flat browser, a phone beside it when
  somebody plays on one, and rests under the title. Whatever enters a card
  slides in and slows down to rest, one element after the other, and each
  subtitle rises into place: nothing stops dead. The first frame is the
  cover finished, so a player shows it before play instead of black; it is
  saved beside the video too, as `<suite>-poster.jpg`.
- `video voices <suite>`: a script's narration in the system's own voice
  (Windows' System.Speech, macOS's `say`, espeak-ng on Linux), offline,
  for when no voice service is at hand. The skill says the order: a voice
  service among the agent's tools, with the person's yes (it spends their
  credits); else the system's voice, as a draft; else subtitles alone.

## 0.3.0 (2026-09-27)

- `cockpit --detach`: the cockpit started for a person, so that it outlives
  whoever asked for it (an agent's session) and opens its windows on the
  person's desktop. One that answers already is reused, or replaced with
  `--restart` (never during a run). On Windows it starts in a window of its
  own; from a terminal on a desktop nobody sees (an agent's may be), through
  a Task Scheduler task that lives a few seconds; on macOS and Linux, in the
  background with a log. The skill tells agents to use it when somebody asks
  for the cockpit.
- The cockpit's state says its version and process.

## 0.2.0 (2026-09-27)

Built for agents, and now it says so first: the READMEs open with what QA
Cockpit is for, how it goes in three steps, and the cockpit's screens.

- Notes on the photos. In the inspector, a tack dragged onto a photo (or a
  click on the tack, then one on the photo) pins a note to the very point
  it is about and opens a post-it to write it on, saved as it is typed.
  Tacks move by dragging, post-its by their bar; a note is deleted after a
  question. Notes live with their run (`notes.json`), and a run with notes
  is kept past `keepRuns`. The run's report opens with them, and
  `qa-cockpit notes [run]` prints them for an agent: each pin's point in
  the page's own pixels, the action of the step it falls on, and a copy of
  the photo with the tacks drawn.
- A replay that would not find its setup's data is asked about first. The
  CLI writes what the stack's data is after every `reset`, `setup` and
  `replay` (`<out>/stack-data.json`); the cockpit's Replay then asks,
  with «Full run» as the answer Enter takes, and `replay` from a terminal
  warns. A Replay after a Full run whose last test deleted an account no
  longer waits four minutes for a person who is gone.
- The run's report names the suite's own recording file (`.mjs`, `.ts`
  or `.js`), not the first extension of the config.
- Every file of the package ends its lines with LF. 0.1.0 shipped 21 with
  CRLF (published from a Windows working copy): harmless to Node, but
  `init` wrote its templates into projects that way. A check before every
  publish (and in CI) now refuses it.

## 0.1.0 (2026-09-27)

The first version outside CritKeep: what CritKeep's functional tests used
every day, generalised behind one config file.

- The CLI: the stack (`up`, `down`, `purge`, `status`, `reset`), suites
  (`suites`, `setup`, `sessions`, `decide`, `replay`, `stamp`, `hash`,
  `pass`), `open`, `mcp`, `doctor`, `lock` / `unlock`, `init`, and commands
  of the project's own.
- The cockpit: the table of people and its timeline, live screens, the
  inspector (photos, clicks, requests), traces, the run report, runs from
  any terminal followed live, the lock in the header; English, Catalan and
  Spanish.
- The octopus waves its legs while a run goes: the favicon, so a tab in the
  background says so too, and the logo in the header. Still when nothing runs.
- `composeStack` and `processStack` for the two usual ways an app starts.
- Each person on their own device: a `device` per person in the cast, a
  default in `browser.device`, and `test.use({ devices })` per recording.
  The cockpit shows each card's device and fits each person's own window
  into the card; «Play as» opens at the device's size.
- `--in-docker` for a compose stack.
- `init`: a project folder with a commented config, fixtures, the suites'
  guide, an example suite and setup, the agents' skill and a section in
  `AGENTS.md`.
- The wordmark (the octopus and «QA Cockpit» in Sora), for dark and light
  pages, in `assets/`.
- An example project: a two-person chat with its suite, setup and recording,
  Alice at a laptop and Bob on a phone.
