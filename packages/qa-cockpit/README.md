<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="QA Cockpit" width="360">
  </picture>
</h1>

<p align="center"><b>Vibe coding for your integration tests.<br>
Agents write and run the multi-user tests; people watch every screen and judge.</b></p>

> **QA Cockpit is built for coding agents.** Claude Code, Codex, OpenCode,
> Gemini CLI or any agent in a terminal or an app turns a test written in
> plain words into a complete integration test with several people at once,
> runs it, and repairs it when the screen changes. The UX designer and the
> developer do not write tests: they watch each person's screen, step by
> step, and pin a note on whatever is wrong for the agent to fix.

<p align="center"><a href="https://github.com/user-attachments/assets/cf63c079-fdde-4680-871e-3f2f245f8be6"><img src="https://raw.githubusercontent.com/iban-borras/qa-cockpit/main/docs/images/demo-poster.webp" alt="Vibe testing: the 39-second demo of QA Cockpit. Click to watch it." width="900"></a></p>

**How it goes**

1. **You describe the story** in a Markdown suite: who plays (a host, three
   players...), on which device, and what each one must see. Anybody could
   play it by hand.
2. **The agent makes it real**: a Playwright recording with one browser per
   person, replayed after every change, repaired when a screen moves. The
   skill that `init` writes tells it how.
3. **You watch and judge** in the cockpit: every person's screen at every
   step and just before every click, with the requests and the errors. A
   tack on the photo and a note, and the agent knows exactly what to change.

<p align="center"><img src="https://raw.githubusercontent.com/iban-borras/qa-cockpit/main/docs/images/cockpit-note.webp" alt="The inspector: one person's screen at one step, the step's click numbered on it, and a note pinned where something should change" width="900"></p>

Unit and API tests prove each piece on its own. What breaks in a
collaborative app happens *between* people: Alice sends, Bob must see it
arrive; a host opens a session, three players must be let in. Those are the
tests people used to click through by hand, and the ones QA Cockpit hands
to agents.

<p align="center"><img src="https://raw.githubusercontent.com/iban-borras/qa-cockpit/main/docs/images/cockpit-table.webp" alt="The cockpit after a run: one card per person, each with their own screen at the same moment of the story, and a timeline over every step" width="900"></p>

## What you get

- **Suites in Markdown**, with a fixed cast, a setup with checks, and one
  step per person with the exact text they must see. Readable by people,
  playable by agents.
- **Each person on their own device**: the host at a laptop, the players on
  their phones (`device: 'iPhone 15'`, any of Playwright's profiles or a
  size of your own), every card of the cockpit saying which.
- **Recordings** that replay them, carrying the suite's hash: a suite that
  changed is never replayed from a stale recording (`decide` says REPLAY,
  GENERATE or ENV). And a replay that would not find its setup's data
  (after another replay, a reset, another suite's setup) is asked about
  first, with a full run as the answer.
- **The cockpit**, on `localhost` only:
  - a card per person, and a timeline over every step of the run;
  - live screens while a step runs;
  - an inspector with each step's photo, one of each click and field typed
    in from just before it, the requests and their times;
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
  the same browser and fonts on any machine (npm projects).
- **Demo videos of the suites**: the app's real screens with a cursor,
  subtitles, cards, music and, if you want, a narration; or in real time
  with its animations. Made again in minutes when the app changes (below).

<p align="center"><img src="https://raw.githubusercontent.com/iban-borras/qa-cockpit/main/docs/images/cockpit-suites.webp" alt="The suite picker: every suite with where it stands, ready to run, needing a new recording, or with no setup yet" width="900"></p>

## Try it: the example

A two-person chat, zero dependencies, in the repository's `examples/two-person-chat`:

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

npm, pnpm, yarn or bun: QA Cockpit installs with the one your lockfile
says, and heals `node_modules` when it falls behind.

Then make `qa/qa-cockpit.config.mjs` true for your app, or ask your agent:
*«Set QA Cockpit up for this project following qa/SKILL.md»*. Run
`npx qa-cockpit doctor` until everything says ok.

The config is the whole contract between your app and the cockpit:

| Key | What it says |
|---|---|
| `base` | `import.meta.url`: paths in the config are relative to its file |
| `name`, `root` | the app's name; the repo's root, for the paths shown to people and agents |
| `paths` | where the suites, recordings, setups, video scripts, output and saved sessions live |
| `cast` | the people of every suite: `{ alice: { name, email, password, badge, device, context } }`, `context` being Playwright's browser options for that person alone (a locale, a time zone, headers) |
| `stack` | a copy of the app that tests may break: `composeStack(...)`, `processStack(...)`, or your own `urls()`, `up`, `down`, `reset`, `guard` |
| `signIn({ page, person })` | the app's real sign-in; the package saves the session |
| `sessions` | how long a saved session stays fresh; who has an account |
| `helpers` | more fixtures for the recordings: a `db`, a `mail` reader... |
| `browser` | everybody's default device, locale, time zone, reduced motion, the page «Play as» opens |
| `suites` | the headings the documents use, if not English (`Cast`, `Runs`) |
| `cockpit`, `cli` | the cockpit's port and language; how the project runs the CLI |
| `commands` | commands of your own, next to the built-in ones |
| `report` | notes the run report should carry |
| `video` | how demo videos look: the product's name, each person's role, a logo, the colours, the address on the cover, the subtitles' words, the music, the loudness, the ending; what a video's run keeps in memory and the pages it opens first to fill it; where ffmpeg is |
| `network` | how many looks at the network of a suite stay (`keep`), to measure a change against; the names that look like a secret's and are none in this app (`notSecret`: a game's `session_id`) |

