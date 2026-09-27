# Changelog

## 0.2.0 (unreleased)

- Notes on the photos. In the inspector, a tack dragged onto a photo (or a
  click on the tack, then one on the photo) pins a note to the very point
  it is about and opens a post-it to write it on, saved as it is typed.
  Tacks move by dragging, post-its by their bar; a note is deleted after a
  question. Notes live with their run (`notes.json`), and a run with notes
  is kept past `keepRuns`. The run's report opens with them, and
  `qa-cockpit notes [run]` prints them for an agent: each pin's point in
  the page's own pixels, the action of the step it falls on, and a copy of
  the photo with the tacks drawn.

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
