#!/usr/bin/env node
// `npx qa-cockpit <command>`: finds the project's qa-cockpit.config.mjs (in
// this folder or the nearest parent, or the one QA_COCKPIT_CONFIG or
// `--config <file>` names) and runs the command against it. `init` needs no
// config: it writes one.
import { loadConfig } from '../src/config.mjs';
import { runCli } from '../src/cli.mjs';

let argv = process.argv.slice(2);
let file = process.env.QA_COCKPIT_CONFIG || null;
const at = argv.indexOf('--config');
if (at !== -1) {
  file = argv[at + 1];
  argv = argv.filter((_, i) => i !== at && i !== at + 1);
}

if (argv[0] === 'init') {
  const { init } = await import('../src/init.mjs');
  await init(argv.slice(1));
} else {
  let config;
  try {
    config = await loadConfig(file ?? process.cwd());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  await runCli(config, argv);
}
