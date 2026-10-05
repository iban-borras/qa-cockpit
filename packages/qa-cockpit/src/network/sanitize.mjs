// A HAR as it may leave a run: every request, with its secrets taken out.
//
// A HAR is made to be read and passed on (to an agent, which sends what it
// reads to its model; to a colleague; to a performance tool), and
// Playwright's carries everything the browser sent and received: the
// session cookie, the bearer token, a password typed in a form, a signed
// URL. A QA copy's secrets open nothing outside this machine, but the same
// file from a stack pointed somewhere it should not be, or with a key of a
// real service in it, would. So only the clean HAR is ever written to the
// project: the raw one stays in the system's temporary files until this
// module has read it (network/capture.mjs).
//
// A secret becomes REDACTED-<id>: one id per value, the same in every test
// and person of a run (a keyed hash; the key is the run's own and is never
// written), so a reader still sees that one token went on forty calls, or
// that it changed after a refresh. Timings, sizes, statuses and every URL's
// shape stay: what a look at the network needs.
//
// What counts as a secret:
//   - the values of cookies (their names and attributes stay), of the
//     Authorization headers (their scheme stays: «Bearer REDACTED-…»), and
//     of any header, query parameter, form field or JSON key named like one
//     (a token, a secret, a password, an API key, a session id, a signature,
//     a CSRF token...);
//   - anything shaped like a JWT, or after «Bearer », anywhere;
//   - a value found secret once, wherever else it shows (a token echoed in a
//     URL, a page, a response), as it is or URL-encoded;
//   - this machine's own secrets where they show: the environment's tokens,
//     secrets, passwords and keys, and the cast's passwords.
// Response bodies are kept only when asked (`--bodies`), and only the text
// of the app's own calls and pages: JSON key by key, other text by the
// rules above.
import { createHmac, randomBytes } from 'node:crypto';

const PLACEHOLDER = /^REDACTED-[0-9a-f]{8}$/;

// A word that makes a name secret wherever it stands («accessToken»,
// «client_secret», «X-CSRF-Token», «connect.sid»).
const SECRET_WORDS = new Set([
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'csrf',
  'cvc',
  'cvv',
  'jwt',
  'otp',
  'passphrase',
  'passwd',
  'password',
  'passwords',
  'pin',
  'pwd',
  'secret',
  'secrets',
  'sid',
  'signature',
  'token',
  'tokens',
  'totp',
  'xsrf',
]);
// The same, inside a name written in one piece («PHPSESSID», «csrftoken»,
// «apikey»).
const SECRET_PIECES = [
  'password',
  'passwd',
  'secret',
  'token',
  'csrf',
  'xsrf',
  'apikey',
  'sessid',
  'sessionid',
  'privatekey',
  'accesskey',
  'secretkey',
  'cardnumber',
  'jwt',
];
// A «key» is a secret after one of these («api_key», «Ocp-Apim-Subscription-Key»),
// not after any word («sortKey», «cacheKey»).
const KEY_KINDS = new Set([
  'access',
  'api',
  'app',
  'auth',
  'client',
  'consumer',
  'encryption',
  'license',
  'master',
  'private',
  'publishable',
  'secret',
  'sentry',
  'session',
  'shared',
  'signing',
  'subscription',
]);
// Alone, in a URL: Google's «?key=», OAuth's «?code=», a signature.
const ALONE_IN_URLS = new Set(['key', 'code', 'sig', 'session']);

/** «accessToken», «X-Api-Key», «client_secret» → their words, lowercase. */
function words(name) {
  return String(name)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
}

/**
 * Whether a header, a parameter, a field or a JSON key holds a secret.
 * @param {string} name
 * @param {'url' | 'other'} [where] in a URL's query, single words count too
 */
export function secretName(name, where = 'other') {
  const w = words(name);
  if (!w.length) return false;
  if (w.some((x) => SECRET_WORDS.has(x))) return true;
  const joined = w.join('');
  if (SECRET_PIECES.some((piece) => joined.includes(piece))) return true;
  for (let i = 1; i < w.length; i++) if (w[i] === 'key' && KEY_KINDS.has(w[i - 1])) return true;
  const s = w.indexOf('session');
  if (s !== -1 && (w.length === 1 || ['id', 'key', 'token', 'secret'].includes(w[s + 1]))) return true;
  if (w.includes('card') && w.includes('number')) return true;
  return where === 'url' && w.length === 1 && ALONE_IN_URLS.has(w[0]);
}

/** An environment variable that holds a secret: «STRIPE_SECRET_KEY», «DB_PASS». */
function secretEnv(name) {
  const parts = String(name).toUpperCase().split('_').filter(Boolean);
  // PWD is the working folder, not a password.
  if (parts.length === 1 && (parts[0] === 'PWD' || parts[0] === 'OLDPWD')) return false;
  if (parts.some((p) => /TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|CREDENTIAL/.test(p))) return true;
  return parts.length > 1 && parts.some((p) => p === 'PASS' || p === 'PWD' || p === 'KEY');
}

