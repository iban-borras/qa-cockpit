// A stack that is one process of your own: `node server.mjs`, `npm run dev`...
// started in the background, its pid and its output kept next to the config,
// and stopped again. For an app that runs in containers, see compose.mjs.
//
//   stack: processStack({
//     base: import.meta.url,
//     command: process.execPath,
//     args: ['../app/server.mjs'],
//     env: { PORT: '4310', DEMO_TEST_HOOKS: '1' },
//     app: 'http://127.0.0.1:4310',
//     health: '/health',
//     reset: async ({ urls }) => { await fetch(`${urls.app}/api/test/reset`, { method: 'POST' }) },
//   })
//
// «Running» means the process this helper started is alive: nothing here
// can be pointed at an app somebody else started.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlive } from './lock.mjs';

/**
 * @param {{
 *   base: string,
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   app: string,
 *   api?: string | null,
 *   health?: string | null,
 *   name?: string,
 *   stateDir?: string,
 *   shell?: boolean,
 *   reset?: (ctx: { urls: { app: string, api: string | null } }) => Promise<string | void>,
 * }} opts
 */
export function processStack(opts) {
  const baseDir = path.dirname(fileURLToPath(opts.base));
  const cwd = path.resolve(baseDir, opts.cwd ?? '.');
  const dir = path.resolve(baseDir, opts.stateDir ?? '.qa-cockpit');
  const pidFile = path.join(dir, 'stack.pid');
  const logFile = path.join(dir, 'stack.log');
  const name = opts.name ?? path.basename(opts.args?.at(-1) ?? opts.command);
  const urlsOf = () => ({ app: opts.app, api: opts.api === undefined ? opts.app : opts.api });

  const pid = () => {
    try {
      const n = Number(fs.readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(n) && n > 0 && isAlive(n) ? n : null;
    } catch {
      return null;
    }
  };

  // The whole tree: `npm run dev` is a shell, npm, and the server under them.
  function stop() {
    const n = pid();
    if (n) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true });
      } else {
        try {
          process.kill(-n, 'SIGTERM'); // its process group (it was started detached)
        } catch {
          try {
            process.kill(n, 'SIGTERM');
          } catch {
            // Gone already.
          }
        }
      }
    }
    fs.rmSync(pidFile, { force: true });
    return n;
  }

  return {
    name,
    healthPath: opts.health ?? null,
    urls() {
      if (!pid()) throw new Error(`The stack "${name}" is not running (no process of ours).`);
      return urlsOf();
    },
    async urlsAsync() {
      return pid() ? urlsOf() : null;
    },
    async up() {
      if (pid()) return;
      fs.mkdirSync(dir, { recursive: true });
      const log = fs.openSync(logFile, 'a');
      const child = spawn(opts.command, opts.args ?? [], {
        cwd,
        env: { ...process.env, ...opts.env },
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
        // `npm` and friends are scripts on Windows: they need a shell there.
        shell: opts.shell ?? (process.platform === 'win32' && !/\.exe$/i.test(opts.command)),
      });
      child.unref();
      fs.writeFileSync(pidFile, String(child.pid));
      console.log(`Started ${name} (pid ${child.pid}); its output goes to ${logFile}`);
    },
    async down() {
      const n = stop();
      console.log(n ? `Stopped ${name} (pid ${n}).` : `${name} was not running.`);
    },
    async purge() {
      stop();
      fs.rmSync(logFile, { force: true });
    },
    ...(opts.reset ? { reset: async () => opts.reset({ urls: urlsOf() }) } : {}),
  };
}
