// `<cli> <command> --in-docker`: Playwright runs inside the official
// Playwright image of the version the project's package-lock.json pins (an
// npm project only: the container installs it with npm), so
// the browser and its fonts are the same on any machine. The host needs Node
// and Docker, nothing installed in the project's folder. Only for a stack
// made with composeStack (compose.mjs).
//
// What the container gets, and what it does not:
//   - the repo, mounted at /work (the tests, the saved sessions, and the
//     output where the results land), with node_modules as a volume of its
//     own that runner-entry.mjs keeps in step with the lockfile;
//   - this package, mounted read-only at /qa-cockpit, for its entry point;
//   - the app at the host's own origins: on Docker Desktop, the stack's
//     network plus runner-entry.mjs forwarding localhost's published ports
//     to the services; on a Linux engine, the host's network;
//   - NO docker socket. The compose commands the tests need (port, exec,
//     logs, ps) run on the host, through a bridge on the loopback that asks
//     for a token made for this run (compose.mjs is its client).
// The cockpit, when a run reports to it, is reached the same way.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageManager } from '../deps.mjs';

const PACKAGE_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const BRIDGE_COMMANDS = new Set(['port', 'exec', 'logs', 'ps']);

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
}

function composeOf(config) {
  const c = config.stack.compose;
  if (!c) throw new Error('--in-docker needs a stack made with composeStack (qa-cockpit/compose).');
  return c;
}

/** The image of the Playwright the lockfile pins, not of a range. */
export function runnerImage(config) {
  // The container installs the project on its own, with the npm the image
  // has, from a package-lock.json beside the config (runner-entry.mjs).
  const pm = packageManager(config);
  if (pm.dir !== config.paths.project || path.basename(pm.lockfile ?? '') !== 'package-lock.json') {
    const what = pm.lockfile ? path.relative(config.paths.root, pm.lockfile).split(path.sep).join('/') : 'no lockfile';
    throw new Error(`--in-docker installs with npm from a package-lock.json beside the config; this project has ${pm.name} (${what}): run without --in-docker.`);
  }
  const lock = JSON.parse(fs.readFileSync(pm.lockfile, 'utf8'));
  const version = lock.packages?.['node_modules/@playwright/test']?.version;
  if (!version) throw new Error('package-lock.json pins no @playwright/test.');
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

/**
 * The dependencies the lockfile takes from a file or a folder outside the
 * repository: the container sees only the repository (/work), and its
 * install fails on them, deep in npm's words. CritKeep met it trying a
 * release candidate installed from a tarball elsewhere on the disk.
 * @returns {{ name: string, from: string }[]}
 */
function outsideDeps(config, lockfile) {
  const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  const root = path.resolve(config.paths.root);
  const out = [];
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || typeof e?.resolved !== 'string') continue;
    const local = e.resolved.startsWith('file:') ? e.resolved.slice('file:'.length) : e.link ? e.resolved : null;
    if (!local) continue;
    const from = path.resolve(path.dirname(lockfile), local);
    const rel = path.relative(root, from);
    if (rel.startsWith('..') || path.isAbsolute(rel)) out.push({ name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), from });
  }
  return out;
}

/**
 * Whether a run can go in the runner container, before one starts: a
 * compose stack, an npm project with Playwright pinned, nothing installed
 * from outside the repository. Throws why not.
 */
export function dockerReady(config) {
  const compose = composeOf(config);
  const image = runnerImage(config);
  const outside = outsideDeps(config, packageManager(config).lockfile);
  if (outside.length) {
    throw new Error(
      `--in-docker: the container sees only the repository, and ${outside.map((x) => `${x.name} comes from ${x.from}`).join('; ')}, outside it. ` +
        'Install it from npm, or from a file inside the repository (npm i -D ./<file>.tgz), or run without --in-docker.',
    );
  }
  return { compose, image };
}

// The label every runner container carries, so the cockpit can stop them.
export const runnerLabel = (config) => `${composeOf(config).project}-runner`;

function ensureImage(image) {
  if (docker(['image', 'inspect', image]).status === 0) return;
  console.log(`Pulling ${image} (once; about 2 GB)...`);
  const r = spawnSync('docker', ['pull', image], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`Could not pull ${image}.`);
}

/** Docker Desktop (Windows, macOS) or an engine on the Linux host itself. */
function isDockerDesktop() {
  return /docker desktop/i.test(docker(['info', '--format', '{{.OperatingSystem}}']).stdout ?? '');
}

