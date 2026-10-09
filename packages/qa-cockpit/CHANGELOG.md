# Changelog

## 0.9.0 (unreleased)

- The cockpit in fourteen languages: to Catalan, English and Spanish come
  Chinese (simplified), French, German, Hindi, Italian, Japanese, Polish,
  Portuguese (Brazil), Russian, Turkish and Ukrainian. The menu lists them
  by code, each by its own name and by its name in the one in use, and
  scrolls when the window is short. On the first visit the page speaks the
  first of the browser's languages it has (pt-PT finds pt-BR); a language
  picked in the menu stays.
- A sentence that counts takes its language's plural form (1, 2–4 and 5 or
  more in Russian, Ukrainian and Polish; 0 like 1 in French, Portuguese and
  Hindi), from the browser's own rules: every count on the page, photos,
  tests, requests, rounds and notes among them. A label the page quotes
  (what a click pressed, what an accessibility problem names) takes the
  language's own quotation marks, and a list of names its own «and».
- Each language is a file of its own (`src/server/public/i18n/`). A sentence
  a language does not have yet is said in English, and
  `scripts/i18n-check.mjs` lists what each one is missing, and any
  placeholder lost on the way.
- One run button, which does what the suite needs now and says it: a
  replay when the stack's data is as the suite's setup left it; the full
  run (reset, setup, replay) when it is not, with the reason in its
  tooltip (a replay spent it, somebody played by hand, another suite's
  setup, or nothing known); a reset and setup («Reset + Setup») for a suite
  played by hand. Its arrow holds the other runs, only those the suite can
  take: a replay only with a setup, a setup alone only right after a reset.
  A suite with no setup has no run button, and its panel says what to ask
  an agent. The four buttons, some always dead, are gone.
- The changes from an earlier run are a tag: green «No changes», or orange
  with what changed, a click away from the first step that changed in the
  inspector. The run to compare with is picked from a list like the run
  picker's, each run with its time, its tests and its status, by mouse or
  keyboard.
- The photos of sessions saved again in a run (`Sessions`) are no longer a
  change: they are the cockpit's own sign-in, in a run only when the saved
  sessions were old.
- A replay with `--changes` no longer ends red after a green run on
  Windows: Node aborted on its way out (libuv's `UV_HANDLE_CLOSING`
  assertion) when the CLI exited while the comparison's browser and
  sockets were still closing.
- `languages.ready({ page, person })`, optional in the config: before each
  step's look in other languages, whether its screen can be changed now. It
  may wait (for a «Saving…» to turn «Saved»), or return or throw why not (a
  dialog open, a field with the cursor), and that step is skipped with its
  screen untouched; the look goes on at the next one. Before, a refusal
  from `switchTo` counted as a change made, and a screen that moved by
  itself meanwhile stopped the look for the rest of the run.
- The look in other languages takes a step's screen once its words stand
  still a moment (up to 2 s; a clock that never stops is taken as it is),
  and `languages check` once the first page's requests are over and its
  words still for a second: a page still filling in no longer reads as one
  that did not come back the same.
- The end of a run lists the steps not looked at in other languages with
  their reason, the project's or the change's, no longer as «the control
  out of reach».

## 0.8.0 (2026-10-09)

- `replay --a11y`: each step's screen is looked at for accessibility as its
  photo is taken, in Chromium's own accessibility tree, as a screen reader
  reads it. Four rules, few and sure: a button, a link or a tab with no
  name; a field with no label; an image with no text alternative; a control
  the keyboard cannot reach. Each problem is told once a run, where it first
  shows. In the cockpit it is a box on that step's photo, numbered as in the
  list under it, with a badge on the step and a dot on its thumbnail, and a
  switch to hide them. At the end of the run it is a list in the terminal
  (the step, the person, the element as `button#close.icon
  [data-testid=close]`) and a section in the run report. In the cockpit, an
  option of the run. It needs the cockpit, and its time goes with the
  cockpit's own, said apart from the step's. Not a full audit: no
  contrast, no focus order.
