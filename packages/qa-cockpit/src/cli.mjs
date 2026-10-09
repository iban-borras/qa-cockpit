// The CLI: `npx qa-cockpit <command> [args]` (or the project's own wrapper).
// The skill says when to run what; this file only knows how. Everything
// about the app under test comes from the project's config (config.mjs):
// how its stack starts, resets and signs a person in.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newRecordingPath, recordingOf, resolveConfig, setupOf, shown } from './config.mjs';
import { depsStale, installDeps, packageManager, playwrightCli as playwrightCliOf } from './deps.mjs';
import { acquireLock, breakLock, lockFileOf, readLock, StackBusy } from './lock.mjs';
import { noteData, readData, staleFor, staleLine } from './stackdata.mjs';
import { decide, listSuites, recordPass, suiteHeader } from './suites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

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
    if (report) return;
    // A cockpit started before the package was updated runs the old code,
    // and what this run sends it, it may read wrong (one at 0.4.0 dropped
    // every click of 0.7.0's photos). It is not handed the run, and the
    // terminal is told why; the cockpit's own run says so in its log.
    const at = process.env.COCKPIT_URL || COCKPIT;
    const theirs = await fetch(`${at}/api/state`, { signal: AbortSignal.timeout(1_500) })
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => (st ? (st.version ?? 'older than 0.3.0') : null))
      .catch(() => null);
    if (theirs && theirs !== VERSION) {
      const restart = `The cockpit at ${at} runs QA Cockpit ${theirs}, and this is ${VERSION}: restart it (${CLI} cockpit --restart).`;
      console.log(process.env.COCKPIT_RUN ? `${restart} This run may reach it in part.` : `${restart} Until then it does not follow this run.`);
      if (!process.env.COCKPIT_RUN) return;
    }
    if (process.env.COCKPIT_RUN) return;
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
    clearTimeout(report.timer);
    report.timer = null;
    const lines = report.lines.splice(0);
    if (!lines.length) return Promise.resolve();
    return fetch(`${COCKPIT}/api/external/log`, {
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

  /** The suite this command runs, for the device its sessions are signed in
   *  on, and the fixtures' note of it (devices.mjs); one id per command. */
  function runsSuite(suite) {
    process.env.QA_SUITE = suite;
    process.env.QA_RUN_ID = `${Date.now().toString(36)}-${process.pid}`;
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
  // container instead. A red run ends this process with its code; with
  // `exit: false`, the code is returned (a round of `replay --chaos`).
  async function playwright(pwArgs, { exit = true } = {}) {
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
    if (code !== 0 && exit) process.exit(code);
    return code;
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

  // `replay --network` (network/): a folder for this run's HARs, the run's
  // own key for their placeholders (sanitize.mjs), and a word at the end on
  // where they are. The newest few of a suite stay, to measure a change
  // against.
  async function lookAtNetwork(suite, bodies) {
    const { networkRuns } = await import('./network/report.mjs');
    const root = path.join(P.out, 'network');
    const keep = Math.max(1, config.network.keep);
    for (const old of networkRuns(root).filter((r) => r.meta.suite === suite).slice(keep - 1)) {
      fs.rmSync(old.dir, { recursive: true, force: true });
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dir = path.join(root, `${suite}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
      suite,
      startedAt: new Date().toISOString(),
      command: ['replay', ...rest].join(' '),
      bodies,
      urls: config.stack.urls(),
      // Its traces and photos slow a run a little: runs compare best with
      // runs made the same way.
      cockpit: Boolean(process.env.COCKPIT_URL),
    };
    const write = () => fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
    write();
    process.env.QA_NETWORK_DIR = dir;
    process.env.QA_NETWORK_SALT = randomBytes(16).toString('hex');
    if (bodies) process.env.QA_NETWORK_BODIES = '1';
    // A red run ends this process from playwright(): what it reached is kept.
    process.once('exit', (code) => {
      meta.status = code ? 'failed' : 'passed';
      meta.endedAt = new Date().toISOString();
      try {
        write();
      } catch {
        // The HARs are there all the same.
      }
      console.log(`\nIts network, without secrets: ${shown(config, dir)}`);
      console.log(`  ${CLI} network: what it found${code ? ' (the run failed: what it reached is there)' : ''}`);
    });
  }

  // `replay --a11y` (a11y.mjs): each step's screen looked at as the cockpit
  // photographs it, so only with the cockpit following the run. At the end,
  // every problem found, each where it first showed: what an agent reads
  // here, and a person on the photos, as boxes.
  function lookAtA11y() {
    const run = process.env.COCKPIT_RUN;
    if (!process.env.COCKPIT_URL || !run) {
      console.log(`--a11y looks at each step's screen as the cockpit photographs it, and no cockpit follows this run: start one first (${CLI} cockpit).`);
      return;
    }
    process.env.QA_A11Y = '1';
    const said = {
      name: (x) => `a ${x.role} with no name`,
      label: (x) => `a field with no label (${x.role})`,
      alt: () => 'an image with no text alternative',
      keyboard: (x) => `a ${x.role} the keyboard cannot reach${x.name ? ` («${x.name}»)` : ''}`,
    };
    // «T3/2 alice»: the test's id and the step's number, as the suite has them.
    const where = (f) => {
      const test = /^(\S+)\s+·/.exec(f.test)?.[1];
      const step = /^(\d+)\s+·/.exec(f.step)?.[1];
      return test && step ? `${test}/${step} ${f.actor}` : `${f.step} (${f.actor})`;
    };
    process.once('exit', () => {
      let frames;
      try {
        frames = fs
          .readFileSync(path.join(P.out, 'cockpit', run, 'frames.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return;
      }
      const seen = new Set();
      const found = [];
      for (const f of frames) {
        for (const x of f.findings ?? []) {
          const key = `${x.rule}|${x.role}|${x.name}|${x.what}`;
          if (x.kind !== 'a11y' || seen.has(key)) continue;
          seen.add(key);
          found.push(`  ${where(f)}  ${(said[x.rule] ?? (() => x.rule))(x)}: ${x.what}`);
        }
      }
      if (!found.length) return console.log('\nAccessibility: nothing found on the screens photographed.');
      console.log(`\nAccessibility: ${found.length} problem${found.length === 1 ? '' : 's'}, each where it first showed (the cockpit draws them on its photos):`);
      for (const line of found) console.log(line);
    });
  }

  // `replay --languages` (languages.mjs): each step's screen in the app's
  // other languages too, changed by what the config says, so only with the
  // cockpit following the run. At the end, what did not fit in them, the
  // steps whose language could not be changed, and whether it stopped.
  function lookInLanguagesToo(langs) {
    const run = process.env.COCKPIT_RUN;
    if (!process.env.COCKPIT_URL || !run) {
      console.log(`--languages looks at each step's screen as the cockpit photographs it, and no cockpit follows this run: start one first (${CLI} cockpit).`);
      return;
    }
    const { base } = config.languages;
    process.env.QA_LANGUAGES = langs.join(',');
    const said = {
      cut: (x) => `a text that does not fit its box («${x.text}»)`,
      wide: () => 'the page wider than the window',
      key: (x) => `a translation key left on the screen («${x.text}»)`,
    };
    const where = (f) => {
      const test = /^(\S+)\s+·/.exec(f.test)?.[1];
      const step = /^(\d+)\s+·/.exec(f.step)?.[1];
      return test && step ? `${test}/${step} ${f.actor}` : `${f.step} (${f.actor})`;
    };
    process.once('exit', () => {
      let frames;
      try {
        frames = fs
          .readFileSync(path.join(P.out, 'cockpit', run, 'frames.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return;
      }
      const found = [];
      const skipped = [];
      let stopped = null;
      let looked = 0;
      for (const f of frames) {
        for (const x of (f.findings ?? []).filter((y) => y.kind === 'lang')) found.push(`  ${where(f)}  ${x.lang}: ${said[x.rule](x)}`);
        for (const s of f.langs ?? []) {
          looked += 1;
          for (const x of s.findings ?? []) found.push(`  ${where(f)}  ${x.lang}: ${said[x.rule](x)}`);
        }
        if (f.langsSkipped) skipped.push(`  ${where(f)}  ${f.langsSkipped}`);
        if (f.langsStopped) stopped ??= `  Stopped after ${where(f)}: ${f.langsStopped}. The rest of the run played in ${base} only.`;
      }
      console.log(`\nLanguages (${base}, and ${langs.join(', ')}): ${looked} screen${looked === 1 ? '' : 's'} looked at in another language.`);
      if (found.length) {
        console.log(`  ${found.length} thing${found.length === 1 ? '' : 's'} that do not fit, each where it first showed (the cockpit shows each language's photo):`);
        for (const line of found) console.log(line);
      } else if (looked) console.log('  Every text fits, in every language.');
      if (skipped.length) {
        console.log("  Steps not looked at in other languages, and why (the change failed, or the project's ready said not now):");
        for (const line of skipped) console.log(line);
      }
      if (stopped) console.log(stopped);
    });
  }

  // `replay --realtime` (realtime.mjs): how long what one person does takes
  // to reach another's screen, measured where the cockpit photographs each
  // step, so only with it following the run. At the end, each hand-off.
  function timeHandOffs() {
    const run = process.env.COCKPIT_RUN;
    if (!process.env.COCKPIT_URL || !run) {
      console.log(`--realtime measures each step as the cockpit photographs it, and no cockpit follows this run: start one first (${CLI} cockpit).`);
      return;
    }
    process.env.QA_REALTIME = '1';
    process.once('exit', () => {
      let frames;
      try {
        frames = fs
          .readFileSync(path.join(P.out, 'cockpit', run, 'frames.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return;
      }
      const lines = frames
        .filter((f) => f.realtime)
        .map((f) => {
          const h = f.realtime;
          const test = /^(\S+)\s+·/.exec(f.test)?.[1];
          const step = /^(\d+)\s+·/.exec(f.step)?.[1];
          const legs = [
            h.sent && `sent +${h.sent.ms} ms (${h.sent.what})`,
            h.received && `received +${h.received.ms} ms (${h.received.what})`,
            h.seen && `seen +${h.seen.ms} ms («${h.seen.text}»)`,
            h.live === false && `not live: no pushed message carried it${h.via ? `, it likely came with an answer (${h.via})` : ''}`,
          ].filter(Boolean);
          return `  ${test && step ? `${test}/${step}` : f.step} ${h.from} → ${f.actor}, from «${h.what}»: ${legs.join(', ')}`;
        });
      console.log(lines.length ? `\nReal time: ${lines.length} hand-off${lines.length === 1 ? '' : 's'} between people:` : '\nReal time: no hand-off between people in this run.');
      for (const line of lines) console.log(line);
    });
  }

  // ── races between people (`replay --chaos`, chaos.mjs) ──

  /** Each round from the same start, as a video's run: fresh data, then the suite's setup. Its code. */
  async function freshStart(suite) {
    if (config.stack.reset) await commands.reset();
    const setup = setupOf(config, suite);
    fs.mkdirSync(P.state, { recursive: true });
    if (!setup) return 0;
    noteData(config, { state: 'setting-up', suite });
    const code = await playwright(['test', testFileArg(setup)], { exit: false });
    if (!code) noteData(config, { state: 'setup', suite });
    return code;
  }

  /** The cast a recording names: the people its rounds slow. */
  function playersOf(file) {
    const text = fs.readFileSync(file, 'utf8');
    return config.people.filter((id) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  }

  const cockpitRun = () => (process.env.COCKPIT_URL && process.env.COCKPIT_RUN && process.env.COCKPIT_RUN !== 'adhoc' ? process.env.COCKPIT_RUN : null);

  /**
   * The cockpit told of a round (server.mjs): the first one names the run
   * it follows, each next one is a run of its own; the end, what they found.
   * The lines this process wrote go first, each to its own round's log.
   */
  const chaosToCockpit = (what, body) => toCockpit(`chaos/${what}`, body);

  async function toCockpit(route, body) {
    const run = cockpitRun();
    if (!run) return;
    if (report) await flushReport();
    // Twice at most: a run played while this process waited on it (the
    // cockpit's own runs wait without reading anything) leaves the
    // connection of the call before closed by the cockpit, and this one
    // finds it so (ECONNRESET). The second goes on a new one.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(`${process.env.COCKPIT_URL}/api/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ run, ...body }),
          signal: AbortSignal.timeout(5_000),
        });
        const answer = r.ok ? await r.json() : null;
        if (answer?.run) process.env.COCKPIT_RUN = answer.run;
        return;
      } catch {
        // Followed as one run, then, if the second fails too: the rounds
        // are no worse for it.
      }
    }
  }

  // ── a group of suites (`replay --tag`, tags.mjs) ──

  /** This CLI again, on the same config, through this process's own streams (the cockpit's log among them). Its code. */
  function again(cmdArgs) {
    const entry = fileURLToPath(new URL('../bin/qa-cockpit.mjs', import.meta.url));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [entry, ...cmdArgs], {
        cwd: P.project,
        env: { ...process.env, QA_COCKPIT_CONFIG: config.file },
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (d) => process.stdout.write(d));
      child.stderr.on('data', (d) => process.stderr.write(d));
      child.on('error', () => resolve(1));
      child.on('close', (c) => resolve(c ?? 1));
    });
  }

  /**
   * `replay --tag <tag>`: the tag's suites, in its order, each from fresh
   * data as a full run is (a reset, its setup, its recording) with the looks
   * asked for. Each is this CLI again, the stack's lock handed down
   * (QA_LOCK), so each has its own run in the cockpit, its looks' summary
   * and its comparison, as it would alone. The first suite that fails stops
   * the rest, to look at what broke, unless --keep-going (how far a problem
   * reaches). A suite that cannot play (no recording, a stale one, no
   * setup) is passed over, and said.
   */
  async function replayGroup(tag, args) {
    const { readTags } = await import('./tags.mjs');
    const usage = `Usage: ${CLI} replay --tag <tag> [--keep-going] [--a11y] [--languages [es,fr]] [--realtime] [--changes] [--network] [--in-docker]`;
    if (!tag || tag.startsWith('--')) fail(usage);
    if (args.some((a) => a.startsWith('--chaos'))) fail(`--chaos looks for races in one suite: ${CLI} replay <suite> --chaos.`);
    const keepGoing = args.includes('--keep-going');
    const looks = [...args.filter((a) => a !== '--keep-going'), ...(IN_DOCKER ? ['--in-docker'] : [])];
    const all = new Map(listSuites(config).map((s) => [s.name, s]));
    const { tags, problems } = readTags(config, new Set(all.keys()));
    const group = tags.find((x) => x.name === tag);
    if (!group) fail(`No tag «${tag}»${problems.length ? ` (${problems[0]})` : ''}: ${CLI} tags lists them.`);
    const plan = group.suites.map((name) => {
      const s = all.get(name);
      const why = !s ? 'missing' : !s.recorded ? 'unrecorded' : s.status === 'stale' ? 'stale' : !s.setup ? 'nosetup' : null;
      return { suite: name, why };
    });
    const said = { missing: 'no such suite', unrecorded: 'not recorded', stale: 'its recording is stale', nosetup: 'no setup' };
    const playing = plan.filter((p) => !p.why);
    if (!playing.length) fail(`No suite of «${tag}» can play: ${plan.map((p) => `${p.suite} (${said[p.why]})`).join(', ') || 'it has none'}.`);
    // In the container, what would stop every suite is said once, first.
    if (IN_DOCKER) {
      try {
        (await import('./docker/runner.mjs')).dockerReady(config);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    }
    guard();
    await takeStack('full', playing[0].suite, ['replay', '--tag', tag, ...args].join(' '));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const id = `${tag}-${stamp}`;
    const startedAt = new Date().toISOString();
    const count = playing.length < plan.length ? `${playing.length} of its ${plan.length} suites` : plan.length === 1 ? 'its one suite' : `its ${plan.length} suites, one after another`;
    console.log(`The group «${tag}»: ${count}, ${plan.length === 1 ? 'from' : 'each from'} fresh data${keepGoing || plan.length === 1 ? '' : '; the first that fails stops the rest'}.`);
    const results = [];
    let previous = null;
    let stopped = null;
    for (const [i, p] of plan.entries()) {
      if (p.why) {
        results.push({ suite: p.suite, status: 'skipped', why: p.why });
        console.log(`\n── ${i + 1}/${plan.length} · ${p.suite}: passed over (${said[p.why]})`);
        continue;
      }
      if (stopped) {
        results.push({ suite: p.suite, status: 'not-run' });
        continue;
      }
      console.log(`\n── ${i + 1}/${plan.length} · ${p.suite}`);
      await toCockpit('group/next', { previous, suite: p.suite, group: { id, tag, index: i + 1, of: plan.length } });
      let code = 0;
      for (const cmd of [config.stack.reset ? ['reset'] : null, ['setup', p.suite, ...(IN_DOCKER ? ['--in-docker'] : [])], ['replay', p.suite, ...looks]].filter(Boolean)) {
        code = await again(cmd);
        if (code) break;
      }
      previous = code ? 'failed' : 'passed';
      results.push({ suite: p.suite, status: previous, run: cockpitRun() });
      if (code && !keepGoing) stopped = p.suite;
    }
    const failed = results.filter((r) => r.status === 'failed');
    console.log(`\nThe group «${tag}»: ${results.filter((r) => r.status === 'passed').length} green, ${failed.length} red, of ${plan.length}.`);
    for (const r of results) {
      const what = { passed: 'green', failed: 'red', skipped: `passed over: ${said[r.why]}`, 'not-run': 'not played' }[r.status];
      console.log(`  ${r.suite.padEnd(Math.max(...results.map((x) => x.suite.length)))}  ${what}`);
    }
    if (stopped) console.log(`Stopped at «${stopped}», the first that failed: look at it, and play the group again once it is fixed (--keep-going plays every one).`);
    fs.mkdirSync(path.join(P.out, 'groups'), { recursive: true });
    fs.writeFileSync(path.join(P.out, 'groups', `${id}.json`), `${JSON.stringify({ tag, id, startedAt, endedAt: new Date().toISOString(), keepGoing, stopped, results }, null, 2)}\n`);
    await toCockpit('group/end', { status: previous, found: { tag, keepGoing, stopped, results } });
    if (failed.length) process.exitCode = 1;
  }

  /** «T1/3 · Bob: sees it arrive», as the summaries name a step. */
  const stepName = (test, step) => {
    const id = /^(\S+)\s+·/.exec(test)?.[1];
    return id ? `${id}/${step}` : `${test} › ${step}`;
  };

  /**
   * `replay <suite> --chaos N`: the recording played N times, each round
   * from fresh data with each person slowed as its seed says, then compared
   * step by step. A step that passes in some rounds and fails in others is
   * a race; the seed of a round it failed in plays that round again. Each
   * round's log, and what they found, stay in <out>/chaos/.
   */
  async function searchRaces(suite, file, pwArgs, n) {
    const { foundIn, pickSeeds, profileOf, profileText, readRound } = await import('./chaos.mjs');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dir = path.join(P.out, 'chaos', `${suite}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = new Date().toISOString();
    const group = path.basename(dir);
    // Round 0 as it is, nobody slowed: what every other round is compared
    // with. If it fails, the suite fails with no slowness at all, and there
    // is no race to look for until it passes.
    const seeds = [null, ...pickSeeds(n)];
    const people = playersOf(file);
    console.log(`Looking for races in ${suite}: round 0 as it is, then ${n} rounds, each from fresh data, each person slowed as its seed says.`);
    if (!config.stack.reset) console.log(`The stack "${STACK}" has no \`reset\`: each round plays on the data the one before left, and a step that fails only then may be the data, not a race.`);
    const rounds = [];
    let previous = null;
    let stopped = null;
    for (const [round, seed] of seeds.entries()) {
      const profiles = seed === null ? {} : Object.fromEntries(people.map((id) => [id, profileOf(seed, id)]));
      if (seed === null) console.log(`\n── Round 0 of ${n}, as it is (nobody slowed)`);
      else {
        console.log(`\n── Round ${round} of ${n}, seed ${seed}`);
        for (const id of people) console.log(`   ${id}: ${profileText(profiles[id])}`);
      }
      await chaosToCockpit('round', { previous, chaos: { group, round, of: n, seed, people: profiles } });
      runsSuite(suite);
      let code = await freshStart(suite);
      if (!code && P.sessionsSetup && !sessionsFresh(config.sessions.freshFor)) code = await playwright(['test', testFileArg(P.sessionsSetup)], { exit: false });
      if (code) {
        stopped = round;
        previous = 'failed';
        console.log(`\nRound ${round}: the setup failed (above), so the search stops here: rounds compare only from the same start.`);
        break;
      }
      noteData(config, { state: 'spent', suite });
      const log = path.join(dir, `round-${round}.jsonl`);
      if (seed !== null) process.env.QA_CHAOS = String(seed);
      process.env.QA_CHAOS_LOG = log;
      code = await playwright(['test', testFileArg(file), ...pwArgs], { exit: false });
      delete process.env.QA_CHAOS;
      delete process.env.QA_CHAOS_LOG;
      const seen = readRound(log);
      previous = code ? 'failed' : 'passed';
      rounds.push({ round, seed, status: previous, run: cockpitRun(), people: Object.keys(seen.people).length ? seen.people : profiles, steps: seen.steps, tests: seen.tests });
      console.log(`\nRound ${round} of ${n}${seed === null ? ', as it is' : `, seed ${seed}`}: ${previous}.`);
      if (seed === null && code) {
        stopped = 0;
        console.log('Round 0, with nobody slowed, failed: the suite fails as it is (above), and no race can be told from that. The search stops here.');
        break;
      }
    }
    // Each round compared with round 0 (changes.mjs), with the cockpit:
    // a round that passed and still changed is a near miss (a message
    // twice, a call more, an error in the console).
    const changes = [];
    const zero = rounds.find((r) => r.round === 0 && r.status === 'passed' && r.run);
    if (zero && rounds.length > 1) {
      const { compareRuns } = await import('./changes.mjs');
      console.log('\nComparing each round with round 0…');
      for (const r of rounds.filter((x) => x.round > 0 && x.run)) {
        try {
          const c = await compareRuns({ config, root: path.join(P.out, 'cockpit'), run: r.run, against: zero.run });
          changes.push({ round: r.round, seed: r.seed, ...c.summary, steps: c.steps.filter((x) => x.kind !== 'same').map((x) => ({ test: x.test, step: x.step, actor: x.actor, kind: x.kind })) });
        } catch (e) {
          console.log(`  Round ${r.round}: not compared (${e instanceof Error ? e.message.split('\n')[0] : e}).`);
        }
      }
    }
    const found = { ...foundIn(rounds), of: n, stopped, changes };
    fs.writeFileSync(path.join(dir, 'found.json'), `${JSON.stringify({ suite, startedAt, endedAt: new Date().toISOString(), command: ['replay', ...rest].join(' '), ...found }, null, 2)}\n`);
    printRaces(suite, found, profileText);
    console.log(`\nEach round's log, and what they found: ${shown(config, dir)}`);
    await chaosToCockpit('end', { status: previous, found });
    if (stopped !== null || rounds.some((r) => r.status === 'failed')) process.exitCode = 1;
  }

  /**
   * `replay --changes`: this run compared with an earlier green one, once it
   * ended (changes.mjs), and the cockpit told, which shows it on its photos.
   */
  async function lookForChanges(run, explicit) {
    const root = path.join(P.out, 'cockpit');
    const { baselineOf, changesLines, compareRuns } = await import('./changes.mjs');
    const against = explicit ?? baselineOf(root, run);
    if (!against) {
      console.log('\nChanges: no green run of this suite before this one to compare it with. The next one is compared with this, if it is green.');
      return;
    }
    let c;
    try {
      c = await compareRuns({ config, root, run, against });
    } catch (e) {
      console.log(`\nChanges: not compared (${e instanceof Error ? e.message.split('\n')[0] : e}).`);
      return;
    }
    const { readRunFiles } = await import('./notes.mjs');
    const files = new Map(readRunFiles(path.join(root, run)).frames.map((f) => [f.seq, f.file]));
    console.log('');
    for (const line of changesLines(c, (seq) => (files.get(seq) ? shown(config, path.join(P.out, files.get(seq))) : `#${seq}`))) console.log(line);
    await fetch(`${process.env.COCKPIT_URL}/api/changes/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run }),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
  }

  /** What the rounds found, for a person and for an agent. */
  function printRaces(suite, found, profileText) {
    const failed = found.rounds.filter((r) => r.status === 'failed');
    const played = found.rounds.filter((r) => r.round > 0).length;
    console.log(`\nRaces in ${suite}: round 0 and ${played} round${played === 1 ? '' : 's'}${found.stopped !== null ? ` of ${found.of}` : ''}, ${failed.length ? `${failed.length} failed` : 'every one passed'}.`);
    const slowed = (r) =>
      Object.entries(r?.people ?? {})
        .map(([id, p]) => `${id} ${profileText(p)}`)
        .join('; ');
    const roundOf = (n) => found.rounds.find((r) => r.round === n);
    if (found.unstable.length) {
      console.log('  Steps that pass in some rounds and fail in others (a race: the order things came in mattered):');
      for (const x of found.unstable) {
        console.log(`  ${stepName(x.test, x.step)}`);
        console.log(`     failed in round${x.failed.length === 1 ? '' : 's'} ${x.failed.map((f) => `${f.round} (seed ${f.seed})`).join(', ')}; passed in ${x.passed.join(', ')}`);
        for (const f of x.failed) console.log(`     seed ${f.seed}: ${slowed(roundOf(f.round))}${f.error ? `\n       ${f.error}` : ''}`);
      }
      const first = found.unstable[0].failed[0];
      console.log(`  That round again, the same start and the same slowness: ${CLI} replay ${suite} --chaos-seed ${first.seed}`);
    }
    if (found.always.length) {
      console.log('  Steps that failed in every round that reached them (not a race: the app, the recording, or a slowness it cannot take):');
      for (const x of found.always) console.log(`  ${stepName(x.test, x.step)}${x.failed[0].error ? `\n       ${x.failed[0].error}` : ''}`);
    }
    for (const r of found.outside) {
      console.log(`  Round ${r.round} (seed ${r.seed}) failed outside its steps${r.tests.length ? `: ${r.tests.map((t) => `${t.test}${t.error ? ` (${t.error})` : ''}`).join('; ')}` : ''}.`);
    }
    // Passed, and still not as round 0: worth a look.
    for (const c of found.changes ?? []) {
      if (!c.changed && !c.new && !c.gone) continue;
      const r = found.rounds.find((x) => x.round === c.round);
      if (r?.status !== 'passed') continue;
      console.log(`  Round ${c.round} (seed ${c.seed}) passed, and changed from round 0: ${c.steps.slice(0, 4).map((x) => stepName(x.test, x.step)).join('; ')}${c.steps.length > 4 ? '; …' : ''} (${CLI} changes ${r.run}).`);
    }
    if (!failed.length && found.stopped === null) console.log('  No race found: every step passed in every round. More rounds look further.');
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
      runsSuite(suite);
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
    // is younger than config.sessions.freshFor. `--network`: each person's
    // requests kept too, as HARs without their secrets (network/).
    async replay() {
      // A group of suites, by its tag (tags.mjs): each played as a full run.
      const tagAt = rest.indexOf('--tag');
      if (tagAt !== -1) return replayGroup(rest[tagAt + 1], rest.filter((_, i) => i !== tagAt && i !== tagAt + 1));
      const suite = rest[0];
      if (!suite) fail(`Usage: ${CLI} replay <suite> [--network [--bodies]] [--a11y] [--languages [es,fr]] [--realtime] [--changes [run]] [--chaos [N] | --chaos-seed <n>] [--in-docker] [playwright args]\n       ${CLI} replay --tag <tag> [--keep-going] [looks]`);
      const file = recordingOf(config, suite);
      if (!file) fail(`No recording for the suite "${suite}" in ${P.recordings}`);
      const network = rest.includes('--network');
      const bodies = rest.includes('--bodies');
      const a11y = rest.includes('--a11y');
      const realtime = rest.includes('--realtime');
      // A flag that may take a value: `--languages`, `--languages es,fr` or
      // `--languages=es,fr`; the next word is its value only when it looks
      // like one.
      const valued = (name, re) => {
        const at = rest.findIndex((a) => a === name || a.startsWith(`${name}=`));
        if (at === -1) return { on: false, value: null, used: [] };
        if (rest[at].includes('=')) return { on: true, value: rest[at].slice(name.length + 1) || null, used: [at] };
        return re.test(rest[at + 1] ?? '') ? { on: true, value: rest[at + 1], used: [at, at + 1] } : { on: true, value: null, used: [at] };
      };
      // `--languages`: the config's priority ones; `--languages es,fr`:
      // those only, the ones new to the app, say.
      const langsFlag = valued('--languages', /^[a-z]{2,3}(-[A-Za-z0-9]+)?(,[a-z]{2,3}(-[A-Za-z0-9]+)?)*$/);
      const languages = langsFlag.on;
      const listed = langsFlag.value;
      // `--chaos`: rounds that look for races (3, or as many as it says);
      // `--chaos-seed <n>`: one of their rounds, played again.
      const chaosFlag = valued('--chaos', /^\d+$/);
      const seedFlag = valued('--chaos-seed', /^\d+$/);
      const rounds = chaosFlag.on ? Number(chaosFlag.value ?? 3) : 0;
      const seed = seedFlag.on ? Number(seedFlag.value) : null;
      // `--changes`: compared with the newest green run before it, made the
      // same way; `--changes <run>`: with that one (changes.mjs).
      const changesFlag = valued('--changes', /^\d{8}-\d{6}-[\w.-]+$/);
      const dropped = new Set([...langsFlag.used, ...chaosFlag.used, ...seedFlag.used, ...changesFlag.used]);
      const pwArgs = rest.slice(1).filter((a, i) => !dropped.has(i + 1) && !['--network', '--bodies', '--a11y', '--realtime'].includes(a));
      if (seedFlag.on && !(Number.isInteger(seed) && seed >= 1 && seed <= 999_999_999)) fail(`--chaos-seed takes a round's seed, as a search printed it: ${CLI} replay ${suite} --chaos-seed 4711`);
      if (chaosFlag.on && seedFlag.on) fail(`--chaos-seed plays one round of a search again, by itself: ${CLI} replay ${suite} --chaos-seed ${seed}`);
      if (chaosFlag.on && !(Number.isInteger(rounds) && rounds >= 2 && rounds <= 50)) {
        fail(`--chaos ${chaosFlag.value}: from 2 to 50 rounds. A race shows as a step that passes in one round and fails in another.`);
      }
      if (chaosFlag.on && changesFlag.on) fail('--chaos compares each round with its round 0, played as it is: no --changes with it.');
      if (chaosFlag.on && (network || a11y || languages || realtime)) {
        fail(`--chaos compares its rounds; it does not look at each. Once a round fails, its seed plays it again with any look: ${CLI} replay ${suite} --chaos-seed <seed> --realtime`);
      }
      let langs = null;
      if (languages) {
        if (!config.languages) {
          fail(`--languages: the config says no \`languages\`, nor how a person changes the app's language. The skill says how to write it, and ${CLI} languages check tries it.`);
        }
        langs = listed ? listed.split(',') : config.languages.priority;
        const strange = langs.filter((x) => !config.languages.others.includes(x));
        if (strange.length) fail(`--languages ${listed}: ${strange.join(', ')} is not among the config's (${config.languages.others.join(', ')}).`);
      }
      if (bodies && !network) fail('--bodies goes with --network: it keeps the text of the responses in its HARs.');
      // In a container the requests cross another network, and the HARs
      // would have to come back from it: a look is taken on this machine.
      if (network && IN_DOCKER) fail('A look at the network is taken on this machine: run it without --in-docker.');
      guard();
      await takeStack('replay', suite, ['replay', ...rest].join(' '));
      runsSuite(suite);
      fs.mkdirSync(P.state, { recursive: true });
      if (rounds) return searchRaces(suite, file, pwArgs, rounds);
      if (seed !== null) {
        // One round of a search again: from the same start, its people
        // slowed the same way.
        const { profileOf, profileText } = await import('./chaos.mjs');
        const people = playersOf(file);
        console.log(`The round of seed ${seed}, from fresh data:`);
        for (const id of people) console.log(`   ${id}: ${profileText(profileOf(seed, id))}`);
        await chaosToCockpit('round', { previous: null, chaos: { group: null, round: 1, of: 1, seed, people: Object.fromEntries(people.map((id) => [id, profileOf(seed, id)])) } });
        const code = await freshStart(suite);
        if (code) process.exit(code);
        process.env.QA_CHAOS = String(seed);
      } else {
        // Said, not refused: one test run again on purpose (`-g T3`) is a
        // replay after a replay too.
        const stale = staleFor(readData(config), suite);
        if (stale) console.log(`${staleLine(stale)} The recording may fail for that: \`${CLI} reset\` and \`${CLI} setup ${suite}\` first.`);
      }
      if (!P.sessionsSetup || sessionsFresh(config.sessions.freshFor)) {
        if (P.sessionsSetup) console.log('Saved sessions are fresh; not renewing them.');
      } else {
        await playwright(['test', testFileArg(P.sessionsSetup)]);
      }
      // From its first test on, a recording changes the data.
      noteData(config, { state: 'spent', suite });
      if (network) await lookAtNetwork(suite, bodies);
      if (a11y) lookAtA11y();
      if (languages) lookInLanguagesToo(langs);
      if (realtime) timeHandOffs();
      if (!changesFlag.on) return void (await playwright(['test', testFileArg(file), ...pwArgs]));
      if (!cockpitRun()) {
        console.log(`--changes compares the photos the cockpit takes of each step, and no cockpit follows this run: start one first (${CLI} cockpit).`);
        return void (await playwright(['test', testFileArg(file), ...pwArgs]));
      }
      // Red or green, what it reached is compared, then it ends with its code.
      const code = await playwright(['test', testFileArg(file), ...pwArgs], { exit: false });
      await lookForChanges(cockpitRun(), changesFlag.value);
      // Its code as the end, with the loop left to drain: a process.exit()
      // while the comparison's browser and sockets are still closing aborts
      // Node on Windows (libuv's UV_HANDLE_CLOSING assertion), and the
      // cockpit read a green run as red.
      process.exitCode = code;
    },

    // What a person reported from «Play as» in the cockpit (play.mjs): their
    // note, then what they did as steps in a suite's words, each with its
    // photos (the window just before the action, its mark, and after it),
    // its requests and the page's errors. The newest report, or the one
    // named; --list, every one kept.
    async play() {
      const root = path.join(P.out, 'cockpit');
      const metaOf = (d) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(root, d, 'run.json'), 'utf8'));
        } catch {
          return null;
        }
      };
      const reports = fs.existsSync(root)
        ? fs
            .readdirSync(root)
            .filter((d) => metaOf(d)?.kind === 'play')
            .sort()
            .reverse()
        : [];
      if (rest.includes('--list')) {
        if (!reports.length) console.log('No report from «Play as» yet.');
        for (const d of reports) {
          const m = metaOf(d);
          console.log(`${d}  ${(m.play?.people ?? []).join(', ')}, ${m.play?.acts ?? 0} actions: ${(m.play?.note || '(no note)').split(/\r?\n/)[0]}`);
        }
        return;
      }
      const want = rest[0] && rest[0] !== 'latest' ? rest[0] : reports[0];
      if (!want) fail('No report from «Play as» yet: in the cockpit, «Play as» a person, play, then «Make a report».');
      if (!metaOf(want)) fail(`No run ${want} in ${shown(config, root)} (${CLI} play --list).`);
      if (metaOf(want).kind !== 'play') fail(`${want} is a run, not a report from «Play as»: ${CLI} notes ${want} says what was pinned on it.`);
      const { readRunFiles } = await import('./notes.mjs');
      const { meta, frames } = readRunFiles(path.join(root, want));
      const photo = (f) => shown(config, path.join(P.out, f.file));
      const people = (meta.play?.people ?? []).map((id) => {
        const d = frames.find((f) => f.actor === id && f.device)?.device;
        return `${id[0].toUpperCase()}${id.slice(1)}${d ? ` (${d.name})` : ''}`;
      });
      const steps = frames.filter((f) => f.kind !== 'action');
      console.log(`# Report from «Play as»: ${meta.suite} · ${want}`);
      console.log(`Made ${meta.endedAt}, playing as ${people.join(', ')}: ${meta.play?.acts ?? 0} actions${meta.play?.dropped ? ` (and ${meta.play.dropped} earlier ones left out)` : ''}.`);
      console.log('\nWhat went wrong, in the person\'s words:');
      for (const line of (meta.play?.note || '(no note)').split(/\r?\n/)) console.log(`> ${line}`);
      console.log('');
      for (const f of steps) {
        console.log(f.step);
        const before = frames.find((a) => a.kind === 'action' && a.of === f.seq);
        if (before) {
          const m = before.marks?.[0];
          console.log(`   before: ${photo(before)}${m ? ` (its mark at ${m.x},${m.y} of the window)` : ''}`);
        }
        console.log(`   ${f.status === 'failed' ? 'photo' : 'after'}: ${photo(f)}`);
        const reqs = (f.requests ?? []).map((r) => `${r.method} ${r.path} ${r.status || 'failed'}`);
        if (reqs.length) console.log(`   requests: ${reqs.slice(0, 12).join(', ')}${reqs.length > 12 ? ', …' : ''}`);
        for (const c of f.console ?? []) console.log(`   page error: ${c.level === 'exception' ? 'uncaught ' : ''}${c.text}`);
      }
      console.log(
        "\nTo make it a test: write these steps, and what should have happened, as a test of a suite (the person's words for it); record it, and replay it: red until the fix turns it green.",
      );
    },

    // A run compared with an earlier green one (changes.mjs): what changed
    // on its screens (regions of its photos), in its requests and in its
    // page's errors, step by step. The newest run, or the one named; with
    // the run it was compared with, or `--against <run>`. Computed once, kept
    // in the run (`changes.json`).
    async changes() {
      const root = path.join(P.out, 'cockpit');
      const RUN = /^\d{8}-\d{6}-[\w.-]+$/;
      const at = rest.indexOf('--against');
      const against = at === -1 ? null : rest[at + 1];
      if (at !== -1 && !RUN.test(against ?? '')) fail(`Usage: ${CLI} changes [run] [--against <run>] [--json]`);
      const named = rest.find((a, i) => RUN.test(a) && (at === -1 || i !== at + 1));
      const { readRunFiles } = await import('./notes.mjs');
      const ids = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => RUN.test(d) && fs.existsSync(path.join(root, d, 'run.json'))).sort().reverse() : [];
      const run = named ?? ids.find((d) => readRunFiles(path.join(root, d)).meta.kind !== 'play');
      if (!run || !ids.includes(run)) fail(run ? `No run ${run} in ${shown(config, root)}.` : 'No run yet: the cockpit keeps the runs it follows.');
      if (against && !ids.includes(against)) fail(`No run ${against} in ${shown(config, root)}.`);
      const { baselineOf, changesLines, compareRuns, readChanges } = await import('./changes.mjs');
      const kept = readChanges(root, run);
      let c = kept && (!against || kept.against === against) && !rest.includes('--again') ? kept : null;
      if (!c) {
        const base = against ?? baselineOf(root, run);
        if (!base) fail(`No green run of its suite before ${run} to compare it with.`);
        c = await compareRuns({ config, root, run, against: base, say: rest.includes('--quiet') ? () => {} : (l) => console.log(l) });
      }
      if (rest.includes('--json')) return void console.log(JSON.stringify(c, null, 1));
      if (rest.includes('--quiet')) return;
      const files = new Map(readRunFiles(path.join(root, run)).frames.map((f) => [f.seq, f.file]));
      for (const line of changesLines(c, (seq) => (files.get(seq) ? shown(config, path.join(P.out, files.get(seq))) : `#${seq}`))) console.log(line);
    },

    // How a person changes the app's language (`languages.switchTo` in the
    // config): tried on one person's screen, each other language and back,
    // before a run relies on it (languages.mjs). Its photos stay to look at.
    async languages() {
      if (rest[0] !== 'check') fail(`Usage: ${CLI} languages check [person]`);
      if (!config.languages) fail("The config says no `languages`: the app's other languages, and how a person changes to one. The skill says how to write them.");
      const id = rest[1] ?? config.people.find((p) => fs.existsSync(path.join(P.state, `${p}.json`)));
      if (!id || !fs.existsSync(path.join(P.state, `${id}.json`))) fail(`No saved session${rest[1] ? ` for ${rest[1]}` : ''}: ${CLI} setup <suite> saves them.`);
      guard();
      const { checkLanguages } = await import('./languages-check.mjs');
      const ok = await checkLanguages(config, id, (line) => console.log(line));
      if (!ok) process.exitCode = 1;
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
        const { readSuite, recordingSteps, starterScript, stepsApart } = await import('./video/script.mjs');
        fs.mkdirSync(P.videos, { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(starterScript(config, suite), null, 2)}\n`);
        console.log(`${shown(config, file)}: every test and step of ${suite}, in the suite's words, no narration yet.`);
        // A step's subtitle is the row with its number: said now, before a
        // capture of minutes shows the wrong words under the steps.
        const recording = recordingOf(config, suite);
        const apart = recording ? stepsApart(readSuite(config, suite), recordingSteps(recording), { cast: config.cast }) : [];
        if (apart.length) {
          console.log("\nA step's subtitle is the suite's row with its number, and the recording's steps and the rows do not match:");
          for (const line of apart) console.log(`  ${line}`);
          console.log('  Number each step as its row, or give the step its own "subtitle" in this script.');
        }
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
      runsSuite(suite);
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
          `${before.length ? `; ${before.join(', ')} played too, uncaptured, for the data the shown ones start from` : ''} in ${shown(config, dir)}`,
      );
      // A red run makes no video: playwright() ends this process with its code.
      const red = (code) => {
        if (code) console.error('No video: the run must be green. Its capture stays, for a look.');
      };
      process.once('exit', red);
      noteData(config, { state: 'spent', suite });
      process.env.QA_VIDEO_DIR = dir;
      process.env.QA_VIDEO_MODE = mode;
      // Only the tests it shows are captured (video/capture.mjs).
      if (tests) process.env.QA_VIDEO_TESTS = tests.join(',');
      const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const grep = played ? ['-g', `(${played.map(escapeRe).join('|')}) · `] : [];
      await playwright(['test', testFileArg(file), ...grep]);
      process.removeListener('exit', red);
      delete process.env.QA_VIDEO_DIR;
      delete process.env.QA_VIDEO_MODE;
      delete process.env.QA_VIDEO_TESTS;

      // Green, and captured whole: what fails now is the drawing (ffmpeg
      // mixed a test of the sound before the run: a script's file, then),
      // which can be done again from the capture, without playing the suite.
      let made;
      try {
        made = await renderVideo(config, dir, { script: scriptFile, clips: flag('--clips'), mode });
      } catch (e) {
        fail(
          `${e instanceof Error ? e.message : String(e)}\n\nNo video: the run was green and its capture is made, but drawing it failed (above). ` +
            `The capture stays: ${CLI} video render ${path.basename(dir)} draws it again, without playing the suite.`,
        );
      }
      report(made);
      // The newest few captures of a suite stay, to draw again with another
      // script. A suite by its capture's word, not its folder's name: «chat-»
      // begins «chat-admin-» too.
      const keep = Math.max(1, config.video.keep);
      const suiteOf = (d) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(videosOut, d, 'capture.json'), 'utf8')).suite;
        } catch {
          return null;
        }
      };
      const old = fs
        .readdirSync(videosOut)
        .filter((d) => suiteOf(d) === suite)
        .sort((a, b) => fs.statSync(path.join(videosOut, a, 'capture.json')).mtimeMs - fs.statSync(path.join(videosOut, b, 'capture.json')).mtimeMs);
      for (const d of old.slice(0, Math.max(0, old.length - keep))) fs.rmSync(path.join(videosOut, d), { recursive: true, force: true });
    },

    // «Play as …» from the terminal: a new browser window signed in as one
    // person, from their saved session (open-browser.mjs).
    async open() {
      const person = rest[0];
      if (!person) fail(`Usage: ${CLI} open <person>`);
      guard();
      // The run going now may have their session (the cockpit's «Play as»
      // says the same, server.mjs sessionInUse): a window of theirs would be
      // them in two places, the run's sign-out its own.
      const held = readLock(LOCK);
      if (held) {
        const steps = String(held.command ?? '')
          .split(' → ')
          .map((c) => c.trim().split(/\s+/));
        const suites = steps.filter(([k]) => ['replay', 'setup', 'video'].includes(k)).map(([, s]) => s);
        const plays = suites.length
          ? listSuites(config).some((s) => suites.includes(s.name) && s.cast.includes(person))
          : steps.some(([k]) => k === 'reset' || k === 'sessions');
        if (plays) {
          fail(
            `${held.who} is running «${held.command}», and ${person}'s saved session is that run's now: a window of theirs would be the same session ` +
              `(what you did there, they would do in the run; signing out would sign the run out). Open it when the run ends.`,
          );
        }
      }
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
      // In the file's own line endings: a header written with LF in a CRLF
      // recording left it mixed (CritKeep's la-prova.spec.ts).
      const text = fs.readFileSync(file, 'utf8');
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(/\r?\n/);
      const header = suiteHeader(config, suite);
      if (/^\/\/ suite: /.test(lines[0])) lines[0] = header;
      else lines.unshift(header);
      fs.writeFileSync(file, lines.join(eol));
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

    // The suites' tags (tags.mjs): groups of suites played one after
    // another (`replay --tag`). With no words, every tag, its suites, the
    // suites with none, and what is wrong in the file; `add`, `remove` and
    // `about` change it.
    async tags() {
      const { changeTags, readTags, tagsFileOf } = await import('./tags.mjs');
      const usage = [
        `Usage: ${CLI} tags                          every tag, its suites, and what is wrong`,
        `       ${CLI} tags add <tag> <suite>...      the suites in the tag (made when new), at its end`,
        `       ${CLI} tags remove <tag> <suite>...   the suites off it`,
        `       ${CLI} tags about <tag> <words...>    what the tag is for`,
      ].join('\n');
      const known = new Set(listSuites(config).map((s) => s.name));
      const [sub, name, ...more] = rest;
      if (sub === 'add' || sub === 'remove') {
        if (!name || !more.length) fail(usage);
        const strange = sub === 'add' ? more.filter((s) => !known.has(s)) : [];
        if (strange.length) fail(`No suite ${strange.map((s) => `«${s}»`).join(', ')} in ${shown(config, P.suites)}.`);
        try {
          return console.log(changeTags(config, name, sub === 'add' ? { add: more } : { remove: more }));
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      }
      if (sub === 'about') {
        if (!name || !more.length) fail(usage);
        try {
          return console.log(changeTags(config, name, { about: more.join(' ') }));
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }
      }
      if (sub) fail(usage);
      const { tags, problems } = readTags(config, known);
      if (!tags.length && !problems.length) {
        console.log(`No tags yet. They live in ${shown(config, tagsFileOf(config))}: ${CLI} tags add smoke <suite>...`);
        return;
      }
      console.log(`Tags, in ${shown(config, tagsFileOf(config))}:`);
      const width = Math.max(...tags.map((x) => x.name.length), 4);
      for (const x of tags) {
        console.log(`  ${x.name.padEnd(width)}  ${x.suites.join(', ') || '(no suites)'}`);
        if (x.about) console.log(`  ${' '.repeat(width)}  ${x.about}`);
      }
      const untagged = [...known].filter((s) => !tags.some((x) => x.suites.includes(s)));
      if (untagged.length) console.log(`Suites in no tag: ${untagged.join(', ')}`);
      if (problems.length) {
        console.log('What is wrong in it:');
        for (const p of problems) console.log(`  ${p}`);
        process.exitCode = 1;
      }
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

    // What a `replay --network` found (network/report.mjs), for an agent
    // asked about load times: the newest look, a suite's newest, or the one
    // named; `--against` an earlier one, to measure what a change changed.
    async network() {
      const { analyse, compareText, findRun, networkRuns, readRun, reportJson, reportText } = await import('./network/report.mjs');
      const usage = `Usage: ${CLI} network [<run> | <suite>] [--against <run> | <suite> | previous] [--test <id>] [--json]  |  ${CLI} network --list`;
      const root = path.join(P.out, 'network');
      const runs = networkRuns(root);
      const valueOf = (name) => {
        const i = rest.indexOf(name);
        if (i === -1) return null;
        if (!rest[i + 1] || rest[i + 1].startsWith('--')) fail(usage);
        return rest[i + 1];
      };
      const against = valueOf('--against');
      const test = valueOf('--test');
      const named = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--against' && rest[i - 1] !== '--test') ?? null;
      const none = `${CLI} replay <suite> --network takes one`;
      if (rest.includes('--list')) {
        if (!runs.length) return console.log(`No look at the network yet: ${none}.`);
        for (const r of runs) console.log(`${r.id}  ${r.meta.status ?? 'running or stopped'}  ${r.meta.command ?? ''}`);
        return;
      }
      if (!runs.length) fail(`No look at the network yet in ${shown(config, root)}: ${none}.`);
      const run = findRun(runs, named);
      if (!run) fail(`No look at the network «${named}» in ${shown(config, root)} (--list shows them).`);
      const how = { shown: (abs) => shown(config, abs), cli: CLI };
      const now = analyse(readRun(run), { test });
      if (against) {
        // «previous», or a suite: its newest look before this one.
        const before = runs.find((r) => r.id === against) ?? findRun(runs, against === 'previous' ? run.meta.suite : against, { before: run });
        if (!before) fail(`No earlier look at ${against === 'previous' ? run.meta.suite : against} to compare ${run.id} with (--list shows them).`);
        const then = analyse(readRun(before), { test });
        if (rest.includes('--json')) return console.log(JSON.stringify({ now: reportJson(now), before: reportJson(then) }, null, 2));
        return console.log(compareText(now, then, how));
      }
      if (rest.includes('--json')) return console.log(JSON.stringify(reportJson(now), null, 2));
      console.log(reportText(now, how));
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
  tags [add|remove|about <tag> ...]   groups of suites, in <suites>/tags.json
  setup <suite>    cast and initial state of a suite, sessions saved
  sessions         fresh saved sessions for everybody with an account
  smoke            the app loads and the API answers
  decide <suite>   REPLAY | GENERATE <why> | ENV <why>, from the recording's hash
  hash <suite>     the header line a recording of the suite must carry
  stamp <suite>    write that header into the recording's first line
  replay <suite>   fresh sessions, then the suite's recording (extra args go to Playwright);
                   --network: each person's requests kept too, as HARs without their secrets
                   (--bodies: with the text of the app's responses);
                   --a11y: each step's screen looked at for accessibility, with the cockpit:
                   a button or a link with no name, a field with no label, an image with no
                   text alternative, a control the keyboard cannot reach;
                   --languages [es,fr]: each step's screen in the app's other languages too (the
                   config's priority ones, or those named), with the cockpit: what does not fit;
                   --realtime: how long what one person does takes to reach another's screen
                   (sent, received, seen), with the cockpit;
                   --chaos [N]: races between people, in N rounds (3), each from fresh data
                   with each person slowed in its own way (network, pushes, CPU), drawn from
                   the round's seed: a step that passes in some and fails in others is a race;
                   --chaos-seed <n>: that round again;
                   --changes [run]: then compared with the newest green run before it, made the
                   same way (or the one named), with the cockpit: what changed on its photos,
                   in its requests, in its page's errors
  replay --tag <tag>   the tag's suites (tags.json) one after another, each as a full run (reset,
                   setup, replay) with the looks asked for; the first that fails stops the rest
                   (--keep-going: every one)
  changes [run]    a run compared with an earlier green one (--against <run>, --json)
  languages check [person]   that change of language, tried on one screen and back
  network [run]    what a replay --network found, step by step: calls one after another,
                   repeated or per item, slow, heavy or failed (--against previous: what a
                   change changed; --test <id>; --json; --list)
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
  play [run]       a report a person made from «Play as» in the cockpit: their note, and what
                   they did as steps in a suite's words, with photos, requests and page errors
                   (the newest; --list: every one kept)
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
