// The cockpit's languages (src/server/public/i18n/), each against English:
//   - what a language is missing: the page says it in English meanwhile;
//   - errors: a key English does not have, a sentence with other
//     {placeholders} than English's, an empty one, a plural form the
//     language does not have, or one of the forms it needs missing while
//     the others are there.
// A sentence that counts (tn in i18n.js) is key_one, key_few, key_many…,
// key_other: the forms each language gives whole numbers, and _other.
//
//   node scripts/i18n-check.mjs              every language
//   node scripts/i18n-check.mjs fr de        only these
//   node scripts/i18n-check.mjs --strict     what is missing is an error too
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'server', 'public');
const { LANGS, LOCALES } = await import(pathToFileURL(path.join(PUBLIC, 'i18n.js')).href);
const dictOf = async (code) => (await import(pathToFileURL(path.join(PUBLIC, 'i18n', `${code}.js`)).href)).default;

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const asked = args.filter((a) => !a.startsWith('--'));
for (const code of asked) if (!LANGS.includes(code)) throw new Error(`No language «${code}» in i18n.js (${LANGS.join(', ')}).`);

const files = fs.readdirSync(path.join(PUBLIC, 'i18n')).map((f) => f.replace(/\.js$/, ''));
const unlisted = files.filter((f) => !LANGS.includes(f));
if (unlisted.length) throw new Error(`In i18n/ but not in i18n.js: ${unlisted.join(', ')}.`);

const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const en = await dictOf('en');
const placeholders = (s) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join(' ');
// key_other in English: a sentence that counts, by its key without the form.
const counting = new Set(Object.keys(en).filter((k) => k.endsWith('_other')).map((k) => k.slice(0, -'_other'.length)));
const formOf = (key) => {
  const m = /^(.+)_(zero|one|two|few|many|other)$/.exec(key);
  return m && counting.has(m[1]) ? { base: m[1], form: m[2] } : null;
};
// Other languages' names: a language names them by Intl unless it says.
const optional = (key) => /^lang\.(?!label$)/.test(key);
// Values the page gives a sentence besides English's: Catalan's «de» or
// «d'» before a name (cockpit.js, handOffLine).
const EXTRA = { 'handoff.from': ['{de}'] };
const placeholdersOf = (key, text) => placeholders(text.replace(/\{\w+\}/g, (m) => ((EXTRA[key] ?? []).includes(m) ? '' : m)));

/** The forms a language gives the whole numbers a page counts, and _other. */
function formsOf(code) {
  const rules = new Intl.PluralRules(LOCALES[code]);
  const forms = new Set(['other']);
  for (let n = 0; n <= 1000; n++) forms.add(rules.select(n));
  return FORMS.filter((f) => forms.has(f));
}

let failed = false;
for (const code of asked.length ? asked : LANGS.filter((l) => l !== 'en')) {
  const dict = await dictOf(code);
  const forms = formsOf(code);
  const errors = [];
  const missing = [];
  for (const [key, text] of Object.entries(dict)) {
    const f = formOf(key);
    const model = f ? en[`${f.base}_other`] : en[key];
    if (model === undefined) {
      if (!optional(key)) errors.push(`${key}: English has no such key`);
      continue;
    }
    if (f && !forms.includes(f.form)) errors.push(`${key}: ${code} has no «${f.form}» form (it has ${forms.join(', ')})`);
    if (typeof text !== 'string' || !text.trim()) errors.push(`${key}: empty`);
    else if (placeholdersOf(key, text) !== placeholders(model)) errors.push(`${key}: {placeholders} «${placeholders(text)}», English «${placeholders(model)}»`);
  }
  for (const key of Object.keys(en)) {
    const f = formOf(key);
    if (optional(key) || f) continue;
    if (!(key in dict)) missing.push(key);
  }
  for (const base of counting) {
    const have = forms.filter((form) => `${base}_${form}` in dict);
    if (!have.length) missing.push(`${base}_{${forms.join(',')}}`);
    else if (have.length < forms.length) errors.push(`${base}: forms ${forms.filter((x) => !have.includes(x)).join(', ')} missing (${code} has ${forms.join(', ')})`);
  }
  const total = Object.keys(en).filter((k) => !optional(k) && !formOf(k)).length + counting.size;
  const bad = errors.length || (strict && missing.length);
  if (bad) failed = true;
  console.log(`${bad ? '✗' : '✓'} ${code}: ${total - missing.length} of ${total} sentences${missing.length ? `, ${missing.length} missing (said in English)` : ''}${errors.length ? `, ${errors.length} errors` : ''}`);
  for (const e of errors) console.log(`    error  ${e}`);
  if (missing.length && (strict || asked.length)) for (const m of missing) console.log(`    missing  ${m}`);
}
process.exit(failed ? 1 : 0);
