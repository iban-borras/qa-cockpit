# Changelog

## 0.5.0 (unreleased)

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
  two passes of loudnorm (true peak −1.5 dBTP): a narration came out at
  −26. New config key `video.loudness` (LUFS, or `null` to leave the sound
  as mixed). A video of tics alone is left as it is.

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