- `replay --languages`: each step's screen in the app's other languages
  too, while the suite plays in its own (its recording finds things by
  their words). The project's agent writes in the config how a person
  changes the language, with the app's own control (`languages.switchTo`,
  as a recording would), and tries it with `languages check`: each
  language and back on one screen, whether the words change, whether the
  page loads again, whether it comes back the same, with photos. In a run
  the change is not the step's (no marks, no photos of its actions,
  nothing in the trace); against the suite's own language it finds the
  texts that no longer fit their box, the page grown wider than the
  window, and the translation keys left on the screen. In the cockpit, a
  tab per language over each step's photo (the `I` key goes through
  them), with those in fuchsia; at the end, a list in the terminal, and
  each language's photo in the run report. A step whose control is out
  of reach is skipped, and said; a screen that does not come back word for
  word stops the look for the rest of the run, which goes on in its own
  language. Only when asked, and in the languages asked for: the
  config's `priority` ones (every other one unless it names them), or
  `--languages fr,de`; in the cockpit, the run's option, with the
  languages to choose under it, kept in the browser. The example app
  speaks English, Catalan and Spanish now.
- `replay --realtime`: how long what one person does takes to reach
  another's screen. When a step ends for somebody who did nothing since
  another person acted (that step or the one before, in the same test),
  the hand-off is measured from that action, on the browser's own clock
  (Chromium's network events, the page's screen changes): sent (the first
  request or WebSocket message), received (the first message pushed to
  the other page by WebSocket or server-sent events that carries the words
  its steps quote, as «Hello, Bob!»; with none quoted, the first but a
  stream's own welcome; or its first answer), seen (the first words
  changed on its screen, the quoted ones when there are). Words seen that
  no pushed message carried say «not live», with the answer they likely
  came with: a person slowed by a round of `--chaos` no longer had their
  own stream's welcome taken for the other's message. In the cockpit, a teal
  badge on the step and a line under its photo; at the end, a list in the
  terminal, and each hand-off in the run report. An option of the run in
  the cockpit.
- `replay --chaos [N]`: races between people. The recording plays in
  round 0, as it is, then in N rounds (3 unless said), each from fresh
  data (reset, then the suite's setup), each person slowed in their own
  way by the round's seed: every
  request of theirs waits longer for its answer (Chromium's network
  conditions), what is pushed to their page reaches the app later and in
  order (WebSocket messages, server-sent events), their page runs slower
  (CPU). The rounds are compared step by step: a step that passes in some
  and fails in others is a race, and the terminal lists each with the
  rounds it failed in, how each person was slowed there and its error; a
  step that fails in every round is said apart, as not a race. Each
  round's log and what they found stay in `<out>/chaos/`; the command ends
  red when a round failed. `--chaos-seed <n>` plays one round again, from
  fresh data and slowed the same way, with any look (`--realtime`, say).
  `together`, a fixture like the cast, starts several people's actions at
  once; in a round, each at the offset its seed says. In the cockpit, an
  option of the run with the rounds to play; each round is a run of its
  own, with its seed in the run picker and each person's slowness in the
  inspector, and a strip under the run says what the rounds found, each
  round a way to its run and each failed one a button to play it again.
  The cockpit's history (`cockpit.keepRuns`) counts a search as one run,
  all its rounds together, so its failed round is not the first to go.
  If round 0, with nobody slowed, fails, the suite fails with no slowness
  and the search stops there. With the cockpit, each round is compared
  with round 0: a round that passed and still changed is a near miss,
  said in the terminal and marked in orange in the strip.
- `replay --changes [run]`: changes from an earlier run. When the run
  ends, each step is compared with the same step of the newest green run
  before it made the same way, or of the run named, aligned by test, step
  and person: its photos and its actions' (in the project's Chromium, small
  and with a tolerance; what changed is a box on this run's photo, what was
  taken out a line where it was, and what something above pushed down or
  up is said, not boxed), its requests by endpoint (new, gone, another
  status, more or fewer calls) and its page's errors. In the cockpit, an
  option of the run, kept on once switched on: a strip under the run says
  with which run and how much changed, and compares with another green one
  when picked; a changed step has an orange dot, its photo orange boxes and
  a line under it; the run picker counts them, and the run report has a
  section. `qa-cockpit changes [run]` says it in the terminal (`--against`,
  `--json`), kept in the run (`changes.json`). What changes by itself is
  left out with selectors (`changes.mask` in the config).
  Every step of a run notes its page's errors (console errors, what it
  threw), in the inspector and the run report.
