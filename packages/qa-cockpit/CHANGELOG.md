# Changelog

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
