// The project's own package manager: npm, pnpm, yarn or bun. QA Cockpit
// installs nothing of its own: it checks that the project's node_modules
// match its lockfile, and heals them with the project's own manager.
//
// Which manager: a `packageManager` field ("pnpm@9.12.0") in the project's
// package.json or one above it, else the lockfile in the project's folder
// or, in a workspace, the nearest one above it, up to the repository's
// root; npm when there is none. A shell alias (`npm` that runs pnpm) never
// reaches a child process: the lockfile says, not the word a person typed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const LOCKFILES = [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

// What each manager leaves in node_modules after an install: newer than the
// lockfile, the install followed it. npm keeps a copy of the lockfile
// instead (.package-lock.json), compared entry by entry.
const INSTALLED_MARK = {
  pnpm: ['.modules.yaml'],
  yarn: ['.yarn-state.yml', '.yarn-integrity'],
  bun: [],
};

// For the managers other than npm, QA Cockpit notes the lockfile it last
// saw installed: an install that changed nothing at the top of node_modules
// leaves the managers' own marks older than the lockfile.
const OUR_MARK = '.qa-cockpit-deps.json';

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const inside = (root, dir) => {
  const rel = path.relative(root, dir);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * @param {any} config the resolved config
 * @returns {{ name: 'npm'|'pnpm'|'yarn'|'bun', dir: string, lockfile: string | null, berry: boolean }}
 *   `dir` holds the lockfile and the node_modules it installs (the project's
 *   own folder when there is no lockfile yet)
 */
export function packageManager(config) {
  const project = config.paths.project;
  const dirs = [project];
  for (let d = project; inside(config.paths.root, d) && path.dirname(d) !== d && d !== config.paths.root; ) {
    d = path.dirname(d);
    dirs.push(d);
  }
  let declared = null;
  for (const d of dirs) {
    declared ??= /^(npm|pnpm|yarn|bun)@([^+]*)/.exec(readJson(path.join(d, 'package.json'))?.packageManager ?? '');
  }
  const wanted = declared?.[1] ?? null;
  for (const dir of dirs) {
    for (const [file, name] of LOCKFILES) {
      if (wanted && name !== wanted) continue;
      if (!fs.existsSync(path.join(dir, file))) continue;
      const berry = name === 'yarn' && (fs.existsSync(path.join(dir, '.yarnrc.yml')) || Number(declared?.[2]?.split('.')[0]) >= 2);
      return { name, dir, lockfile: path.join(dir, file), berry };
    }
  }
  const name = wanted ?? 'npm';
  return { name, dir: project, lockfile: null, berry: name === 'yarn' && Number(declared?.[2]?.split('.')[0]) >= 2 };
}

const hashOf = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mtime = (file) => fs.statSync(file).mtimeMs;

/** Whether the project can load its own @playwright/test. */
function playwrightResolves(config) {
  try {
    createRequire(path.join(config.paths.project, 'package.json')).resolve('@playwright/test/package.json');
    return true;
  } catch {
    return false;
  }
}

/**
 * Why the project's node_modules do not match its lockfile, or null when
 * they do.
 * @param {any} config the resolved config
 */
export function depsStale(config) {
  const pm = packageManager(config);
  const modules = path.join(pm.dir, 'node_modules');
  if (pm.name === 'yarn' && fs.existsSync(path.join(pm.dir, '.pnp.cjs'))) {
    throw new Error(
      "Yarn's Plug'n'Play keeps no node_modules, and Playwright's runner needs them: " +
        `set \`nodeLinker: node-modules\` in ${path.join(pm.dir, '.yarnrc.yml')} and install again.`,
    );
  }
  if (!pm.lockfile) return `no lockfile yet (${pm.name})`;
  const lock = path.basename(pm.lockfile);
  if (!fs.existsSync(modules)) return `node_modules has never been installed from ${lock}`;
  if (!playwrightResolves(config)) return '@playwright/test is not installed';
  if (pm.name === 'npm') {
    const want = readJson(pm.lockfile)?.packages;
    const have = readJson(path.join(modules, '.package-lock.json'))?.packages;
    if (!want) return `unreadable ${lock}`;
    if (!have) return `node_modules has never been installed from ${lock}`;
    for (const [key, entry] of Object.entries(want)) {
      if (key === '' || entry.optional || entry.link) continue;
      if (have[key]?.version !== entry.version) return `${key} is missing or not ${entry.version}`;
    }
    return null;
  }
  const ours = readJson(path.join(modules, OUR_MARK));
  if (ours?.lockfile === lock && ours.sha256 === hashOf(pm.lockfile)) return null;
  // Installed by a person, after the lockfile last changed: take it as it is.
  const theirs = INSTALLED_MARK[pm.name].map((f) => path.join(modules, f)).find((f) => fs.existsSync(f));
  if (!ours && theirs && mtime(theirs) >= mtime(pm.lockfile)) {
    markInstalled(pm);
    return null;
  }
  return `${lock} changed since node_modules were installed`;
}

function markInstalled(pm) {
  if (pm.name === 'npm' || !pm.lockfile) return;
  const file = path.join(pm.dir, 'node_modules', OUR_MARK);
  try {
    fs.writeFileSync(file, JSON.stringify({ lockfile: path.basename(pm.lockfile), sha256: hashOf(pm.lockfile) }) + '\n');
  } catch {
    // Nothing to mark: the next check installs once more.
  }
}

/** The command that installs the project as its lockfile says (or makes one). */
export function installCommand(pm) {
  const frozen = Boolean(pm.lockfile);
  const flag = { npm: null, pnpm: '--frozen-lockfile', yarn: pm.berry ? '--immutable' : '--frozen-lockfile', bun: '--frozen-lockfile' }[pm.name];
  if (pm.name === 'npm') return { cmd: 'npm', args: [frozen ? 'ci' : 'install'] };
  return { cmd: pm.name, args: ['install', ...(frozen ? [flag] : [])] };
}

// Windows starts npm, pnpm, yarn and bun through their .cmd shims, which
// only a shell finds. A shell takes one command line (Node warns about
// arguments passed beside it); these words are all ours, none a person's.
const run = (cmd, args, options) =>
  process.platform === 'win32'
    ? spawnSync([cmd, ...args].join(' '), { ...options, shell: true })
    : spawnSync(cmd, args, options);

/**
 * Install the project with its own manager, where its lockfile is. Throws
 * with what to do when the manager is not on this machine or fails.
 * @param {any} config the resolved config
 * @param {string} why what depsStale said
 */
export function installDeps(config, why) {
  const pm = packageManager(config);
  const { cmd, args } = installCommand(pm);
  if (run(cmd, ['--version'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    const lock = pm.lockfile ? path.basename(pm.lockfile) : `package.json's packageManager`;
    throw new Error(`${cmd} is not on this machine's PATH, and ${lock} says the project uses it: install it (or \`corepack enable\`), then try again.`);
  }
  console.log(`Dependencies out of date (${why}): ${cmd} ${args.join(' ')} in ${pm.dir}...`);
  const r = run(cmd, args, { cwd: pm.dir, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${pm.dir}.`);
  markInstalled(packageManager(config));
}

/** Where a module of the project's Playwright is, through the chain that owns it. */
function requireFrom(config, ...chain) {
  let req = createRequire(path.join(config.paths.project, 'package.json'));
  let found = null;
  for (const name of chain) {
    found = req.resolve(`${name}/package.json`);
    req = createRequire(found);
  }
  return path.dirname(found);
}

/** Playwright's command line, from the project's own @playwright/test. */
export function playwrightCli(config) {
  return createRequire(path.join(config.paths.project, 'package.json')).resolve('@playwright/test/cli');
}

/**
 * The project's playwright-core, which pnpm keeps out of the project's own
 * node_modules: reached from @playwright/test, as Playwright itself does.
 */
export function playwrightCoreDir(config) {
  try {
    return requireFrom(config, 'playwright-core');
  } catch {
    return requireFrom(config, '@playwright/test', 'playwright', 'playwright-core');
  }
}
