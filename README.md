<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/qa-cockpit/assets/wordmark-dark.svg">
    <img src="packages/qa-cockpit/assets/wordmark-light.svg" alt="QA Cockpit" width="360">
  </picture>
</h1>

**Multi-person Playwright suites for collaborative web apps, watched live:
one card per person, step by step.**

Unit and API tests prove each piece on its own. What breaks in a
collaborative app happens *between* people: Alice sends, Bob must see it
arrive; a host opens a session, three players must be let in. QA Cockpit
runs those stories with one real browser per person, and shows every run in
a local cockpit where you can follow each person's screen, step by step,
with a photo of every step, the clicks, the requests and the errors.

It is also built for the way tests get written now: by agents. A suite is a
Markdown document a person could play by hand; an agent records it as a
Playwright test (the *director*), repairs it when the screen changes (the
*healer*), and every run, from any agent or any terminal, shows up live in
the same cockpit for the people who watch.

## What you get

- **Suites in Markdown**, with a fixed cast, a setup with checks, and one
  step per person with the exact text they must see. Readable by people,
  playable by agents.
- **Each person on their own device**: the host at a laptop, the players on
  their phones (`device: 'iPhone 15'`, any of Playwright's profiles or a
  size of your own), every card of the cockpit saying which.
- **Recordings** that replay them, carrying the suite's hash: a suite that
  changed is never replayed from a stale recording (`decide` says REPLAY,
  GENERATE or ENV).
- **The cockpit**, on `localhost` only:
  - a card per person, and a timeline over every step of the run;
  - live screens while a step runs;
  - an inspector with each photo, the clicks, the requests and their times;
  - notes pinned on the photos: a tack dropped on the very point a note is
    about, and a post-it to write it on; the report and `notes` hand them
    to an agent, with a copy of the photo showing each tack;
  - Playwright's trace viewer;
  - a Markdown report of the whole run, written for a model to read;
  - English, Catalan and Spanish.
- **One run at a time.** A lock names who holds the stack («Claude runs
  replay chat since 10:42»). Runs launched from any terminal are followed
  live as if the cockpit had started them.
- **Agent-first setup.** `init` writes a skill (`SKILL.md`) that tells any
  agent how to configure the project, run, record and heal, and points the
  repo's `AGENTS.md` at it.
- **`--in-docker`**: Playwright in the official image of the pinned version,
  the same browser and fonts on any machine.

## Try it: the example

A two-person chat, zero dependencies, in [`examples/two-person-chat`](examples/two-person-chat):

```bash
cd examples/two-person-chat/qa
npm install
npx playwright install chromium
npx qa-cockpit up              # starts the app
npx qa-cockpit setup chat      # a fresh app, Alice and Bob signed in
npx qa-cockpit replay chat     # the recording: three tests, Alice at a laptop, Bob on a phone
npx qa-cockpit cockpit         # then press «Full run» and watch
```

## In your project

```bash
npx qa-cockpit init            # writes ./qa: config, fixtures, suites, SKILL.md...
cd qa && npm install && npx playwright install chromium
```

Then make `qa/qa-cockpit.config.mjs` true for your app, or ask your agent:
*«Set QA Cockpit up for this project following qa/SKILL.md»*. Run
`npx qa-cockpit doctor` until everything says ok.

The config is the whole contract between your app and the cockpit:

| Key | What it says |
|---|---|
| `base` | `import.meta.url`: paths in the config are relative to its file |
| `name`, `root` | the app's name; the repo's root, for the paths shown to people and agents |
| `paths` | where the suites, recordings, setups, output and saved sessions live |
| `cast` | the people of every suite: `{ alice: { name, email, password, badge, device } }` |
| `stack` | a copy of the app that tests may break: `composeStack(...)`, `processStack(...)`, or your own `urls()`, `up`, `down`, `reset`, `guard` |
| `signIn({ page, person })` | the app's real sign-in; the package saves the session |
| `sessions` | how long a saved session stays fresh; who has an account |
| `helpers` | more fixtures for the recordings: a `db`, a `mail` reader... |
| `browser` | everybody's default device, locale, time zone, reduced motion, the page «Play as» opens |
| `suites` | the headings the documents use, if not English (`Cast`, `Runs`) |
| `cockpit`, `cli` | the cockpit's port and language; how the project runs the CLI |
| `commands` | commands of your own, next to the built-in ones |
| `report` | notes the run report should carry |

Two copies of `@playwright/test` refuse to run together, so the package
never imports Playwright itself: your project hands its own over, in
`fixtures.mjs` and `playwright.config.mjs`, which `init` writes for you.

## Commands

```
up | down | purge | status        the stack
reset                             fresh data; saved sessions cleared
suites                            every suite and what it needs next
setup <suite>                     the suite's setup, sessions saved
sessions                          fresh saved sessions for the cast
decide <suite>                    REPLAY | GENERATE <why> | ENV <why>
replay <suite> [playwright args]  the recording (sessions renewed when old)
stamp <suite> | hash <suite>      the suite's hash in the recording's first line
pass <suite> <who> <result> ...   a row in the suite's runs table
open <person>                     a browser window signed in as that person
mcp                               .mcp.json: one Playwright MCP server per person
cockpit [--port p] [--no-open]    the cockpit
notes [run] [--list]              the notes pinned on a run's photos, as Markdown
lock | unlock                     who holds the stack
doctor                            what this machine and this config lack
init [folder] [--claude]          a new project folder, from the templates
```

## This repository

| Folder | What |
|---|---|
| [`packages/qa-cockpit`](packages/qa-cockpit) | the npm package: the CLI, the cockpit, the fixtures and the reporter, `init` and its templates, the agents' skill |
| [`examples/two-person-chat`](examples/two-person-chat) | a tiny chat app (`app/`) and its QA Cockpit project (`qa/`): a suite, its setup and its recording |

How to work on it: [CONTRIBUTING.md](CONTRIBUTING.md).

## Where it comes from

QA Cockpit was born while building CritKeep, a web app for tabletop
role-playing groups, which is still in development.
We released the tool because of how useful it has turned out to be. The
octopus in flying goggles is a cousin of CritKeep's own: one leg per person
of the cast.

Maintained by Iban and Guillem, and written with Claude.

## License

[MIT](LICENSE)
