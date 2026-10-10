// The name of one of the app's languages (`languages` in the project's
// config), the same on the page and in the CLI: the project's own
// (`languages.names`), for a language no browser names (tlh, a house variant
// like ca-valencia); failing that, the one Intl knows; last of all, its code.

/**
 * @param {string} code
 * @param {{ names?: Record<string, string | Record<string, string>> | null, ui?: string, locale?: string }} [o]
 *   the config's names; the interface's language, the one a name by
 *   language is chosen in (the cockpit's, `en` for the CLI); the locale
 *   Intl names it in
 * @returns {string}
 */
export function languageName(code, { names, ui = 'en', locale = ui } = {}) {
  const own = names?.[code];
  if (typeof own === 'string') return own;
  const said = own && (own[ui] ?? own[ui.split('-')[0]] ?? own.en);
  if (said) return said;
  // Intl's answer is none when it only gives the code back.
  const known = intlName(code, locale);
  if (known) return known;
  return (own && Object.values(own)[0]) || code;
}

/** The name Intl knows a language by, in a locale; null when it knows none. */
export function intlName(code, locale = 'en') {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}
