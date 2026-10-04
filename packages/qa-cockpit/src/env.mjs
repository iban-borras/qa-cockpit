// What differs from one machine to the next lives in `.env`, beside the
// config, never committed: the port a developer's own server already takes
// on this machine, the one a container publishes on that one. The config
// is shared and reads them, each with its default:
//
//   import { defineConfig, loadEnv } from 'qa-cockpit';
//   loadEnv(import.meta.url);
//   const PORT = process.env.QA_APP_PORT ?? '4400';
//
// The real environment wins over the file: a CI, or a person, sets a value
// for one run. Every process that loads the config (the CLI, Playwright's
// workers, the cockpit) runs this line, so they all see the same values;
// docker compose, started by the CLI, sees them too, for a QA override's
// `${QA_APP_PORT:-5174}`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {Map<string, { file: string, values: Record<string, string>, applied: string[] }>} */
const loaded = new Map();

/**
 * The variables of a .env text: `KEY=value` lines, `#` comments, `export `
 * allowed, values bare, 'single-quoted' (as they are) or "double-quoted"
 * (\n, \" and \\ understood). A bare value ends at ` #`.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"')) {
      // Up to the first quote not escaped; what follows it (a comment) is dropped.
      let inside = '';
      for (let i = 1; i < value.length; i += 1) {
        const ch = value[i];
        if (ch === '\\' && i + 1 < value.length) {
          const next = value[(i += 1)];
          inside += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          continue;
        }
        if (ch === '"') break;
        inside += ch;
      }
      value = inside;
    } else if (value.startsWith("'")) {
      const end = value.lastIndexOf("'");
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Read the `.env` beside the config into process.env, leaving alone what
 * the environment sets already. Once per file and process.
 * @param {string} base the config's `import.meta.url`, or its folder
 * @param {string} [name] the file's name, `.env` by default
 * @returns {{ file: string, values: Record<string, string>, applied: string[] }}
 */
export function loadEnv(base, name = '.env') {
  const s = String(base);
  let dir = s.startsWith('file:') ? fileURLToPath(s) : path.resolve(s);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  else if (!fs.existsSync(dir) && path.extname(dir)) dir = path.dirname(dir);
  const file = path.join(dir, name);
  const known = loaded.get(file);
  if (known) return known;
  const values = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  const applied = [];
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }
  const entry = { file, values, applied };
  loaded.set(file, entry);
  return entry;
}

/** Every .env this process has read (for `doctor`). */
export function loadedEnvs() {
  return [...loaded.values()];
}
