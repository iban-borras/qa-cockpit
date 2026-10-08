// WHAT THE STACK'S DATA IS NOW, as far as this package knows. Every reset,
// setup and replay goes through the CLI (the cockpit's buttons included),
// and each one writes here what it leaves behind: <out>/stack-data.json.
//
// A recording needs its suite's setup just before it. A replay after
// anything else fails for no fault of the app: after another replay (its
// tests send, delete, sign people out), after a reset, after another
// suite's setup. It happened: a Replay after a Full run whose last test
// deletes an account waited four minutes for a person who no longer
// existed. So the cockpit asks before such a replay, and the CLI warns.
//
// Advisory only: what changes the data outside the CLI (a script, a hand in
// the database) is not seen. A person playing by hand in a window of the
// cockpit's («Play as») is: their first action notes it.
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{ state: 'resetting' | 'reset' | 'setting-up' | 'setup' | 'spent' | 'played', suite?: string | null, who?: string, at: string }} StackData */

export const dataFileOf = (config) => path.join(config.paths.out, 'stack-data.json');

/** @returns {StackData | null} */
export function readData(config) {
  try {
    return JSON.parse(fs.readFileSync(dataFileOf(config), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {{ state: StackData['state'], suite?: string | null, who?: string }} data */
export function noteData(config, data) {
  try {
    fs.mkdirSync(config.paths.out, { recursive: true });
    fs.writeFileSync(dataFileOf(config), JSON.stringify({ suite: null, ...data, at: new Date().toISOString() }));
  } catch {
    // A note that cannot be written must not stop the command it describes.
  }
}

/**
 * Why a replay of the suite would not find its setup's data, or null when
 * it would (or when nothing is known: no warning is better than a wrong one).
 * @returns {null | { code: 'spent' | 'played' | 'reset' | 'other_setup' | 'setup_unfinished', suite: string | null, who?: string, at: string }}
 */
export function staleFor(data, suite) {
  if (!data?.state) return null;
  if (data.state === 'setup' && data.suite === suite) return null;
  const code =
    data.state === 'spent' || data.state === 'played'
      ? data.state
      : data.state === 'setup'
        ? 'other_setup'
        : data.state === 'setting-up'
          ? 'setup_unfinished'
          : 'reset';
  return { code, suite: data.suite ?? null, who: data.who, at: data.at };
}

/** The same, in a line for a terminal. */
export function staleLine(why) {
  const when = new Date(why.at).toLocaleString();
  const what = {
    spent: `a replay of «${why.suite}» changed it (${when})`,
    played: `somebody played as ${why.who ?? 'a person'} by hand («Play as», ${when})`,
    reset: `it was reset (${when}) and no setup ran since`,
    other_setup: `the last setup was «${why.suite}»'s (${when})`,
    setup_unfinished: `the setup of «${why.suite}» did not finish (${when})`,
  }[why.code];
  return `The stack's data is not this suite's setup: ${what}.`;
}
