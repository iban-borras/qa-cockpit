# AGENTS.md

For coding agents that work **on** QA Cockpit, in this repository. An agent
that **uses** QA Cockpit in a project reads that project's `SKILL.md`, which
`init` writes from [`packages/qa-cockpit/templates/SKILL.md`](packages/qa-cockpit/templates/SKILL.md);
not this file.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Its rules hold for you too,
and they are not repeated here: plain modules and no dependencies, the
package never imports `@playwright/test`, nothing about one app, a cockpit
on the loopback only, English, three languages on the page, comments that
say why, two READMEs. This file adds what an agent needs to work here
without a person beside it.

## Where things are

| Path (in `packages/qa-cockpit/`) | What |
|---|---|
| `bin/qa-cockpit.mjs` | the CLI's entry: finds the config, then `src/cli.mjs` |
| `src/config.mjs` | `defineConfig`, `resolveConfig`: every key, its default, its checks |
| `src/env.mjs` | `loadEnv`: the `.env` beside the config, for what differs per machine |
| `src/cli.mjs` | every command |
| `src/fixtures.mjs`, `src/playwright.mjs` | the cast as Playwright fixtures; the default Playwright config |
| `src/reporter.mjs`, `src/worker.mjs` | what a run tells the cockpit: tests and steps; each person's photos (a step's, and one before each action) and the time they took, clicks and requests |
| `src/a11y.mjs` | `replay --a11y`: a step's screen read from Chromium's accessibility tree, its problems as boxes on the step's photo |
| `src/languages.mjs`, `src/languages-check.mjs` | `replay --languages`: a step's screen in the app's other languages, changed by the config's `languages.switchTo`, and what no longer fits; `languages check`, that change tried on one screen |
| `src/devices.mjs` | a person's device, from Playwright's profiles or the project's own sizes, and their own context options; the device a suite gives each person, for the sessions it signs in |
| `src/deps.mjs` | the project's package manager: which one, whether `node_modules` match its lockfile, how to heal them |
| `src/suites.mjs` | the Markdown suites: their cast, their hash, `decide` |
| `src/compose.mjs`, `src/process.mjs` | the two stacks a project can use |
| `src/lock.mjs` | one run at a time, and who holds the stack |
| `src/stackdata.mjs` | what the stack's data is now: the setup of which suite, or spent by a replay |
| `src/detach.mjs`, `src/desktop.mjs` | `cockpit --detach`: the cockpit started for a person, on their desktop, outliving whoever asked |
| `src/notes.mjs` | the notes pinned on a run's photos, and their Markdown |
| `src/network/` | `replay --network` and `network`: each person's HAR in a run (`capture.mjs`), its secrets taken out before it reaches the project (`sanitize.mjs`), and what it shows, step by step (`report.mjs`) |
| `src/video/` | `video`: the capture in a run (`capture.mjs`), the plan of a video (`plan.mjs`), its drawing on a Chromium stage and its encoding (`render.mjs`; the design is `stage.html`), its sound (`audio.mjs`), its script (`script.mjs`), the system's voice (`voices.mjs`) |
| `src/server/server.mjs` | the cockpit's server: the runs, the API, the files it serves |
| `src/server/public/` | the cockpit's page: `cockpit.js`, `cockpit.css`, `i18n.js` |
| `src/docker/` | `--in-docker`: Playwright in the official image |
| `templates/` | what `init` writes, and the agents' skill |

The example, [`examples/two-person-chat`](examples/two-person-chat), is the
package's end-to-end test: a chat app (`app/`) and its QA Cockpit project
(`qa/`), where Alice is at a laptop and Bob on a phone.

## Before you propose a change

Run what CI runs ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
cd packages/qa-cockpit
find bin src templates -name '*.mjs' -o -name '*.js' | xargs -n1 node --check
npm pack --dry-run
cd ../../examples/two-person-chat/qa
npm ci
npx playwright install chromium
npx --no-install qa-cockpit up
npx --no-install qa-cockpit setup chat
npx --no-install qa-cockpit replay chat
npx --no-install qa-cockpit decide chat      # REPLAY
npx --no-install qa-cockpit down
```

`--no-install` matters: without it, `npx` may fetch a published `qa-cockpit`
from npm instead of the one in this checkout.

## Checking a change to the cockpit

- **The server is read once; the page is not.** A change under
  `src/server/public/` shows on a reload. A change to `server.mjs` or to a
  module it imports (`notes.mjs`, `config.mjs`...) needs the cockpit
  restarted.
- **The example's cockpit** runs on port 3160:
  `npx --no-install qa-cockpit cockpit --no-open` from
  `examples/two-person-chat/qa`, with the app `up` and one run to look at
  (`setup chat`, then «Full run» on the page, or `replay chat`).
- **Look at it at a desktop size.** A narrow browser pane squeezes the
  inspector until it tells you nothing. Drive a Chromium of your own at
  1440×900 with the example's Playwright (`createRequire` from
  `examples/two-person-chat/qa`), move with `page.mouse` for drags, and read
  its screenshots.
- **Somebody may be using the same cockpit.** Never edit, move or delete
  runs or notes you did not make: find yours by id, not by position.
- **Non-ASCII text goes through Node** (`fetch`), not as a `curl` argument:
  on Windows a shell can hand it over in another code page, and «ó» arrives
  broken.

## Line endings and modes

- The repository is LF (`.gitattributes`). A Windows checkout may show CRLF
  in the working copy: match text without `\r`, and let git normalise it.
- Every file is `100644`. Scripts run as `node file`, never by name.

## Changing what people see

- **A config key:** a default that keeps every existing project working;
  the table in both READMEs; the skill if agents need it.
- **A command:** its help in `src/cli.mjs`, «Commands» in both READMEs and
  in `templates/SKILL.md`.
- **A sentence on the page:** in `i18n.js`, in Catalan, Spanish and English.
- **The example stays green.** A change to its suite is a new recording, or
  a `stamp` when only the words changed.
- **The CHANGELOG:** an entry under the version in progress,
  `## x.y.z (unreleased)`.

## Releases, pushes and tags are a maintainer's

Semver; while in 0.x a new feature raises the minor. A release is a commit
`release: x.y.z` that sets the version in `package.json` and dates its
CHANGELOG heading. A maintainer pushes it, publishes it
(`npm publish` from `packages/qa-cockpit`) and tags it `vx.y.z`. An agent
prepares all of that and does none of it.

## Commits

As [`CONTRIBUTING.md`](CONTRIBUTING.md) says: a conventional title and a
short body. Sign yours with a `Co-Authored-By:` line that names the agent.