/**
 * This machine's own secrets, to take out wherever they show: the
 * environment's (a `.env` beside the config included, once loaded) and the
 * cast's passwords. Values shorter than 8 characters are left out: they
 * would take out common words too, and the rules by name catch them.
 * @param {{ cast?: object[] }} [config] the resolved config
 * @param {Record<string, string | undefined>} [env]
 */
export function machineSecrets(config, env = process.env) {
  const found = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('QA_NETWORK_')) continue;
    if (value && value.length >= 8 && secretEnv(name)) found.add(value);
  }
  for (const person of config?.cast ?? []) {
    for (const [key, value] of Object.entries(person ?? {})) {
      if (typeof value === 'string' && value.length >= 8 && secretName(key)) found.add(value);
    }
  }
  return [...found];
}

/**
 * What turns a secret into its placeholder, keeping one id per value.
 * @param {string} [salt] the run's own key: the same value gets the same id in every file of the run
 */
export function redactor(salt = randomBytes(16).toString('hex')) {
  /** @type {Map<string, string>} */
  const ids = new Map();
  const redact = (value) => {
    const v = String(value ?? '');
    // An empty value is no secret: a cookie cleared on sign-out says so.
    if (!v || PLACEHOLDER.test(v)) return v;
    let id = ids.get(v);
    if (!id) {
      id = `REDACTED-${createHmac('sha256', salt).update(v).digest('hex').slice(0, 8)}`;
      ids.set(v, id);
    }
    return id;
  };
  return { redact, ids };
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** `a=1&token=x`: the values of the secret names replaced. */
function cleanPairs(query, redact) {
  return query
    .split('&')
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i === -1) return pair;
      const value = pair.slice(i + 1);
      return value && secretName(decode(pair.slice(0, i)), 'url') ? `${pair.slice(0, i)}=${redact(decode(value))}` : pair;
    })
    .join('&');
}

/**
 * A URL with its secrets out: the query's and the fragment's secret values,
 * and a user and password before the host. Everything else stays as it
 * was, byte for byte, so the same URL stays the same.
 */
export function cleanUrl(s, redact) {
  if (typeof s !== 'string' || /\s/.test(s)) return s;
  const absolute = /^([a-z][a-z\d+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
  const relative = absolute ? null : /^()()(\/[^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
  const m = absolute ?? relative;
  if (!m) return s;
  let [, scheme, authority, rest, query = '', hash = ''] = m;
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = `${redact(authority.slice(0, at))}@${authority.slice(at + 1)}`;
  if (query) query = `?${cleanPairs(query.slice(1), redact)}`;
  // OAuth's implicit flow puts its token in the fragment: «#access_token=…».
  if (hash.includes('=')) hash = `#${cleanPairs(hash.slice(1), redact)}`;
  return scheme + authority + rest + query + hash;
}

// Headers whose value is a URL, or holds some.
const URL_HEADERS = new Set([':path', 'referer', 'location', 'content-location']);

function cookiePair(pair, redact) {
  const i = pair.indexOf('=');
  return i === -1 ? pair : `${pair.slice(0, i)}=${redact(pair.slice(i + 1))}`;
}

function cleanHeader(header, redact) {
  const name = String(header.name ?? '').toLowerCase();
  let value = String(header.value ?? '');
  if (name === 'cookie') {
    value = value.split(';').map((pair) => cookiePair(pair, redact)).join(';');
  } else if (name === 'set-cookie') {
    // One line per cookie when the browser joined them; their attributes
    // (Path, HttpOnly, SameSite, Max-Age) stay: they are part of a look.
    value = value
      .split('\n')
      .map((line) => {
        const [first, ...attributes] = line.split(';');
        return [cookiePair(first, redact), ...attributes].join(';');
      })
      .join('\n');
  } else if (name === 'authorization' || name === 'proxy-authorization') {
    const m = /^(\S+)(\s+)(.+)$/.exec(value);
    value = m ? `${m[1]}${m[2]}${redact(m[3])}` : redact(value);
  } else if (URL_HEADERS.has(name)) {
    value = cleanUrl(value, redact);
  } else if (name === 'link') {
    value = value.replace(/<([^>]*)>/g, (_, url) => `<${cleanUrl(url, redact)}>`);
  } else if (!/^(access-control-|sec-)/.test(name) && name !== 'www-authenticate' && secretName(name)) {
    value = redact(value);
  }
  return { ...header, value };
}

/** The secret values of a JSON document: strings and numbers under a secret key. */
function secretsOfJson(data, redact) {
  const strings = new Set();
  const numbers = new Set();
  const walk = (node, secret) => {
    if (Array.isArray(node)) {
      // A list under a secret key is a list of secrets; a list of objects
      // has keys of its own to say.
      for (const item of node) walk(item, secret);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, secretName(key));
    } else if (secret && typeof node === 'string' && node && !PLACEHOLDER.test(node)) {
      strings.add(node);
    } else if (secret && typeof node === 'number') {
      numbers.add(node);
    }
  };
  walk(data, false);
  // Every one gets its id now: a value found here is taken out of the rest
  // of the file too (sanitizeHar).
  for (const s of strings) redact(s);
  return { strings, numbers };
}

function cleanJsonValue(node, redact, secret = false) {
  if (Array.isArray(node)) return node.map((item) => cleanJsonValue(item, redact, secret));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, cleanJsonValue(value, redact, secretName(key))]));
  }
  if (secret && (typeof node === 'string' || typeof node === 'number')) return redact(String(node));
  return node;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A JSON text with its secret values replaced where they stand, so its
 * numbers and its layout stay as they came; or `null` when it is not JSON.
 * Only values are replaced, never a key that happens to read the same.
 * Where a value is written another way (a «\/» some servers escape), the
 * document is written again from its parsed form instead: never a secret
 * left behind for the sake of the layout.
 */