function stackNetwork(project) {
  const out = docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
  const name = out.stdout?.trim().split(/\s+/)[0];
  if (!name) throw new Error(`The stack "${project}" has no network: is it up?`);
  return name;
}

function startBridge(compose, token) {
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/compose' || req.headers['x-qa-token'] !== token) {
      return reply(403, { error: 'forbidden' });
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const { args, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(args) || !BRIDGE_COMMANDS.has(args[0]) || !args.every((a) => typeof a === 'string')) {
          return reply(400, { error: `only ${[...BRIDGE_COMMANDS].join(', ')}` });
        }
        reply(200, compose.raw(args, { input: input ?? undefined }));
      } catch (e) {
        reply(400, { error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const posix = (p) => p.split(path.sep).join('/');

/**
 * Run Playwright with these arguments in the runner container.
 * @param {any} config the resolved config
 * @param {string[]} playwrightArgs
 * @returns {Promise<number>} the exit code
 */
export async function runInDocker(config, playwrightArgs) {
  const { compose, image } = dockerReady(config);
  ensureImage(image);
  const desktop = isDockerDesktop();
  const token = randomBytes(24).toString('hex');
  const bridge = await startBridge(compose, token);
  const bridgePort = bridge.address().port;
  const hostFromContainer = desktop ? 'host.docker.internal' : '127.0.0.1';
  const root = config.paths.root;
  const project = `/work/${posix(path.relative(root, config.paths.project))}`;
  const out = `/work/${posix(path.relative(root, config.paths.out))}`;
  // The container's own node_modules, in a volume: the host needs no npm
  // for a run in Docker, and modules installed for Windows never meet Linux.
  const modulesVolume = `${compose.project}-runner-modules`;

  const args = [
    'run', '--rm', '--init', '--ipc=host',
    '--label', `${runnerLabel(config)}=1`,
    '--mount', `type=bind,source=${root},target=/work`,
    '--mount', `type=bind,source=${PACKAGE_DIR},target=/qa-cockpit,readonly`,
    '--mount', `type=volume,source=${modulesVolume},target=${project}/node_modules`,
    '-w', project,
    '-e', 'CI=1',
    '-e', 'QA_OUTPUT_DIR=/tmp/qa-results',
    '-e', `QA_RESULTS_TO=${out}/test-results`,
    '-e', `QA_BRIDGE_URL=http://${hostFromContainer}:${bridgePort}`,
    '-e', `QA_BRIDGE_TOKEN=${token}`,
  ];
  if (desktop) {
    args.push('--network', stackNetwork(compose.project), '-e', `QA_FORWARD=${compose.forwards()}`);
  } else {
    // The host's network: localhost is the host's. Files written to the
    // mount belong to whoever runs this, not to root.
    const { uid, gid } = os.userInfo();
    // A new volume belongs to root: hand it to this user once.
    spawnSync('docker', ['run', '--rm', '--mount', `type=volume,source=${modulesVolume},target=/m`, image, 'chown', `${uid}:${gid}`, '/m'], {
      windowsHide: true,
    });
    args.push('--network', 'host', '--user', `${uid}:${gid}`, '-e', 'HOME=/tmp');
  }
  if (process.env.COCKPIT_URL) {
    const u = new URL(process.env.COCKPIT_URL);
    args.push('-e', `COCKPIT_URL=http://${hostFromContainer}:${u.port}`, '-e', `COCKPIT_RUN=${process.env.COCKPIT_RUN ?? ''}`);
  }
  // The suite being run: the device its sessions are signed in on (devices.mjs);
  // and whether its screens are looked at for accessibility (a11y.mjs), and
  // in which other languages (languages.mjs). A round of `replay --chaos`
  // (chaos.mjs): its seed, and its log where the container sees it.
  for (const name of ['QA_SUITE', 'QA_RUN_ID', 'QA_A11Y', 'QA_LANGUAGES', 'QA_REALTIME', 'QA_CHAOS']) if (process.env[name]) args.push('-e', `${name}=${process.env[name]}`);
  if (process.env.QA_CHAOS_LOG) args.push('-e', `QA_CHAOS_LOG=/work/${posix(path.relative(root, process.env.QA_CHAOS_LOG))}`);
  args.push(image, 'node', '/qa-cockpit/src/docker/runner-entry.mjs', ...playwrightArgs);

  console.log(`Playwright in ${image} (${desktop ? 'Docker Desktop, the stack\'s network' : 'host network'})`);
  const child = spawn('docker', args, { stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  bridge.close();
  return code;
}