- Reports from «Play as». The window a person plays in is followed as a
  run is: each of their actions (a click, a field typed in, Enter or
  Escape, an option picked) with the window just before it, from a
  screencast kept for a few seconds, so the window is never slowed; the
  page's requests and errors. A strip under the run says who plays, what
  they did since the last report and the errors their page met, with the
  window as it is now. «Make a report» asks what went wrong and turns it
  into a run of kind «play»: steps in a suite's words («4 · Bob: types
  «hola» in «Message»»), each with its photos, requests and page errors,
  then each window as it was when reported, with the note as its error.
  `qa-cockpit play` prints it for an agent (`--list`, every one kept).
  What is typed is kept, to be typed again, but never what went in a
  password's field, a card's, a code's or a token's.
  The strip's «×» drops what the windows did, with no report. A person's
  first action by hand notes the stack's data as played: the Replay button
  asks, and the CLI warns, as after a replay. A run of somebody who plays
  in a window asks first, the window being the run's very session.
- «Play as» is off for the people the run going now plays, and for
  everybody while a reset or a renewal of the saved sessions goes: the
  window would open from the very session the run is using, so what was
  done there the run's person would have done (a sign-out signed the run
  out), and the run, for its part, renewed or cleared the session under
  the window. The button says why, and `open <person>` refuses the same.
  Somebody the run does not play may still open a window, after the word
  of warning the cockpit already gave.
- The example chat lost a message sent while a person's live stream was
  still opening, their history already loaded: the race finder's first
  search found it, with Bob 800 ms behind. It opens the stream first now,
  loads the history once the stream is open, and puts each message in its
  place by its id, so everybody sees the server's order.
- The run's options are as tall as the window lets them, scrolled inside
  when they are more (each look added one), and the rounds of a search are
  a select under its option (3 unless chosen).
- A run started from the page is followed, even when an older run was on
  screen: whoever starts one is there to watch it.
- Tooltips wait for a hand that stays, a second, and the next one a moment:
  a pointer crossing the page showed one after another.
- A step's languages are labelled «Languages:» before their tabs, which
  lost the tooltip that showed between them; the run's option lists every
  language of the app, the suite's own first, always on (its recording
  finds the buttons by their words).
- A run says the looks it took, in the run picker, the line under it and
  the run report: «Full run · languages ca, es · real time». A look at the
  other languages is no second run, and nothing showed it had been taken.
- The run picker counts every test a run ran: a full run (reset, setup and
  the recording) said «5 of 3 tests pass», its setup's tests passed against
  its recording's count.

## 0.7.4 (2026-10-07)

