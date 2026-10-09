// The cockpit in many languages, one file each in i18n/. The server speaks
// in codes and values; every sentence a person reads is composed here. What
// the suites themselves say (their titles, their steps) is their content and
// stays in the language it was written in.
//
//   t('card.play_as', { name: 'Marta' })       → «Jugar com a Marta»
//   tn('note.count', 3)                         → «3 notes» (its plural form)
//   <span data-i18n="log.toggle"></span>        (filled by applyI18n)
//   <button data-i18n-aria="ins.close"></button>, data-i18n-title too
//
// A sentence a language does not have yet is said in English: a new one is
// written in Catalan, Spanish and English, and the others catch up later
// (scripts/i18n-check.mjs lists what each one is missing).
import ca from './i18n/ca.js';
import de from './i18n/de.js';
import en from './i18n/en.js';
import es from './i18n/es.js';
import fr from './i18n/fr.js';
import hi from './i18n/hi.js';
import it from './i18n/it.js';
import ja from './i18n/ja.js';
import pl from './i18n/pl.js';
import ptBR from './i18n/pt-BR.js';
import ru from './i18n/ru.js';
import tr from './i18n/tr.js';
import uk from './i18n/uk.js';
import zhCN from './i18n/zh-CN.js';

// By code, in the order the language menu shows them.
const DICT = { ca, de, en, es, fr, hi, it, ja, pl, 'pt-BR': ptBR, ru, tr, uk, 'zh-CN': zhCN };
export const LANGS = Object.keys(DICT);

// Each language's dates and numbers, and its plural forms.
export const LOCALES = {
  ca: 'ca-ES',
  de: 'de-DE',
  en: 'en-GB',
  es: 'es-ES',
  fr: 'fr-FR',
  hi: 'hi-IN',
  it: 'it-IT',
  ja: 'ja-JP',
  pl: 'pl-PL',
  'pt-BR': 'pt-BR',
  ru: 'ru-RU',
  tr: 'tr-TR',
  uk: 'uk-UA',
  'zh-CN': 'zh-CN',
};
const LOCALE = LOCALES;

// Each language by its own name, whatever the one in use.
const ENDONYM = {
  ca: 'Català',
  de: 'Deutsch',
  en: 'English',
  es: 'Castellano',
  fr: 'Français',
  hi: 'हिन्दी',
  it: 'Italiano',
  ja: '日本語',
  pl: 'Polski',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  tr: 'Türkçe',
  uk: 'Українська',
  'zh-CN': '简体中文',
};

function stored() {
  try {
    // The key before the package had its own name, kept so a choice survives.
    return localStorage.getItem('qa-cockpit-lang') ?? localStorage.getItem('ck-cockpit-lang');
  } catch {
    return null;
  }
}

// The browser's languages, in the person's order: the first one the cockpit
// speaks, as it is (pt-BR) or by its language alone (pt-PT finds pt-BR).
function guess() {
  const nav = globalThis.navigator; // none in Node (scripts/i18n-check.mjs)
  const wanted = nav?.languages?.length ? nav.languages : [nav?.language || 'en'];
  for (const w of wanted) {
    const exact = LANGS.find((l) => l.toLowerCase() === w.toLowerCase());
    if (exact) return exact;
    const near = LANGS.find((l) => l.split('-')[0] === w.split('-')[0].toLowerCase());
    if (near) return near;
  }
  return 'en';
}

let lang = LANGS.includes(stored()) ? stored() : guess();
// Values every sentence may use: {cli}, how this project runs the CLI, and
// {skill}, where its agents' instructions are. The server says them.
let globals = { cli: 'npx qa-cockpit', skill: 'the qa-cockpit skill' };

export const getLang = () => lang;
export const locale = () => LOCALE[lang];

/** The project's own words for {cli} and {skill}. */
export function setGlobals(vars) {
  globals = { ...globals, ...Object.fromEntries(Object.entries(vars).filter(([, v]) => v)) };
}

/** The project's language, when the person has not chosen one here. */
export function preferLang(code) {
  if (!stored() && LANGS.includes(code) && code !== lang) {
    lang = code;
    applyI18n();
  }
}

export function setLang(next) {
  if (!LANGS.includes(next)) return;
  lang = next;
  try {
    localStorage.setItem('qa-cockpit-lang', next);
  } catch {
    // A private window may refuse; the choice lasts the visit.
  }
  document.documentElement.lang = next;
  applyI18n();
}

function fill(text, vars) {
  const all = { ...globals, ...vars };
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in all ? String(all[name]) : m));
}

/** Names or words as the language lists them: «Alice, Bob i Carol», «Alice、Bob、Carol». */
export function listOf(items) {
  try {
    return new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** A text quoted the way the language quotes: «…», „…“, 「…」. */
export const quote = (s) => t('quote', { s });

/** A sentence in the current language, its {placeholders} filled. */
export function t(key, vars = {}) {
  return fill(DICT[lang][key] ?? DICT.en[key] ?? key, vars);
}

const rules = {};
const formOf = (code, n) => (rules[code] ??= new Intl.PluralRules(LOCALE[code])).select(n);

/**
 * A sentence that counts: `key` in the form the language gives n (key_one,
 * key_few, key_many…, key_other when it has no form of its own), {n} filled.
 */
export function tn(key, n, vars = {}) {
  const form = (code) => DICT[code][`${key}_${formOf(code, n)}`] ?? DICT[code][`${key}_other`];
  return fill(form(lang) ?? form('en') ?? key, { n, ...vars });
}

// The name Intl knows a language by, where its code alone says a country.
const NAMED_AS = { 'zh-CN': 'zh-Hans' };

/** A language by its own name. */
export const endonym = (code) => ENDONYM[code] ?? code;

/** A language by its name in the one in use, as a label (the menu): the dictionary's, or the browser's. */
export function langLabel(code) {
  const own = DICT[lang][`lang.${code}`];
  if (own) return own;
  try {
    const name = new Intl.DisplayNames([LOCALE[lang]], { type: 'language' }).of(NAMED_AS[code] ?? code) ?? code;
    return name.charAt(0).toLocaleUpperCase(LOCALE[lang]) + name.slice(1);
  } catch {
    return code;
  }
}

/** Fill every static text of the page: data-i18n, -title, -aria, -placeholder. */
export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