What differs from one machine to the next (a port your own dev server
already takes here, the one a container publishes there) goes in `.env`
beside the config, never committed: the config calls
`loadEnv(import.meta.url)` and reads `process.env.QA_APP_PORT ?? '4400'`,
and `.env.example` lists what may be set. The environment wins over the
file, so a CI sets its own. And a stack never starts on a port something
else already answers on: the other app would answer its health check, and
the suites would run against it.

Two copies of `@playwright/test` refuse to run together, so the package
never imports Playwright itself: your project hands its own over, in
`fixtures.mjs` and `playwright.config.mjs`, which `init` writes for you.

## Demo videos, from the same suites

A green suite already says who does what and what each person must see. QA
Cockpit turns it into a video that shows the app to people, with nothing
filmed and nothing edited by hand. Ask your agent: *«Make a demo video of
the chat suite»*.

The example's chat suite as a narrated guide, made by `qa-cockpit video`:

<p align="center"><a href="https://github.com/user-attachments/assets/0a750deb-9273-439e-90a2-46d8d7c6ff85"><img src="https://raw.githubusercontent.com/iban-borras/qa-cockpit/main/docs/images/video-demo-poster.webp" alt="A demo video QA Cockpit made from the example's chat suite: Alice at a laptop, Bob on a phone, narrated. Click to watch it." width="900"></a></p>

- **Guide** (`video <suite>`), for training. A cover with the app itself
  rising in a flat browser (and a phone, when somebody plays on one). Then,
  before each press, the screen as it was, a macOS cursor gliding to the
  control, a ripple and a soft tic; then the screen after. A subtitle per
  step in the suite's own words, held as long as it takes to read; a card
  per test; quiet music made on the spot. Nothing stops dead: what enters
  slows down to rest.
- **Narrated.** A video script (`video script <suite>`) with a narration
  per step, its audio made by any text-to-speech your agent can call, or
  by the system's own voice (`video voices`). Each step lasts what its
  voice does, and the music steps back while it speaks.
- **Motion** (`--motion`), for a richer demo. The app's animations on, the
  pointer moved like a hand (hover effects and all), text typed key by key,
  every frame the page painted, the still moments cut short.
- **Clips** (`--clips`), for a designer who edits the final cut. Each step
  of each person as it really played, at 60 fps, with nothing drawn on it,
  and the pointer's path beside it as JSON, to draw a cursor of their own.

The result is a 1280×840 MP4 (H.264 and AAC) for the web, which opens on its
finished cover (what a player shows before play), the cover as an image
for a page or a README, and a contact sheet with every press and every
step's end, to check before it is shown.
It needs ffmpeg; `video check` says what is missing. When the app changes,
the same command makes it again.

Agents make one only when asked, and check first that they can: a video is
done when somebody has looked at its contact sheet, so an agent that cannot
see images says so instead.

## A look at the network

Ask your agent *«Why does the fairs page feel slow?»* or *«Which calls does
each screen make?»*. It replays the suite with `--network`: each person's
requests, kept per test as a HAR (the browser's own record of a page's
traffic), each one placed in the step that made it. Then `network` says,
step by step:

- the calls made one after another, where the page waited for an answer to
  ask the next thing, and could have asked them together;
- the same call again in one step, or one call per item of a list;
- the calls slow on the server, the heavy responses, the errors, the polls
  on a timer.

The counts and the chains are the app's wherever it runs; the milliseconds
are the QA copy's, on this machine. So the agent reads them as a hint,
reports before it changes anything, and measures a change against the run
before it (`network --against previous`).

A HAR never keeps a secret: the values of cookies, tokens, passwords, API
keys and signed URLs become `REDACTED-<id>` (one id per value, so a token
that goes on forty calls still reads as one) before anything reaches the
project. It is safe for an agent to read and for you to pass on. The text
of the responses is kept only when asked (`--bodies`), cleaned the same
way. Any HAR opens in DevTools as a waterfall (Network, Import HAR).

## Commands

```
up | down | purge | status        the stack
reset                             fresh data; saved sessions cleared
suites                            every suite and what it needs next
setup <suite>                     the suite's setup, sessions saved
sessions                          fresh saved sessions for the cast
decide <suite>                    REPLAY | GENERATE <why> | ENV <why>
replay <suite> [playwright args]  the recording (sessions renewed when old)
replay <suite> --network          ... and each person's requests, as HARs without secrets (--bodies)
network [run]                     what they show, step by step (--against previous: what a change changed)
stamp <suite> | hash <suite>      the suite's hash in the recording's first line
pass <suite> <who> <result> ...   a row in the suite's runs table
open <person>                     a browser window signed in as that person
mcp                               .mcp.json: one Playwright MCP server per person
cockpit [--port p] [--no-open]    the cockpit
cockpit --detach | --restart      the cockpit for a person, outliving whoever asked
notes [run] [--list]              the notes pinned on a run's photos, as Markdown
video <suite> [--motion|--clips]  a demo video: reset, setup, recording, drawn
video render [capture]            the last capture drawn again (a new narration)
video script <suite>              a first video script, in the suite's words
video voices <suite> [--list]     its narration in the system's own voice
video check                       what a video needs from this machine
lock | unlock                     who holds the stack
doctor                            what this machine and this config lack
init [folder] [--claude]          a new project folder, from the templates
```

## Where it comes from

QA Cockpit was born while building CritKeep, a web app for tabletop
role-playing groups, which is still in development.
We released the tool because of how useful it has turned out to be. The
octopus in flying goggles is a cousin of CritKeep's own: one leg per person
of the cast.

Maintained by Iban and Guillem, and written with Claude.

## License

MIT