function cleanJsonText(text, redact) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const { strings, numbers } = secretsOfJson(data, redact);
  if (!strings.size && !numbers.size) return text;
  let out = text;
  // A value stands after «:», «[» or «,», and before «,», «}» or «]». A
  // short one («1», «abc») would be replaced under every key that has it:
  // left for the fallback below, which replaces it under its own key only.
  const asValue = (literal, by) => {
    if (literal.replace(/"/g, '').length < 4) return;
    out = out.replace(new RegExp(`([:\\[,]\\s*)${escapeRe(literal)}(?=\\s*[,}\\]])`, 'g'), (_, before) => before + by);
  };
  for (const s of strings) asValue(JSON.stringify(s), JSON.stringify(redact(s)));
  for (const n of numbers) asValue(String(n), JSON.stringify(redact(String(n))));
  try {
    const left = secretsOfJson(JSON.parse(out), () => '');
    if (left.strings.size || left.numbers.size) return JSON.stringify(cleanJsonValue(data, redact));
  } catch {
    return JSON.stringify(cleanJsonValue(data, redact));
  }
  return out;
}

/** An <input> or a <meta> whose name says secret: its value or content out. */
function cleanTag(tag, redact) {
  const attribute = (name) => new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
  const name = attribute('name') ?? attribute('id') ?? attribute('property') ?? '';
  if (!secretName(name)) return tag;
  return tag.replace(/\b(value|content)(\s*=\s*)(["'])(.*?)\3/i, (all, a, eq, q, v) => (v ? `${a}${eq}${q}${redact(v)}${q}` : all));
}

/** Text that is not JSON: a page, a script, a stream, a form. */
function cleanText(text, redact) {
  return (
    text
      // `password: "…"`, `"apiKey" = '…'`, `token=\`…\``: in a script, a config inlined in a page.
      .replace(/(["']?)([A-Za-z_$][\w$.-]{0,63})\1(\s*[:=]\s*)(["'`])([^"'`\\\n]{1,2000})\4/g, (all, q, name, sep, quote, value) =>
        secretName(name) ? `${q}${name}${q}${sep}${quote}${redact(value)}${quote}` : all,
      )
      // <input type="hidden" name="_csrf" value="…">, <meta name="csrf-token" content="…">
      .replace(/<(?:input|meta)\b[^>]*>/gi, (tag) => cleanTag(tag, redact))
      // A link in the text: «?token=…&».
      .replace(/([?&#])([^=&#\s"'<>]{1,64})=([^&#\s"'<>]+)/g, (all, sep, name, value) =>
        secretName(decode(name), 'url') ? `${sep}${name}=${redact(decode(value))}` : all,
      )
  );
}

/** A form sent as multipart: «name="password"», its headers, a blank line, the value. */
function cleanMultipart(text, redact) {
  return text.replace(/(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/g, (all, head, name, value) =>
    value && secretName(name, 'url') ? `${head}${redact(value)}` : all,
  );
}

/** A body (a request's or a response's) by its type. */
export function cleanBody(text, mimeType, redact) {
  if (typeof text !== 'string' || !text) return text;
  const type = String(mimeType ?? '').toLowerCase();
  if (type.includes('json') || (/^\s*[[{]/.test(text) && !/html|xml/.test(type))) {
    const json = cleanJsonText(text, redact);
    if (json !== null) return json;
  }
  if (type.includes('x-www-form-urlencoded')) return cleanPairs(text, redact);
  if (type.includes('multipart/form-data')) return cleanText(cleanMultipart(text, redact), redact);
  return cleanText(text, redact);
}

const JWT = /\beyJ[\w-]{6,}\.eyJ[\w-]{6,}\.[\w-]{6,}/g;
const BEARER = /\b(Bearer\s+)([\w.~+/-]{8,}=*)/gi;
// Bodies kept with `--bodies`: the app's own calls and pages, as text.
const BODY_TYPES = new Set(['fetch', 'xhr', 'document', 'eventsource', 'websocket']);
const MAX_BODY = 1024 * 1024;

/**
 * Take the secrets out of a HAR, in place.
 * @param {any} har Playwright's HAR, as parsed
 * @param {{ salt?: string, known?: string[], bodies?: boolean }} [options]
 *   salt: the run's key (one id per value across its files); known: values
 *   to take out wherever they show (machineSecrets); bodies: keep the text
 *   of the app's own responses
 * @returns {{ har: any, secrets: number }} the HAR, and how many distinct values were taken out
 */
export function sanitizeHar(har, { salt, known = [], bodies = false } = {}) {
  const { redact, ids } = redactor(salt);
  const entries = har?.log?.entries ?? [];

  // By name and by place: what the structure says is secret.
  for (const e of entries) {
    const req = e.request ?? {};
    const res = e.response ?? {};
    if (req.url) req.url = cleanUrl(req.url, redact);
    req.headers = (req.headers ?? []).map((h) => cleanHeader(h, redact));
    req.cookies = (req.cookies ?? []).map((c) => ({ ...c, value: redact(c.value) }));
    req.queryString = (req.queryString ?? []).map((q) => (secretName(q.name, 'url') ? { ...q, value: redact(q.value) } : q));
    if (req.postData) {
      const post = req.postData;
      if (Array.isArray(post.params)) {
        post.params = post.params.map((p) => (p.value !== undefined && secretName(p.name, 'url') ? { ...p, value: redact(p.value) } : p));
      }
      if (post.text) post.text = cleanBody(post.text, post.mimeType, redact);
      delete post._file;
    }
    res.headers = (res.headers ?? []).map((h) => cleanHeader(h, redact));
    res.cookies = (res.cookies ?? []).map((c) => ({ ...c, value: redact(c.value) }));
    if (res.redirectURL) res.redirectURL = cleanUrl(res.redirectURL, redact);
    const content = res.content;
    if (content) {
      if (content.text !== undefined) {
        const keep = bodies && BODY_TYPES.has(e._resourceType) && content.encoding !== 'base64' && content.text.length <= MAX_BODY;
        if (keep) {
          content.text = cleanBody(content.text, content.mimeType, redact);
        } else {
          delete content.text;
          delete content.encoding;
          if (bodies) content.comment = 'Left out: only the text of the app’s calls and pages is kept, up to 1 MB.';
        }
      }
      delete content._file;
    }
    if (Array.isArray(e._webSocketMessages)) {
      e._webSocketMessages = bodies
        ? e._webSocketMessages.map((m) => ({ ...m, data: m.opcode === 1 ? cleanBody(String(m.data ?? ''), 'application/json', redact) : '' }))
        : undefined;
    }
  }

  // Then every string of the file: a JWT or a bearer token anywhere, a URL
  // anywhere, and every value found secret above or known to this machine,
  // wherever it shows again. A short value is left to the rules by name: it
  // would take out common words with it.
  const forms = [...new Set([...ids.keys(), ...known])]
    .filter((v) => typeof v === 'string' && v.length >= 8)
    .sort((a, b) => b.length - a.length)
    .map((v) => [v, [...new Set([v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1), v.replace(/\//g, '\\/')])]]);
  const scrub = (s) => {
    if (!s || PLACEHOLDER.test(s)) return s;
    let out = s.replace(JWT, (token) => redact(token)).replace(BEARER, (_, scheme, token) => scheme + redact(token));
    if (/^[a-z][a-z\d+.-]*:\/\/\S+$/i.test(out)) out = cleanUrl(out, redact);
    for (const [value, written] of forms) {
      for (const form of written) if (out.includes(form)) out = out.split(form).join(redact(value));
    }
    return out;
  };
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (typeof node[i] === 'string') node[i] = scrub(node[i]);
        else if (node[i] && typeof node[i] === 'object') walk(node[i]);
      }
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (typeof node[key] === 'string') node[key] = scrub(node[key]);
        else if (node[key] && typeof node[key] === 'object') walk(node[key]);
      }
    }
  };
  walk(har);

  if (har?.log) {
    har.log.comment =
      'Secrets taken out by QA Cockpit: the values of cookies, tokens, credentials and keys are REDACTED-<id>, one id per value within the run.';
  }
  return { har, secrets: ids.size };
}
