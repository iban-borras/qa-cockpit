// One run at a time on the stack. The suites share ONE database and each run
// begins with a reset, so two at once wipe each other's state (it happened:
// a cockpit run reset the database under somebody else's recording). Every
// command that changes the stack's state (reset, setup, sessions, replay,
// down, purge) takes `<out>/qa.lock` first, and a second one is refused with
// who holds it, since when and doing what.
//
// A lock whose process is gone does not count. A sequence (the cockpit's
// «Full run», or a chain of your own) takes it once and hands it to its
// steps through QA_LOCK: a command whose QA_LOCK matches the lock's token
// goes ahead without taking it again.
//
// QA_WHO names the holder («Claude», «ci», a person); without it the name
// comes from the program the command was launched from.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** The lock file of a project. */
export function lockFileOf(config) {
  return path.join(config.paths.out, 'qa.lock');
}

/** The stack is taken: the refusal carries the holder. */
export class StackBusy extends Error {
  constructor(holder, cli = 'npx qa-cockpit') {
    super(
      `The stack is in use: ${holder.who} runs «${holder.command}» since ${new Date(holder.since).toLocaleTimeString()} ` +
        `(pid ${holder.pid}). Wait for it to end; if it hangs, ${cli} unlock.`,
    );
    this.holder = holder;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // it exists, it is only not ours to signal
  }
}

/** Who holds the stack, or null: no lock, or its process is gone. */
export function readLock(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isAlive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

// The programs a command may be launched from, as a person would name them.
// Apps before shells: a shell inside Antigravity is Antigravity's.
const APPS = [
  [/antigravity/i, 'Antigravity'],
  [/claude/i, 'Claude'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'],
  [/^code(\.exe)?$/i, 'VS Code'],
];
const SHELLS = [[/windowsterminal|powershell|pwsh|cmd\.exe|bash|zsh|fish|^sh$/i, 'terminal']];

/** This process's ancestors' names, nearest first. */
function ancestors() {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      ).stdout;
      const table = new Map(
        out.split(/\r?\n/).filter(Boolean).map((l) => {
          const [pid, ppid, ...name] = l.trim().split(' ');
          return [Number(pid), { ppid: Number(ppid), name: name.join(' ') }];
        }),
      );
      const names = [];
      for (let pid = process.ppid, i = 0; table.has(pid) && i < 12; i++) {
        names.push(table.get(pid).name);
        pid = table.get(pid).ppid;
      }
      return names;
    }
    const names = [];
    for (let pid = process.ppid, i = 0; pid > 1 && i < 12; i++) {
      const line = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      if (!line) break;
      const [ppid, ...name] = line.split(/\s+/);
      names.push(path.basename(name.join(' ')));
      pid = Number(ppid);
    }
    return names;
  } catch {
    return [];
  }
}

export function whoAmI() {
  if (process.env.QA_WHO) return process.env.QA_WHO;
  const names = ancestors();
  for (const list of [APPS, SHELLS]) {
    for (const name of names) {
      const hit = list.find(([re]) => re.test(name));
      if (hit) return hit[1];
    }
  }
  return os.userInfo().username;
}

/**
 * Take the stack for `command`, or throw StackBusy. Returns the lock's token
 * (for the steps of a sequence, as QA_LOCK), the holder's name and the
 * function that gives it back. A command-line process gives it back when it
 * exits; a long-lived one (the cockpit) passes `untilExit: false` and gives
 * it back itself.
 * @param {string} file the lock file (lockFileOf)
 * @param {string} command what the holder is doing, as the refusal says it
 * @param {{ who?: string, untilExit?: boolean, cli?: string }} [opts]
 */
export function acquireLock(file, command, opts = {}) {
  const current = readLock(file);
  const inherited = process.env.QA_LOCK;
  if (current && inherited && current.token === inherited) return { token: inherited, who: current.who, release: () => {} };
  if (current) throw new StackBusy(current, opts.cli);
  const lock = {
    token: randomUUID(),
    pid: process.pid,
    who: opts.who ?? whoAmI(),
    command,
    since: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // `wx` creates or fails: of two commands that both saw no lock, one wins.
  // A file left by a process that is gone is removed first.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(lock, null, 1), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || attempt > 0) throw e;
      const other = readLock(file);
      if (other) throw new StackBusy(other, opts.cli);
      fs.rmSync(file, { force: true });
    }
  }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === lock.token) fs.rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  };
  if (opts.untilExit !== false) process.on('exit', release);
  return { token: lock.token, who: lock.who, release };
}

/** Remove the lock whatever holds it. */
export function breakLock(file) {
  const was = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  })();
  fs.rmSync(file, { force: true });
  return was;
}
