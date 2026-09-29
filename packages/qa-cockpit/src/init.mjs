// `npx qa-cockpit init [folder] [--claude]`: a project's QA Cockpit folder
// from the templates, ready for a person or an agent to make true for the
// app. It never overwrites: a file that exists is kept and said so.
//
// What it writes, in <folder> (default `qa`):
//   qa-cockpit.config.mjs  the contract, every hook a TODO that says what it must do
//   fixtures.mjs, playwright.config.mjs, sessions.setup.mjs, package.json, .gitignore
//   suites/README.md       the guide to writing a suite; suites/example.md
//   setups/example.setup.mjs, recordings/
//   SKILL.md               how agents set it up, run, record and heal
// and, at the repo's root, a section in AGENTS.md that points to SKILL.md
// (with --claude, also a .claude/skills/qa-cockpit/SKILL.md that does).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATES = path.join(PACKAGE_DIR, 'templates');
const posix = (p) => p.split(path.sep).join('/');

/** The repository around a folder: the nearest parent with .git, or the folder. */
function repoRoot(from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return from;
  }
}

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** @param {string[]} args */
export async function init(args) {
  const claude = args.includes('--claude');
  const folder = args.find((a) => !a.startsWith('--')) ?? 'qa';
  const target = path.resolve(folder);
  if (fs.existsSync(path.join(target, 'qa-cockpit.config.mjs'))) {
    console.error(`${target} has a qa-cockpit.config.mjs already: nothing written.`);
    process.exit(1);
  }
  const root = repoRoot(path.dirname(target));
  const name = path.basename(root);
  const vars = {
    NAME: name,
    PROJECT: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app',
    ROOT: posix(path.relative(target, root)) || '.',
    DIR: posix(path.relative(root, target)) || '.',
  };
  const written = [];
  const kept = [];
  const put = (rel, content) => {
    const file = path.join(target, rel);
    if (fs.existsSync(file)) return kept.push(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    written.push(rel);
  };

  // The project's files, from templates/project (`gitignore` becomes
  // `.gitignore`: npm leaves dotfiles named .gitignore out of a package).
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const rel = path.relative(path.join(TEMPLATES, 'project'), abs).replace(/(^|[\\/])gitignore$/, '$1.gitignore');
        put(rel, fill(fs.readFileSync(abs, 'utf8'), vars));
      }
    }
  };
  walk(path.join(TEMPLATES, 'project'));
  put('SKILL.md', fs.readFileSync(path.join(TEMPLATES, 'SKILL.md'), 'utf8'));

  // package.json: Playwright and this package. From npm, a version range;
  // from a checkout of the package, a link to it.
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const fromNpm = PACKAGE_DIR.split(path.sep).includes('node_modules');
  put(
    'package.json',
    JSON.stringify(
      {
        name: `${vars.PROJECT}-qa`,
        private: true,
        type: 'module',
        scripts: { qa: 'qa-cockpit' },
        devDependencies: {
          '@playwright/test': '^1.50.0',
          'qa-cockpit': fromNpm ? `^${pkg.version}` : `file:${posix(path.relative(target, PACKAGE_DIR))}`,
        },
      },
      null,
      2,
    ) + '\n',
  );

  // AGENTS.md at the root: the section that sends every agent to SKILL.md.
  const agents = path.join(root, 'AGENTS.md');
  const section = fill(fs.readFileSync(path.join(TEMPLATES, 'AGENTS.section.md'), 'utf8'), vars);
  const had = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : null;
  if (had?.includes('QA Cockpit')) kept.push('AGENTS.md (it names QA Cockpit already)');
  else {
    fs.writeFileSync(agents, had ? `${had.trimEnd()}\n\n${section}` : `# AGENTS.md\n\n${section}`);
    written.push(posix(path.relative(target, agents)));
  }
  if (claude) {
    const stub = path.join(root, '.claude', 'skills', 'qa-cockpit', 'SKILL.md');
    if (fs.existsSync(stub)) kept.push(posix(path.relative(target, stub)));
    else {
      fs.mkdirSync(path.dirname(stub), { recursive: true });
      fs.writeFileSync(
        stub,
        `---\nname: qa-cockpit\ndescription: Set up, run, record and heal multi-person Playwright suites with QA Cockpit.\n---\n\nRead and follow \`${vars.DIR}/SKILL.md\`.\n`,
      );
      written.push(posix(path.relative(target, stub)));
    }
  }

  console.log(`QA Cockpit in ${target}`);
  for (const f of written) console.log(`  wrote  ${f}`);
  for (const f of kept) console.log(`  kept   ${f}`);
  console.log(`
Next:
  cd ${folder}
  npm install          (or pnpm, yarn, bun: QA Cockpit follows the lockfile)
  npx playwright install chromium
  Fill the TODOs of qa-cockpit.config.mjs (or ask your agent: «Set QA Cockpit up
  for this project following ${vars.DIR}/SKILL.md»), then:
  npx qa-cockpit doctor
`);
}
