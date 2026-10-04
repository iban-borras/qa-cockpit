// The CLI: `npx qa-cockpit <command> [args]` (or the project's own wrapper).
// The skill says when to run what; this file only knows how. Everything
// about the app under test comes from the project's config (config.mjs):
// how its stack starts, resets and signs a person in.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRecordingPath, recordingOf, resolveConfig, setupOf, shown } from './config.mjs';
import { depsStale, installDeps, packageManager, playwrightCli as playwrightCliOf } from './deps.mjs';
import { acquireLock, breakLock, lockFileOf, readLock, StackBusy } from './lock.mjs';
import { noteData, readData, staleFor, staleLine } from './stackdata.mjs';
import { decide, listSuites, recordPass, suiteHeader } from './suites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** «app X, API Y», the API left out when it is the app's own address. */
const where = (urls) => `app ${urls.app}${urls.api && urls.api !== urls.app ? `, API ${urls.api}` : ''}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Wait until the stack answers: its API's health path, when it has one,
 * then the app itself; or the project's own `stack.health(urls)`.
 */
export async function waitHealthy(config, timeoutMs = 240_000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const urls = config.stack.urls();
      if (config.stack.health) {
        if (await config.stack.health(urls)) return urls;
        lastError = 'the stack says it is not healthy yet';
      } else {
        const api = urls.api && config.stack.healthPath ? await fetch(`${urls.api}${config.stack.healthPath}`) : null;
        if (!api || api.ok) {
          const app = await fetch(urls.app);
          if (app.ok) return urls;
          lastError = `the app answered ${app.status}`;
        } else {
          lastError = `the API answered ${api.status}`;
        }
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`The stack did not become healthy in ${timeoutMs / 1000}s (${lastError}).`);
}

/**
 * Run a command line against a project.
 * @param {any} rawConfig the project's config (or a resolved one)
 * @param {string[]} argv the arguments after the program's name
 */
export async function runCli(rawConfig, argv) {
  const config = resolveConfig(rawConfig);
  const P = config.paths;
  const CLI = config.cli;
  const LOCK = lockFileOf(config);
  const [command = 'help', ...args] = argv;
  // `--in-docker` (or QA_IN_DOCKER=1): Playwright runs in the official image
  // instead of on this machine (docker/runner.mjs). Any command that runs
  // Playwright takes it.
  const IN_DOCKER = args.includes('--in-docker') || process.env.QA_IN_DOCKER === '1';
  const rest = args.filter((a) => a !== '--in-docker');
  const guard = () => {
    config.stack.urls();
    config.stack.guard?.();
  };

  // One run at a time on the stack (lock.mjs): a command that changes its
  // state holds it until it exits, and hands it to what it starts.
  function holdStack(what) {
    try {
      const lock = acquireLock(LOCK, what, { cli: CLI });
      process.env.QA_LOCK = lock.token;
      return lock.who;
    } catch (e) {
      if (e instanceof StackBusy) fail(e.message);
      throw e;
    }
  }

  // ── a run from this terminal, followed by the cockpit ──
  //
  // When the cockpit is up, a run launched here shows there as if its
  // buttons had started it: the cockpit is told the run begins, Playwright
  // reports its steps, photos and traces to it (COCKPIT_URL, COCKPIT_RUN),
  // everything this process writes is copied to its log, and the end says
  // how it went. The terminal sees exactly what it saw before. A child of
  // the cockpit (COCKPIT_RUN already set) is the cockpit's own run and says
  // nothing; with no cockpit, nothing changes. A process that dies without a
  // word is found by the cockpit, which watches its pid.
  const COCKPIT = `http://127.0.0.1:${config.cockpit.port}`;
  let report = null; // { lines, timer }

  async function announce(kind, suite, commandLine, who) {
    if (process.env.COCKPIT_RUN || report) return;
    let begun;
    try {
      const r = await fetch(`${COCKPIT}/api/external/begin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, suite, command: commandLine, who, pid: process.pid }),
        signal: AbortSignal.timeout(1_500),
      });
      if (!r.ok) return;
      begun = await r.json();
    } catch {
      return; // no cockpit: the run is this terminal's alone
    }
    process.env.COCKPIT_URL = COCKPIT;
    process.env.COCKPIT_RUN = begun.run;
    process.env.QA_TEE = '1';
    report = { lines: [], timer: null };
    tee(process.stdout, false);
    tee(process.stderr, true);
    process.on('exit', endReport);
    console.log(`The cockpit follows this run: ${COCKPIT}`);
  }

  function tee(stream, err) {
    const write = stream.write.bind(stream);
    let partial = '';
    stream.write = (chunk, ...more) => {
      const lines = (partial + String(chunk)).split(/\r?\n/);
      partial = lines.pop();
      for (const text of lines) report.lines.push({ text, err });
      if (!report.timer) report.timer = setTimeout(flushReport, 250);
      return write(chunk, ...more);
    };
  }

  function flushReport() {
    report.timer = null;
    const lines = report.lines.splice(0);
    if (!lines.length) return;
    fetch(`${COCKPIT}/api/external/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: process.pid, lines }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }

  // An exit handler cannot wait for a fetch: a small node of its own sends
  // the last lines and the end, with the body on its stdin.
  function endReport(code) {
    const body = JSON.stringify({ pid: process.pid, code, lines: report.lines.splice(0) });
    spawnSync(
      process.execPath,
      [
        '-e',
        "let b='';process.stdin.on('data',(d)=>(b+=d)).on('end',()=>fetch(process.argv[1],{method:'POST',headers:{'Content-Type':'application/json'},body:b}).catch(()=>{}))",
        `${COCKPIT}/api/external/end`,
      ],
      { input: body, timeout: 5_000, windowsHide: true },
    );
  }

  /** The stack for this command, and the cockpit told when it is up. */
  async function takeStack(kind, suite, commandLine) {
    const who = holdStack(commandLine);
    await announce(kind, suite, commandLine, who);
  }

  /** A child whose output goes through this process's own streams. */
  function piped(cmd, cmdArgs) {
    return new Promise((resolve) => {
      const child = spawn(cmd, cmdArgs, { cwd: P.project, stdio: ['inherit', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => process.stdout.write(d));
      child.stderr.on('data', (d) => process.stderr.write(d));
      child.on('error', () => resolve(1));
      child.on('close', (c) => resolve(c ?? 1));
    });
  }

  // Playwright takes test files as regular expressions matched against paths
  // with forward slashes: a Windows relative path (backslashes) matches
  // nothing. Forward slashes, dots escaped.
  function testFileArg(file) {
    const rel = path.relative(P.project, file).split(path.sep).join('/');
    return rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // The project installs itself, with its own package manager (deps.mjs):
  // its node_modules must match its lockfile, and a run on this machine
  // needs Playwright's Chromium. Both heal on the spot.
  function checkDepsStale() {
    try {
      return depsStale(config);
    } catch (err) {
      fail(err.message);
    }
  }

  function healDeps(why) {
    try {
      installDeps(config, why);
    } catch (err) {
      fail(err.message);
    }
  }

  function chromiumInstalled() {
    const code =
      "const { chromium } = require('@playwright/test'); process.exit(require('fs').existsSync(chromium.executablePath()) ? 0 : 1);";
    return spawnSync(process.execPath, ['-e', code], { cwd: P.project, stdio: 'pipe' }).status === 0;
  }

  const playwrightCli = () => playwrightCliOf(config);

  function healChromium() {
    console.log("Playwright's Chromium is missing: installing it...");
    const r = spawnSync(process.execPath, [playwrightCli(), 'install', 'chromium'], { cwd: P.project, stdio: 'inherit' });
    if (r.status !== 0) fail("Could not install Playwright's Chromium.");
  }

  /** For anything that runs here: the dependencies and the browser. */
  function ensureReady({ browser = true } = {}) {
    const stale = checkDepsStale();
    if (stale) healDeps(stale);
    if (browser && !chromiumInstalled()) healChromium();
  }

  // Playwright through its own entry point with this very node: no npx, no
  // shell, the same on Windows and Linux. With --in-docker, in the runner
  // container instead.
  async function playwright(pwArgs) {
    if (P.playwrightConfig) pwArgs = [pwArgs[0], '--config', P.playwrightConfig, ...pwArgs.slice(1)];
    if (!IN_DOCKER) ensureReady();
    let code;
    if (IN_DOCKER) {
      if (pwArgs.includes('--headed')) {
        console.log('--headed ignored: a browser in a container has no screen of yours.');
        pwArgs = pwArgs.filter((a) => a !== '--headed');
      }
      const { runInDocker } = await import('./docker/runner.mjs');
      code = await runInDocker(config, pwArgs);
    } else {
      code = process.env.QA_TEE
        ? await piped(process.execPath, [playwrightCli(), ...pwArgs])
        : (spawnSync(process.execPath, [playwrightCli(), ...pwArgs], { cwd: P.project, stdio: 'inherit' }).status ?? 1);
    }
    if (code !== 0) process.exit(code);
  }

  /** True when there are saved sessions and none is older than maxAgeMs. */
  function sessionsFresh(maxAgeMs) {
    if (!fs.existsSync(P.state)) return false;
    const files = fs.readdirSync(P.state).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return false;
    const oldest = Math.min(...files.map((f) => fs.statSync(path.join(P.state, f)).mtimeMs));
    return Date.now() - oldest < maxAgeMs;
  }

  function clearSavedSessions() {
    if (!fs.existsSync(P.state)) return;
    for (const f of fs.readdirSync(P.state)) {
      if (f.endsWith('.json')) fs.rmSync(path.join(P.state, f));
    }
  }

  function savedSessions() {
    return fs.existsSync(P.state)
      ? fs.readdirSync(P.state).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
      : [];
  }

  const ctx = { config, holdStack, clearSavedSessions, waitHealthy: () => waitHealthy(config), log: (...a) => console.log(...a) };
  const STACK = config.stack.name;

  const commands = {
    async up() {
      if (!config.stack.up) fail(`The stack "${STACK}" has no \`up\`: start it yourself, then ${CLI} status.`);
      fs.mkdirSync(P.state, { recursive: true });
      fs.mkdirSync(P.out, { recursive: true });
      await config.stack.up(ctx);
      const urls = await waitHealthy(config);
      guard();
      console.log(`\nThe stack "${STACK}" is up: ${where(urls)}`);
    },

    async down() {
      if (!config.stack.down) fail(`The stack "${STACK}" has no \`down\`.`);
      holdStack('down');
      await config.stack.down(ctx);
      console.log(`The stack "${STACK}" stopped; its data is kept.`);
    },

    // Removes the stack's volumes too (database, uploads...). Only this
    // project's: the developer's own stack has its own.
    async purge() {
      if (!config.stack.purge) fail(`The stack "${STACK}" has no \`purge\`.`);
      holdStack('purge');
      await config.stack.purge(ctx);
      // Its next `up` starts from nothing: as after a reset, no setup yet.
      noteData(config, { state: 'reset' });
      clearSavedSessions();
      console.log(`The stack "${STACK}" removed with its volumes.`);
    },

    async status() {
      try {
        const urls = config.stack.urls();
        console.log(`The stack "${STACK}": ${where(urls)}`);
      } catch (e) {
        console.log(`The stack "${STACK}": down (${e instanceof Error ? e.message : e})`);
        return;
      }
      const people = savedSessions();
      console.log(`Saved sessions: ${people.length ? people.join(', ') : `none (run: ${CLI} setup <suite>)`}`);
      for (const line of (await config.stack.status?.(ctx)) ?? []) console.log(line);
    },

    // A fresh start for the app's data (the project's `stack.reset`), then
    // the stack answering again and every saved session gone with it.
    async reset() {
      if (!config.stack.reset) fail(`The stack "${STACK}" has no \`reset\`.`);
      guard();
      await takeStack('reset', null, 'reset');
      noteData(config, { state: 'resetting' });
      const said = await config.stack.reset(ctx);
      await waitHealthy(config);
      noteData(config, { state: 'reset' });
      clearSavedSessions();
      console.log(`${said ? `${said} ` : 'Fresh data. '}Saved sessions cleared.`);
    },

    // The cast and the initial state of a suite, then one saved browser
    // session per person (<setups>/<suite>.setup.*).
    async setup() {
      const suite = rest[0];
      if (!suite) fail(`Usage: ${CLI} setup <suite>`);
      const file = setupOf(config, suite);
      if (!file) fail(`No setup for the suite "${suite}" in ${P.setups}`);
      guard();
      await takeStack('setup', suite, `setup ${suite}`);
      fs.mkdirSync(P.state, { recursive: true });
      // A setup that fails leaves «setting-up» behind (playwright() exits).
      noteData(config, { state: 'setting-up', suite });
      await playwright(['test', testFileArg(file)]);
      noteData(config, { state: 'setup', suite });
    },

    async smoke() {
      if (!P.smoke) fail('The config names no smoke test (paths.smoke).');
      guard();
      await playwright(['test', testFileArg(P.smoke)]);
    },

    // Fresh sessions for everybody with an account: saved ones may go stale.
    async sessions() {
      if (!P.sessionsSetup) fail('The config names no sessions setup (paths.sessionsSetup).');
      guard();
      await takeStack('sessions', null, 'sessions');
      fs.mkdirSync(P.state, { recursive: true });
      await playwright(['test', testFileArg(P.sessionsSetup)]);
    },

    // Runs the recording of a suite, sessions first unless every saved one
    // is younger than config.sessions.freshFor.
    async replay() {
      const suite = rest[0];
      if (!suite) fail(`Usage: ${CLI} replay <suite> [--in-docker] [playwright args]`);
      const file = recordingOf(config, suite);
      if (!file) fail(`No recording for the suite "${suite}" in ${P.recordings}`);
      guard();
      await takeStack('replay', suite, ['replay', ...rest].join(' '));
      fs.mkdirSync(P.state, { recursive: true });
      // Said, not refused: one test run again on purpose (`-g T3`) is a
      // replay after a replay too.
      const stale = staleFor(readData(config), suite);
      if (stale) console.log(`${staleLine(stale)} The recording may fail for that: \`${CLI} reset\` and \`${CLI} setup ${suite}\` first.`);
      if (!P.sessionsSetup || sessionsFresh(config.sessions.freshFor)) {
        if (P.sessionsSetup) console.log('Saved sessions are fresh; not renewing them.');
      } else {
        await playwright(['test', testFileArg(P.sessionsSetup)]);
      }
      // From its first test on, a recording changes the data.
      noteData(config, { state: 'spent', suite });
      await playwright(['test', testFileArg(file), ...rest.slice(1)]);
    },

    // A demo video of a suite (video/): its recording played again with a
    // capture of each person's screen, then drawn into a video with a
    // cursor, subtitles, cards and sound. Only when a person asks for one.
    async video() {
      const usage = [
        `Usage: ${CLI} video <suite> [--motion] [--clips] [--script <file>] [--no-reset] [--out <file>]`,
        `       ${CLI} video render [<capture> | latest] [--script <file>] [--clips] [--guide | --motion] [--out <file>]`,
        `       ${CLI} video script <suite> [--force]`,
        `       ${CLI} video voices <suite> [--script <file>] [--voice <name>] [--force] | video voices --list`,
        `       ${CLI} video check`,
      ].join('\n');
      const sub = rest[0];
      if (!sub) fail(usage);
      const flag = (name) => rest.includes(name);
      const value = (name) => {
        const i = rest.indexOf(name);
        if (i === -1) return null;
        if (!rest[i + 1] || rest[i + 1].startsWith('--')) fail(usage);
        return rest[i + 1];
      };
      const option = (name) => (value(name) ? path.resolve(process.cwd(), value(name)) : null);
      const videosOut = path.join(P.out, 'videos');
      const { ffmpegStatus, renderVideo } = await import('./video/render.mjs');

      if (sub === 'check') {
        // What a video needs from this machine. What it needs from the agent
        // (eyes, for the contact sheet) only the agent can say.
        const ff = ffmpegStatus(config);
        const chromium = chromiumInstalled();
        console.log(`${ff.ok ? ' ok ' : 'FAIL'}  ffmpeg: ${ff.detail}`);
        console.log(`${chromium ? ' ok ' : 'FAIL'}  Chromium: ${chromium ? 'installed' : `missing (${CLI} doctor installs it)`}`);
        // Only for a narration, and only when no voice service is at hand.
        const { systemSpeech } = await import('./video/voices.mjs');
        const speech = systemSpeech();
        console.log(` --   System voice: ${speech ? `${speech} (${CLI} video voices --list)` : 'none (on Linux: espeak-ng)'}`);
        console.log(`      Video scripts in ${shown(config, P.videos)}; videos in ${shown(config, videosOut)}`);
        if (!ff.ok || !chromium) process.exitCode = 1;
        return;
      }

      // The operating system's own voice for a script's narration, when no
      // voice service is at hand (video/voices.mjs): each narration without
      // its audio is spoken into a file beside the script, which then names it.
      if (sub === 'voices') {
        const { AUDIO_EXT, listVoices, speakAll, systemSpeech } = await import('./video/voices.mjs');
        if (!systemSpeech()) fail('This system has no voice: Windows and macOS have one; on Linux, install espeak-ng.');
        if (flag('--list')) {
          for (const v of listVoices()) console.log(`${v.name}\t${v.lang}`);
          return;
        }
        const suite = rest[1] && !rest[1].startsWith('--') ? rest[1] : null;
        const scriptFile = option('--script') ?? (suite ? path.join(P.videos, `${suite}.json`) : null);
        if (!scriptFile) fail(usage);
        if (!fs.existsSync(scriptFile)) fail(`No video script ${shown(config, scriptFile)}: ${CLI} video script ${suite ?? '<suite>'} writes one, then its narration.`);
        const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
        const lang = script.language ?? config.browser.locale;
        const dir = path.join(path.dirname(scriptFile), script.suite ?? suite ?? path.basename(scriptFile, '.json'));
        const todo = [...Object.entries(script.cards ?? {}), ...Object.entries(script.steps ?? {})]
          .filter(([, entry]) => entry?.narration?.trim() && (!entry.audio || flag('--force')))
          .map(([key, entry]) => ({ entry, text: entry.narration.trim(), out: path.join(dir, `${key.replace(/[^\w.-]+/g, '-')}${AUDIO_EXT}`) }));
        if (!todo.length) return console.log('Every narration has its audio already (--force: speak them again).');
        const voice = speakAll(todo, { voice: value('--voice'), lang });
        for (const item of todo) item.entry.audio = path.relative(path.dirname(scriptFile), item.out).split(path.sep).join('/');
        fs.writeFileSync(scriptFile, `${JSON.stringify(script, null, 2)}\n`);
        console.log(`${todo.length} narrations spoken by ${voice.name}${voice.lang ? ` (${voice.lang})` : ''} into ${shown(config, dir)}; the script names them.`);
        if (lang && voice.lang && voice.lang.split('-')[0].toLowerCase() !== lang.split('-')[0].toLowerCase()) {
          console.log(`No voice of this system speaks ${lang}: ${voice.name} did. ${CLI} video voices --list shows them; --voice <name> picks one.`);
        }
        return;
      }

      if (sub === 'script') {
        const suite = rest[1];
        if (!suite || !fs.existsSync(path.join(P.suites, `${suite}.md`))) fail(`Usage: ${CLI} video script <suite> [--force]  (a suite in ${shown(config, P.suites)})`);
        const file = path.join(P.videos, `${suite}.json`);
        if (fs.existsSync(file) && !flag('--force')) fail(`${shown(config, file)} exists already (--force to start it again).`);
        const { starterScript } = await import('./video/script.mjs');
        fs.mkdirSync(P.videos, { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(starterScript(config, suite), null, 2)}\n`);
        console.log(`${shown(config, file)}: every test and step of ${suite}, in the suite's words, no narration yet.`);
        return;
      }

      const report = (r) => {
        console.log(`\nVideo: ${r.out}`);
        console.log(`Contact sheet: ${r.sheet}`);
        console.log(`Poster (its first frame): ${r.poster}`);
        console.log('  Look at it before showing the video: the cursor on each control, each step ending on its result.');
        if (r.clips.length) console.log(`Clips: ${path.dirname(r.clips[0])}`);
        const to = option('--out');
        if (to) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(r.out, to);
          console.log(`Copied to ${to}`);
        }
      };

      if (sub === 'render') {
        const named = rest[1] && !rest[1].startsWith('--') ? rest[1] : 'latest';
        let dir;
        if (named === 'latest') {
          const all = fs.existsSync(videosOut)
            ? fs
                .readdirSync(videosOut)
                .filter((d) => fs.existsSync(path.join(videosOut, d, 'capture.json')))
                .sort((a, b) => fs.statSync(path.join(videosOut, a, 'capture.json')).mtimeMs - fs.statSync(path.join(videosOut, b, 'capture.json')).mtimeMs)
            : [];
          if (!all.length) fail(`No capture in ${shown(config, videosOut)}: ${CLI} video <suite> makes one.`);
          dir = path.join(videosOut, all.at(-1));
        } else {
          dir = fs.existsSync(path.join(named, 'capture.json')) ? path.resolve(named) : path.join(videosOut, named);
          if (!fs.existsSync(path.join(dir, 'capture.json'))) fail(`No capture «${named}» in ${shown(config, videosOut)}.`);
        }
        report(
          await renderVideo(config, dir, {
            script: option('--script'),
            clips: flag('--clips'),
            mode: flag('--motion') ? 'motion' : flag('--guide') ? 'guide' : undefined,
          }),
        );
        return;
      }

      // A new video: the suite played again, captured, then drawn.
      const suite = sub;
      if (IN_DOCKER) fail('A video is captured on this machine: run it without --in-docker.');
      const file = recordingOf(config, suite);
      if (!file) fail(`No recording for the suite "${suite}" in ${P.recordings}`);
      const verdict = decide(config, suite);
      const why = verdict.why.replace(/\.+$/, '');
      if (verdict.verdict === 'ENV') fail(`ENV ${why}. A video replays the suite: the stack must be up (${CLI} up).`);
      if (verdict.verdict !== 'REPLAY') fail(`${verdict.verdict} ${why}. A video shows a recording that matches its suite: record it first.`);
      const ff = ffmpegStatus(config);
      if (!ff.ok) fail(`ffmpeg: ${ff.detail}`);
      const { readScript, readSuite, testsToRun } = await import('./video/script.mjs');
      const ownScript = path.join(P.videos, `${suite}.json`);
      const scriptFile = option('--script') ?? (fs.existsSync(ownScript) ? ownScript : null);
      const script = readScript(scriptFile);
      const mode = flag('--motion') ? 'motion' : flag('--guide') ? 'guide' : script.data.quality === 'motion' ? 'motion' : 'guide';
      const tests = Array.isArray(script.data.tests) && script.data.tests.length ? script.data.tests : null;
      // The tests it shows, and the ones played before them to build their
      // data (script.mjs, testsToRun): said wrong, refused before the stack
      // is touched.
      let played;
      try {
        played = testsToRun([...readSuite(config, suite).tests.keys()], tests, script.data.run ?? 'through');
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      if (scriptFile) console.log(`Video script: ${shown(config, scriptFile)}`);

      guard();
      await takeStack('replay', suite, ['video', ...rest].join(' '));
      // A video is a run like any other: fresh data, then the suite's setup.
      if (!flag('--no-reset')) {
        if (config.stack.reset) await commands.reset();
        else console.log(`The stack "${STACK}" has no \`reset\`: the setup runs on the data it has.`);
        if (setupOf(config, suite)) await commands.setup();
      }
      fs.mkdirSync(P.state, { recursive: true });
      if (P.sessionsSetup && !sessionsFresh(config.sessions.freshFor)) await playwright(['test', testFileArg(P.sessionsSetup)]);

      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const dir = path.join(videosOut, `${suite}-${mode}-${stamp}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'capture.json'),
        `${JSON.stringify({ suite, mode, startedAt: new Date().toISOString(), script: scriptFile, tests, played }, null, 2)}\n`,
      );
      const before = played && tests ? played.filter((id) => !tests.includes(id)) : [];
      console.log(
        `Capturing ${suite} (${mode})${tests ? `, showing ${tests.join(', ')}` : ''}` +
          `${before.length ? `; ${before.join(', ')} played first, uncaptured, to build its data` : ''} in ${shown(config, dir)}`,
      );
      // A red run makes no video: playwright() ends this process with its code.
      process.once('exit', (code) => {
        if (code) console.error('No video: the run must be green. Its capture stays, for a look.');
      });
      noteData(config, { state: 'spent', suite });
      process.env.QA_VIDEO_DIR = dir;
      process.env.QA_VIDEO_MODE = mode;
      // Only the tests it shows are captured (video/capture.mjs).
      if (tests) process.env.QA_VIDEO_TESTS = tests.join(',');
      const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const grep = played ? ['-g', `(${played.map(escapeRe).join('|')}) · `] : [];
      await playwright(['test', testFileArg(file), ...grep]);
      delete process.env.QA_VIDEO_DIR;
      delete process.env.QA_VIDEO_MODE;
      delete process.env.QA_VIDEO_TESTS;

      report(await renderVideo(config, dir, { script: scriptFile, clips: flag('--clips'), mode }));
      // The newest few captures of a suite stay, to draw again with another script.
      const keep = Math.max(1, config.video.keep);
      const old = fs
        .readdirSync(videosOut)
        .filter((d) => d.startsWith(`${suite}-`) && fs.existsSync(path.join(videosOut, d, 'capture.json')))
        .sort((a, b) => fs.statSync(path.join(videosOut, a, 'capture.json')).mtimeMs - fs.statSync(path.join(videosOut, b, 'capture.json')).mtimeMs);
      for (const d of old.slice(0, Math.max(0, old.length - keep))) fs.rmSync(path.join(videosOut, d), { recursive: true, force: true });
    },

    // «Play as …» from the terminal: a new browser window signed in as one
    // person, from their saved session (open-browser.mjs).
    async open() {
      const person = rest[0];
      if (!person) fail(`Usage: ${CLI} open <person>`);
      guard();
      ensureReady();
      spawnSync(process.execPath, [path.join(HERE, 'open-browser.mjs'), person], {
        cwd: P.project,
        stdio: 'inherit',
        env: { ...process.env, QA_COCKPIT_CONFIG: config.file, FRONTEND_URL: config.stack.urls().app },
      });
    },

    // What to do with a suite: REPLAY, GENERATE <why> or ENV <why>.
    async decide() {
      const suite = rest[0];
      if (!suite) fail(`Usage: ${CLI} decide <suite>`);
      const { verdict, why } = decide(config, suite);
      console.log(verdict === 'REPLAY' ? verdict : `${verdict} ${why}`);
      if (verdict === 'ENV') process.exit(2);
    },

    // The first line a recording of the suite must carry.
    async hash() {
      const suite = rest[0];
      if (!suite) fail(`Usage: ${CLI} hash <suite>`);
      console.log(suiteHeader(config, suite));
    },

    // Write the current header into the recording's first line: what the
    // director does after recording, and the healer after repairing a screen.
    async stamp() {
      const suite = rest[0];
      if (!suite) fail(`Usage: ${CLI} stamp <suite>`);
      const file = recordingOf(config, suite);
      if (!file) fail(`No recording for the suite "${suite}": ${newRecordingPath(config, suite)}`);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const header = suiteHeader(config, suite);
      if (/^\/\/ suite: /.test(lines[0])) lines[0] = header;
      else lines.unshift(header);
      fs.writeFileSync(file, lines.join('\n'));
      console.log(header);
    },

    // A row in the suite's runs table.
    async pass() {
      const [suite, who, result, ...notes] = rest;
      if (!suite || !who || !result) fail(`Usage: ${CLI} pass <suite> <who> <result> <notes...>`);
      console.log(recordPass(config, suite, { who, result, notes: notes.join(' ') }));
    },

    // The suites, and what each needs next.
    async suites() {
      const all = listSuites(config);
      if (!all.length) return console.log(`No suites in ${shown(config, P.suites)}.`);
      for (const s of all) console.log(`${s.status.padEnd(10)} ${s.name}  ${s.tests} tests · ${s.cast.join(', ') || 'no cast'}`);
    },

    // The notes pinned on a run's photos in the cockpit (notes.mjs), as
    // Markdown for the agent that acts on them: the newest run with notes,
    // or the one named. `--list`: every run that has some.
    async notes() {
      const { notesMarkdown, readNotes, readRunFiles, runsWithNotes } = await import('./notes.mjs');
      const cockpitDir = path.join(P.out, 'cockpit');
      const noted = runsWithNotes(cockpitDir);
      if (rest.includes('--list')) {
        if (!noted.length) return console.log('No run has notes.');
        for (const id of noted) console.log(`${id}  ${readNotes(path.join(cockpitDir, id)).filter((n) => n.text.trim()).length} notes`);
        return;
      }
      const id = rest.find((a) => !a.startsWith('--')) ?? noted[0];
      if (!id) return console.log('No run has notes. They are pinned on the photos, in the cockpit.');
      const dir = path.join(cockpitDir, id);
      if (path.dirname(dir) !== cockpitDir || !fs.existsSync(path.join(dir, 'run.json'))) fail(`No run "${id}" in ${shown(config, cockpitDir)}.`);
      const { meta, frames } = readRunFiles(dir);
      const md = notesMarkdown({
        runId: id,
        dir,
        frames,
        notes: readNotes(dir),
        out: shown(config, P.out),
        project: shown(config, P.project),
      });
      if (!md) return console.log(`The run ${id} has no notes.`);
      console.log(
        [
          `# Notes on the run ${id}`,
          '',
          `- Suite: \`${shown(config, P.suites)}/${meta.suite}.md\`; ${meta.status}, started ${meta.startedAt}`,
          `- The whole run, step by step: the cockpit's «Report» on this run`,
          '',
          md,
        ].join('\n'),
      );
    },

    // .mcp.json at the repo root: one Playwright MCP server per saved
    // session, for an agent that drives a person's browser by hand.
    // Generated, not committed: it must not prompt every developer who opens
    // the repo. A new agent session picks it up.
    async mcp() {
      const people = config.people.filter((id) => fs.existsSync(path.join(P.state, `${id}.json`)));
      if (people.length === 0) fail(`No saved sessions: run ${CLI} setup <suite> first.`);
      const win = process.platform === 'win32';
      const servers = {};
      for (const id of people) {
        const mcpArgs = [
          '@playwright/mcp@latest',
          '--isolated',
          '--storage-state', path.join(P.state, `${id}.json`),
          '--caps=testing',
          '--output-dir', path.join(P.out, 'mcp', id),
        ];
        servers[`playwright-${id}`] = win ? { command: 'cmd', args: ['/c', 'npx', ...mcpArgs] } : { command: 'npx', args: mcpArgs };
      }
      const file = path.join(P.root, '.mcp.json');
      fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
      console.log(`${file}: ${people.map((p) => `playwright-${p}`).join(', ')}`);
      console.log(`Saved sessions may go stale; run \`${CLI} sessions\` before driving them.`);
    },

    // What this machine and this config have and lack, healing what can be
    // healed (dependencies, browser) and saying what cannot.
    async doctor() {
      let bad = 0;
      const line = (ok, what, detail) => {
        if (!ok) bad += 1;
        console.log(`${ok ? ' ok ' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`);
      };
      const major = Number(process.versions.node.split('.')[0]);
      line(major >= 20, 'Node', `${process.version}${major >= 20 ? '' : ' (20 or newer needed)'}`);
      line(true, 'Config', shown(config, config.file));
      // This machine's own values (env.mjs): read by the config, or there
      // and ignored because the config does not call loadEnv.
      {
        const { loadedEnvs } = await import('./env.mjs');
        const beside = path.join(P.project, '.env');
        const read = loadedEnvs().find((e) => e.file === beside);
        const there = fs.existsSync(beside);
        if (read && there) {
          const keys = Object.keys(read.values);
          const own = keys.filter((k) => !read.applied.includes(k));
          line(
            true,
            'Env',
            `${shown(config, beside)}: ${keys.length ? keys.join(', ') : 'empty'}${own.length ? ` (the environment's own: ${own.join(', ')})` : ''}`,
          );
        } else if (there) {
          line(false, 'Env', `${shown(config, beside)} is there, but the config does not read it: loadEnv(import.meta.url) at its top`);
        } else {
          line(true, 'Env', `no .env beside the config: its defaults${fs.existsSync(path.join(P.project, '.env.example')) ? ' (.env.example lists what one may set)' : ''}`);
        }
      }
      line(config.cast.length > 0, 'Cast', config.cast.length ? config.people.join(', ') : 'nobody: add people to `cast`');
      line(typeof config.signIn === 'function', 'signIn', typeof config.signIn === 'function' ? 'defined' : 'missing: nobody can be signed in');
      line(fs.existsSync(P.suites), 'Suites', shown(config, P.suites));
      const suites = fs.existsSync(P.suites) ? listSuites(config) : [];
      line(true, 'Suites found', suites.length ? `${suites.length} (${suites.map((s) => `${s.name}: ${s.status}`).join(', ')})` : 'none yet');
      if (P.skill) line(fs.existsSync(P.skill), 'Skill', shown(config, P.skill));
      for (const [what, ok, detail] of (await config.stack.doctor?.(ctx)) ?? []) line(ok, what, detail);
      const docker = Boolean(config.stack.compose);
      let dockerUp = false;
      if (docker) {
        const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}} · {{.OperatingSystem}}'], {
          encoding: 'utf8',
          windowsHide: true,
        });
        dockerUp = info.status === 0;
        line(dockerUp, 'Docker', dockerUp ? info.stdout.trim() : 'no daemon answers (is Docker running?)');
      }
      const stale = checkDepsStale();
      if (stale) healDeps(stale);
      const pm = packageManager(config);
      const lock = pm.lockfile ? shown(config, pm.lockfile) : 'no lockfile';
      line(true, 'Dependencies', `${pm.name}, ${stale ? `installed now (${stale})` : `match ${lock}`}`);
      const had = chromiumInstalled();
      if (!had) healChromium();
      line(true, 'Chromium', had ? 'installed' : 'installed now');
      if (dockerUp) {
        const { runnerImage } = await import('./docker/runner.mjs');
        try {
          const image = runnerImage(config);
          const present = spawnSync('docker', ['image', 'inspect', image], { windowsHide: true }).status === 0;
          line(true, 'Runner image', `${image}${present ? '' : ' (pulled on the first --in-docker run)'}`);
        } catch (err) {
          line(true, 'Runner image', `none: ${err.message}`);
        }
      }
      try {
        const urls = config.stack.urls();
        line(true, 'Stack', where(urls));
      } catch {
        const planned = config.stack.planned?.();
        line(false, 'Stack', `down (${CLI} up)${planned ? `; it will answer on ${where(planned)}` : ''}`);
      }
      if (bad) process.exitCode = 1;
    },

    // The cockpit (server/server.mjs). Launch it from a terminal on your own
    // desktop and keep it open: what it opens with a window appears on the
    // desktop of whoever started it (an agent's terminal may be hidden).
    async cockpit() {
      const i = rest.indexOf('--port');
      const port = i !== -1 ? Number(rest[i + 1]) : config.cockpit.port;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        fail(`Usage: ${CLI} cockpit [--port <1024-65535>] [--no-open] [--detach | --restart]`);
      }
      // For a person, from anywhere: an agent asked to open the cockpit runs
      // this, and the cockpit outlives the agent's session (detach.mjs).
      if (rest.includes('--detach') || rest.includes('--restart')) {
        const { detachCockpit } = await import('./detach.mjs');
        return detachCockpit({
          config,
          port,
          entry: process.argv[1],
          args: rest.filter((a) => a !== '--detach' && a !== '--restart'),
          restart: rest.includes('--restart'),
          open: !rest.includes('--no-open'),
          cwd: process.cwd(),
        });
      }
      ensureReady();
      const { startCockpit } = await import('./server/server.mjs');
      startCockpit(config, port);
      if (!rest.includes('--no-open')) {
        const url = `http://localhost:${port}`;
        if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true });
        else spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
      }
    },

    // Who holds the stack (lock.mjs), and a way out when a holder hangs.
    async lock() {
      const held = readLock(LOCK);
      console.log(
        held
          ? `In use: ${held.who} runs «${held.command}» since ${new Date(held.since).toLocaleString()} (pid ${held.pid}).`
          : 'The stack is free.',
      );
    },

    async unlock() {
      const was = breakLock(LOCK);
      console.log(was ? `Removed the lock of ${was.who} («${was.command}», pid ${was.pid}).` : 'There was no lock.');
    },

    async help() {
      const own = Object.entries(config.commands)
        .map(([name, c]) => `  ${(c.usage ?? name).padEnd(16)} ${c.help ?? ''}`)
        .join('\n');
      console.log(`${CLI} <command>

  up               start the stack (${STACK}) and wait until it answers
  down             stop it, keeping its data
  purge            stop it and remove its data
  status           where it answers, saved sessions
  reset            fresh data; saved sessions cleared
  suites           every suite and what it needs next
  setup <suite>    cast and initial state of a suite, sessions saved
  sessions         fresh saved sessions for everybody with an account
  smoke            the app loads and the API answers
  decide <suite>   REPLAY | GENERATE <why> | ENV <why>, from the recording's hash
  hash <suite>     the header line a recording of the suite must carry
  stamp <suite>    write that header into the recording's first line
  replay <suite>   fresh sessions, then the suite's recording (extra args go to Playwright)
  pass <suite> <who> <result> <notes...>   a row in the suite's runs table
  mcp              write .mcp.json with one Playwright MCP server per saved session
  open <person>    a browser window signed in as that person, to use by hand
  doctor           what this machine and this config have and lack; heals deps and browser
  cockpit          the cockpit on http://localhost:${config.cockpit.port} (--port <p>, --no-open);
                   launch it from a terminal on your own desktop and keep it open
                   --detach: started for a person, in a window of its own, outliving
                   whoever asked (what an agent runs); --restart: a fresh one
  notes [run]      the notes pinned on a run's photos in the cockpit, as Markdown
                   (the newest run with notes; --list: every run that has some)
  video <suite>    a demo video: reset, setup, the recording captured, then drawn with a
                   cursor, subtitles, cards and sound (--motion: real time, animations on;
                   --clips: each step as it played, for an editor; --script <file>)
  video render [<capture>|latest]   draw a capture again (a new script, new narration)
  video script <suite>              a first video script from the suite
  video voices <suite>              its narration spoken by this system's own voice (--list)
  video check      what a video needs from this machine (ffmpeg, Chromium)
  lock             who holds the stack: one run at a time (QA_WHO names you)
  unlock           remove the lock by hand, when its holder hangs
${own ? `\n${own}\n` : ''}
  --in-docker      (setup, sessions, smoke, replay) Playwright in the official image
`);
    },
  };

  const builtin = commands[command];
  const own = config.commands[command];
  if (!builtin && !own) {
    console.error(`Unknown command "${command}".\n`);
    await commands.help();
    process.exit(1);
  }
  try {
    if (builtin) await builtin();
    else await own.run({ ...ctx, args: rest, guard });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
