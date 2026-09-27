# Contributing

Thank you for looking. QA Cockpit is small on purpose: a thin layer on
Playwright for suites where several people act at once, and a cockpit to
watch them.

**Until 0.1.0 is published**, the maintainers mirror this repository from
the project where QA Cockpit was born. Please open an issue before a pull
request, so nothing you write gets lost in the mirror.

## Running it

Node 20 or newer. The example is the package's own end-to-end test:

```bash
cd examples/two-person-chat/qa
npm install
npx playwright install chromium
npx qa-cockpit up
npx qa-cockpit setup chat
npx qa-cockpit replay chat       # 3 tests, green
npx qa-cockpit cockpit           # «Full run» should be green too
npx qa-cockpit down
```

Run it before any change is proposed, and say in the pull request that you
did.

CI (`.github/workflows/ci.yml`) runs the same on Linux and Windows for
every pull request, and checks that `npm pack` ships what it must and that
`init` scaffolds a project that loads.

## The code

- **Plain JavaScript modules** (`.mjs`), JSDoc where a type helps. No build
  step, and no dependency beyond Node's own modules.
- **The package never imports `@playwright/test`.** Two copies of it in one
  run make Playwright refuse to start, and the project's copy is the one
  that counts: the project hands its `test` over (`cockpitFixtures`), and
  the package reaches the rest with `createRequire` from the project's
  folder (`playwrightOf`).
- **Nothing about one app in the package.** What an app needs goes through
  the config (`src/config.mjs`); if a new need does not fit it, the config
  grows a key, with a default that keeps every existing project working.
- **The cockpit listens on the loopback only**, answers only its own page,
  and serves only its own files and the runs'. It can reset a database and
  start processes: keep it that way.
- **English** in code, comments and docs. The cockpit's words live in
  `src/server/public/i18n.js` (English, Catalan, Spanish); a new sentence
  goes in all three.
- **Comments say why**, not what: the reason a line is there, the incident
  that taught it, the thing that would break without it.

## Two READMEs

`packages/qa-cockpit/README.md` is what npm shows; `README.md` at the root is
the repository's front page. They say the same, with the paths each one
needs: change both.

## Commits

A conventional title (`feat:`, `fix:`, `docs:`...) and a short body: what
changed and why, in a few lines. The diff says the rest.

## License

By contributing you agree that your work is released under the
[MIT license](LICENSE).
