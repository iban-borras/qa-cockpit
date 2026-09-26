// The runner container's entry point (runner.mjs starts it, with the
// project's folder as the working directory). On Docker Desktop the
// container sits on the stack's network, where the app is its service name
// and container port; but the app in the browser calls the host's published
// ports, the saved sessions belong to those origins and the backend may only
// allow them. So, before Playwright starts, every port the stack publishes on
// the host is forwarded from this container's own localhost to its service:
// same origins, same cookies, same sessions as a run on the host. On Linux
// the container shares the host's network and QA_FORWARD is empty.
//
//   QA_FORWARD=3100=frontend:3000,8100=backend:8000,...  node runner-entry.mjs <playwright args>
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const PROJECT_DIR = process.cwd();

function forward(listenPort, host, targetPort) {
  const handler = (client) => {
    const upstream = net.connect(targetPort, host);
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end);
    upstream.on('error', end);
  };
  const listen = (address) =>
    new Promise((resolve, reject) => {
      const server = net.createServer(handler);
      server.once('error', reject);
      server.listen(listenPort, address, resolve);
    });
  // Both loopbacks: a browser may try ::1 first for «localhost».
  return Promise.all([listen('127.0.0.1'), listen('::1').catch(() => {})]);
}

// The container's node_modules (a volume, runner.mjs) follow
// package-lock.json. `npm install --no-save`, not `npm ci`: ci deletes
// node_modules, and a mount point cannot be deleted; --no-save leaves
// package-lock.json as it is.
function depsStale() {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8')).packages ?? {};
    } catch {
      return null;
    }
  };
  const want = read('package-lock.json');
  const have = read('node_modules/.package-lock.json');
  if (!want || !have) return true;
  return Object.entries(want).some(([k, e]) => k !== '' && !e.optional && have[k]?.version !== e.version);
}
if (depsStale()) {
  console.log('runner: installing the dependencies in the container...');
  const r = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: PROJECT_DIR, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const spec = (process.env.QA_FORWARD ?? '').split(',').filter(Boolean);
for (const entry of spec) {
  const m = /^(\d+)=([\w.-]+):(\d+)$/.exec(entry);
  if (!m) {
    console.error(`runner: bad QA_FORWARD entry «${entry}»`);
    process.exit(2);
  }
  await forward(Number(m[1]), m[2], Number(m[3]));
}
if (spec.length) console.log(`runner: localhost forwards ${spec.join(', ')}`);

const cli = path.join(PROJECT_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: PROJECT_DIR, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('close', (code) => {
  // The results Playwright wrote on the container's disk (QA_OUTPUT_DIR) go
  // where a run on the host leaves them (QA_RESULTS_TO), for the healer to read.
  const from = process.env.QA_OUTPUT_DIR;
  const to = process.env.QA_RESULTS_TO;
  if (from && to && fs.existsSync(from)) {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  process.exit(code ?? 1);
});
