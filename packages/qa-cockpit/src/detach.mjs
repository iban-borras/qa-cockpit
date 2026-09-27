// `cockpit --detach`: the cockpit for a person, started so that it outlives
// whoever asked for it and opens its windows on the person's own desktop.
// What an agent runs when somebody asks it to «open the cockpit»: a cockpit
// in the agent's own session dies with the session, and one started from a
// terminal on a desktop nobody sees (desktop.mjs) opens its windows there.
//
//   one answers, this version  →  says where, and opens the page
//   one answers, another       →  says so; `--restart` replaces it
//   --restart                  →  stops it (never during a run), then starts
//   none                       →  starts one:
//     Windows, the person's desktop: in a window of its own, «QA Cockpit»,
//       minimised (`start`);
//     Windows, a desktop nobody sees: through the Task Scheduler, whose
//       interactive tasks start on the desktop of the person logged on. The
//       task lives a few seconds: it is deleted once the cockpit answers;
//     macOS and Linux: in the background, its output in <out>/cockpit.log.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { onPersonsDesktop } from './desktop.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const q = (s) => `"${s}"`;

async function stateAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function openPage(url) {
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

function stopProcess(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone already.
    }
  }
}

/** Windows, the person's desktop: a console window of its own, minimised. */
function startInWindow(cwd, env, argv) {
  const line = ['start', q('QA Cockpit'), '/min', ...argv.map(q)].join(' ');
  spawn('cmd.exe', ['/d', '/s', '/c', q(line)], {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
}

/** Windows, a desktop nobody sees: an interactive task of the Task Scheduler
 *  runs a small launcher (in <out>) on the desktop of the person logged on.
 *  Returns what deletes the task. */
function startThroughScheduler(config, cwd, env, argv) {
  fs.mkdirSync(config.paths.out, { recursive: true });
  const launcher = path.join(config.paths.out, 'cockpit-start.cmd');
  const lines = [
    '@echo off',
    `cd /d ${q(cwd)}`,
    ...Object.entries(env).map(([k, v]) => `set ${q(`${k}=${v}`)}`),
    `start ${q('QA Cockpit')} /min ${argv.map(q).join(' ')}`,
  ];
  fs.writeFileSync(launcher, `${lines.join('\r\n')}\r\n`);
  const name = `QA Cockpit ${String(config.stack?.name ?? config.name ?? 'project').replace(/[^\w .-]+/g, '-')}`;
  const schtasks = (...a) => spawnSync('schtasks', a, { windowsHide: true, encoding: 'utf8' });
  // «Once at 00:00» never fires by itself: /Run starts it now.
  const made = schtasks('/Create', '/TN', name, '/TR', q(launcher), '/SC', 'ONCE', '/ST', '00:00', '/IT', '/F');
  if (made.status !== 0) throw new Error(`The Task Scheduler refused the task: ${(made.stderr || made.stdout).trim()}`);
  const ran = schtasks('/Run', '/TN', name);
  if (ran.status !== 0) {
    schtasks('/Delete', '/TN', name, '/F');
    throw new Error(`The Task Scheduler could not start the task: ${(ran.stderr || ran.stdout).trim()}`);
  }
  return () => schtasks('/Delete', '/TN', name, '/F');
}

/** macOS and Linux: in the background, its output in a log. */
function startInBackground(config, cwd, env, argv) {
  const log = path.join(config.paths.out, 'cockpit.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fd, fd] }).unref();
  return log;
}

/**
 * @param {{ config: any, port: number, entry: string, args: string[],
 *   restart: boolean, open: boolean, cwd: string }} o
 *   `entry`: the script the CLI runs from (the project's own, or the
 *   package's bin), so the cockpit starts as the person would start it;
 *   `args`: what the cockpit itself takes (`--port`, `--no-open`).
 */
export async function detachCockpit({ config, port, entry, args, restart, open, cwd }) {
  const url = `http://localhost:${port}`;
  const cli = config.cli;
  let running = await stateAt(port);
  if (running && !restart) {
    if (running.version !== VERSION) {
      console.log(
        `A cockpit of QA Cockpit ${running.version ?? 'older than 0.3.0'} answers at ${url}; this one is ${VERSION}. \`${cli} cockpit --restart\` replaces it.`,
      );
    } else console.log(`The cockpit already runs at ${url}.`);
    if (open && (await onPersonsDesktop())) openPage(url);
    return;
  }
  if (running) {
    if (running.task) throw new Error(`A run is going in the cockpit («${running.task.label}»): wait for it to end, or stop it there.`);
    if (!running.pid) throw new Error(`The cockpit at ${url} is older than 0.3.0 and does not say its process: close its window, then \`${cli} cockpit --detach\`.`);
    stopProcess(running.pid);
    for (let i = 0; i < 40 && (await stateAt(port)); i++) await sleep(250);
    if (await stateAt(port)) throw new Error(`The cockpit at ${url} (pid ${running.pid}) did not stop.`);
    console.log(`Stopped the cockpit ${running.version ?? ''} (pid ${running.pid}).`.replace('  ', ' '));
  }

  const argv = [process.execPath, entry, 'cockpit', ...args];
  // The config, for a cockpit started by the package's bin from elsewhere.
  const env = config.file ? { QA_COCKPIT_CONFIG: config.file } : {};
  let how;
  let done = () => {};
  if (process.platform === 'win32') {
    if (await onPersonsDesktop()) {
      startInWindow(cwd, env, argv);
      how = 'in a window of its own, «QA Cockpit», minimised';
    } else {
      done = startThroughScheduler(config, cwd, env, argv);
      how = 'through the Task Scheduler, on the desktop of the person logged on (this terminal is on one nobody sees)';
    }
  } else {
    const log = startInBackground(config, cwd, env, argv);
    how = `in the background; its output goes to ${log}`;
  }

  // Its first start may install the dependencies and the browser.
  for (let i = 0; i < 180 && !(running = await stateAt(port)); i++) await sleep(500);
  done();
  if (!running) throw new Error(`The cockpit did not answer at ${url} within a minute and a half.`);
  // Where it opens its windows is known a moment after it starts.
  await sleep(3000);
  running = (await stateAt(port)) ?? running;
  console.log(`The cockpit runs at ${url} (QA Cockpit ${running.version}), ${how}.`);
  if (running.desktopWarning) {
    console.log(
      `But its windows will not show (${running.desktopWarning.where ?? running.desktopWarning.code}): ask the person to run \`${cli} cockpit\` in a terminal of their own.`,
    );
  }
}
