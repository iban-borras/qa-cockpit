// On Windows, the parent of a stack that is one process (process.mjs).
//
// A stack started detached has no console there, and every console program
// it starts then opens a window of its own: `cmd.exe` for `npm` or `python`,
// and below it the stack's own children (an API, Vite...), each writing in
// its window instead of the log. This launcher is started detached in its
// place, without a window and with no console of its own; it starts the stack
// with a console that has no window, which the stack's children share, and
// writes the stack's output into the log. It ends with the stack, and
// stopping the stack (`taskkill /T` on its pid) ends it too.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const { QA_STACK_LAUNCH, ...env } = process.env;
const { command, args, shell, log } = JSON.parse(QA_STACK_LAUNCH ?? '{}');
const out = fs.createWriteStream(log, { flags: 'a' });
// Piped, not handed the log's handle: only then is its console made without
// a window (libuv's CREATE_NO_WINDOW).
const stack = spawn(command, args, { env, shell, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
stack.stdout.pipe(out, { end: false });
stack.stderr.pipe(out, { end: false });
// A command that cannot start says so in the log ('error', and then perhaps 'close').
let ended = false;
const end = (text, code) => {
  if (ended) return;
  ended = true;
  out.end(text, () => process.exit(code));
};
stack.on('error', (e) => end(`${e.message}\n`, 1));
stack.on('close', (code) => end('', code ?? 1));