- «Play as» opens on a device of the project's own. It named the device the
  person last played on, and looked that name up in Playwright's list only:
  a size a recording gave as an object (CritKeep's «Escriptori 1600 × 900»)
  was «No device named … in Playwright's list», and no window opened. A name
  is now looked up among the sizes the project's runs played too
  (`devices.json`), and a name that is nobody's opens the person's usual
  device instead of nothing.
- The octopus waves while a run goes even when the system asks for less
  motion (`prefers-reduced-motion`). Windows asks for it when its
  «Animation effects» are off, often a company's default and nobody's
  choice: there the logo stood still, and the cockpit looked idle in the
  middle of a run, while the favicon waved on. The wave is how the cockpit
  says a run is going, so it stays, gentler: four times as slow, the logo's
  legs half as high, the favicon at the same pace. The page's other
  movements (a tooltip's, a note's) still stop.
- The table's timeline no longer dances when it is dragged to its end
  during a run. «Back to live» had a column of its own: as it went, the
  timeline grew under the pointer, its knob fell back from the end, the
  button came back, and so on. It now shares the moment's half, and the
  timeline keeps its width.
- The run's progress says how many tests of how many, without the file
  they are in, which says nothing to whoever watches. Its bar is green
  while the run goes well, red from the first test that fails, and amber
  for a run stopped or lost before its end, as the run picker paints
  them. It was the brand's crimson, which read as an error.
- The table's timeline is neutral, as a player's: light behind its knob,
  dark ahead. It too was the brand's crimson. It is a way through the
  run's time, not its state, which is the progress bar's to say: painted
  red after a failure, it would be red at the moments before it too.

## 0.7.3 (2026-10-06)

- A video's sound is mixed by ffmpeg 4.2 and 4.3 too. Its mix used two
  options they do not have (`adelay`'s `all`, from 4.3; `amix`'s
  `normalize`, from 4.4), and now says the same with what 4.2 has: the
  sound is the same, sample for sample. With the 4.2.3 that ImageMagick
  brings to Windows as its only ffmpeg, a machine captured a whole suite
  and then could not mix its sound.
- `video check`, and `video` before it plays the suite, mix a few seconds
  of sound as a video does: an ffmpeg that cannot says so there, in its
  own words, and not after the capture. Its version said too little: 4.2.3
  passed the check.
- A video whose run was green and whose drawing failed says so, and how to
  draw its capture again without replaying (`video render <capture>`). It
  used to say «the run must be green».
- A step's time in the cockpit is the step's own again: since 0.7.0 it
  counted the photos taken before its actions. Their time is said apart,
  in the inspector («step took 0.2 s, and the cockpit's photos 0.1 s») and
  in the run report, each step's and the run's («the cockpit's photos took
  1.0 s of it»): what the cockpit costs a run is read, not guessed. A
  project that found its replays slower than with 0.3.0 could not tell
  how much of it was the cockpit's.
- Before an action's photo, the target is looked at with one call to the
  browser, not two: 1.6 ms instead of 5.7 here, 8 instead of 28 on a ledger
  of 1500 rows with the CPU slowed four times. A wait for a target not yet
  there is the app's time, and not counted as the photo's. A request the
  cockpit does not keep (a development server's modules) is no longer
  asked for its status, a call each.
- The log: the commands and the cockpit's own words are green, the errors
  red. Both were red, nearly the same.

## 0.7.2 (2026-10-06)

- A cockpit left running while the package is updated says so, and takes
  no run until it is restarted. npm replaces the files under it, and every
  run it starts or follows brings the new code, which it may read wrong:
  CritKeep's, started at 0.4.0 and never restarted, dropped every click of
  0.7.0's photos for a day. It shows a red band («QA Cockpit 0.7.2 is
  installed, but this cockpit still runs 0.4.0: restart it»), refuses its
  buttons' runs, and a run from a terminal is not handed to it and says
  why. A newer CLI tells an older cockpit apart too, back to 0.3.0: its
  run goes on alone, or, the cockpit's own, says so in its log.
- The photos of a run that no frame took (a worker cut short, or newer
  than the cockpit) are removed when the run ends.

## 0.7.1 (2026-10-05)

- A session is signed in on the device the suite gives the person, not on
  the cast's: the sign-in, and the cockpit's photo of it, are on the phone
  they play on. CritKeep's cast names no device (each suite gives its
  own), so Bernat was signed in at a laptop for a suite he plays on an
  iPhone, and his first photo of the run was a laptop's. The recording's
  `test.use({ devices })` says which: a device named in quotes is read as
  it is; a constant (a desk of the project's own size) as the suite's last
  run used it, noted in `<out>/devices.json`; a person it never names
  signs in on the cast's device, as before. No sign-in more than before
  (CritKeep's `/login` takes twenty a minute): the same ones, on the right
  device. `setup`, `replay` and `video` name the suite to their sessions.

## 0.7.0 (2026-10-05)

- A photo of each action. A step's photo comes once its checks pass, and
  the clicks of a modal opened and closed in between were drawn on what
  was left behind, over nothing (found in CritKeep: five clicks in three
  modals, floating over the list). Now each click, field filled and key
  pressed inside a step has a photo of its own: the window just before
  it, its target brought into view as the action would, its mark on it.
  The step's photo keeps the result. In the inspector, the step on screen
  lists its actions under it, the strip shows them small before the
  step's photo, and the arrows and «play» go through them all; a note can
  be pinned on one, and the run's report and `notes` say which action a
  photo was taken before. About 35 ms an action (50 when its target must
  be scrolled to); a key that marks nothing (Escape, Tab) keeps no photo.
  Runs from before show as they did.
- The cockpit's own calls on a page (these photos, the step's, where the
  page was scrolled) are Playwright's internal ones now: the trace and
  Playwright's report show the recording's actions alone, with no
  «Screenshot» or «Evaluate» between them.
- A label clicked is one mark, not two (it clicks its field too).
- The inspector names the device of the photo on screen, not of the
  person's last one. A session is saved on the cast's device (a laptop,
  unless the cast says), and a suite may then put the person on a phone:
  the session's photo, a laptop's, said «iPhone 15» (found in CritKeep).
- The suite picker's search box keeps its size under a long list (with
  CritKeep's twenty-odd suites it was squeezed to 21 px, its filter too),
  a little taller, and no longer takes the focus when the picker opens:
  the list has the keys (arrows, Enter, Escape), and typing goes to the
  box.
- The cockpit's scrollbars as macOS draws them: a thin pill over a track
  nobody sees, faint while the pointer is over its box, clearer while the
  box scrolls, a touch wider under the pointer, and gone a moment after;
  never Windows' arrows and grey gutters, anywhere: the steps, the photo,
  the strip, the post-its, the suite picker, the log. Light on the dark
  panels, dark on a post-it. Firefox gets a thin bar of the same colour.
- The inspector, watching somebody live while they act, shows one pulsing
  chip, «Live», instead of «Live» and «Acting now» side by side, which
  said one thing twice (as a card already did). «Waiting» still shows
  beside «Live», and «Acting now» beside a photo under review.

From CritKeep's first look at its own network with `replay --network`
(no secret in any HAR, a positive control included; the look costs about
5 %), what made noise:

- On a development server (Vite, webpack, Next, found in the HARs) the
  report says so at its top. A call asked twice at the same moment, as
  React's StrictMode does in development, is left out (91 of them in one
  run); a chain is not counted where code arrived between its calls (the
  parts of a page that mount as theirs arrive ask in waves: 51 chains
  became 24, the real ones kept). The comparison leaves chains out there.
- «On a timer» counts a steady call within one page: one made for each
  page a suite opens is none (three of three were that).
- «The same call again» counts within one page, with nothing done
  between: not a page opened again, not a page reading what an action
  changed. Asked twice at once is a finding of its own on a built front.
- Streams by address, a socket's ticket aside, and a development server's
  own reload left out; «opened again and again» within one page.
- Addresses read as the same call: `per_page=6` stays a number, a UUID
  inside a value is an `{id}` too, `%3A` reads `:`; findings show them so,
  never a raw id.
- `network --against previous` compares what the steps asked, not how
  many times by a moment's play: two alike runs say «None», where they
  showed 5 steps and 23 findings changed. It says when nearly every step
  took longer (a busier machine), and counts the calls «slow on the
  server» that came or went with it there, not among the findings. A
  test's own findings (a timer, a stream) are matched by test, whoever
  showed them most.
- With `--bodies`, an error says its code: «403 ACCOUNT_PAUSED».
- New config key `network.notSecret`: names that look like a secret's and
  are none in the app (a game's `session_id`), whose values stay. A JWT
  under one of them is still taken out.
- Shorter: no rows without a call, a place said once (`×2`), «the slowest
  of them» for «the longest alone».

## 0.6.0 (2026-10-05)

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
