// Two-person chat, browser side: vanilla JS, no build step.
const $ = (id) => document.getElementById(id);
let stream = null; // the EventSource while signed in
let shown = new Set(); // ids of the messages already in the list

// The app's words in three languages, changed from the header's menu with
// no reload; the choice stays in this browser. (QA Cockpit's `--languages`
// looks at each screen in the two the suite does not play in.)
const WORDS = {
  en: {
    signIn: 'Sign in', username: 'Username', password: 'Password', wrong: 'Wrong username or password.', cannotSignIn: 'Could not sign in. Try again.',
    signedIn: 'Signed in as {name}', signOut: 'Sign out', language: 'Language', messages: 'Messages', empty: 'No messages yet.', who: 'Who is here',
    message: 'Message', send: 'Send', writeFirst: 'Write something first.', cannotSend: 'Could not send. Try again.',
  },
  ca: {
    signIn: 'Entra', username: 'Usuari', password: 'Contrasenya', wrong: 'Usuari o contrasenya incorrectes.', cannotSignIn: "No s'ha pogut entrar. Torna-ho a provar.",
    signedIn: 'Has entrat com a {name}', signOut: 'Tanca la sessió', language: 'Idioma', messages: 'Missatges', empty: 'Encara no hi ha missatges.', who: 'Qui hi ha',
    message: 'Missatge', send: 'Envia', writeFirst: 'Escriu alguna cosa primer.', cannotSend: "No s'ha pogut enviar. Torna-ho a provar.",
  },
  es: {
    signIn: 'Entrar', username: 'Usuario', password: 'Contraseña', wrong: 'Usuario o contraseña incorrectos.', cannotSignIn: 'No se ha podido entrar. Vuelve a intentarlo.',
    signedIn: 'Has entrado como {name}', signOut: 'Cerrar sesión', language: 'Idioma', messages: 'Mensajes', empty: 'Todavía no hay mensajes.', who: 'Quién está',
    message: 'Mensaje', send: 'Enviar', writeFirst: 'Escribe algo primero.', cannotSend: 'No se ha podido enviar. Vuelve a intentarlo.',
  },
};
let lang = WORDS[localStorage.getItem('lang')] ? localStorage.getItem('lang') : 'en';
let me = null; // who is signed in, for «Signed in as»
const said = new Map(); // an error's element → the words it says
const say = (key, vars = {}) => WORDS[lang][key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function setError(id, key) {
  said.set(id, key);
  $(id).textContent = key ? say(key) : '';
}

function applyWords() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = say(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-aria]')) el.setAttribute('aria-label', say(el.dataset.tAria));
  $('whoami').textContent = me ? say('signedIn', { name: me.displayName }) : '';
  for (const [id, key] of said) $(id).textContent = key ? say(key) : $(id).textContent;
  $('lang').value = lang;
}

$('lang').addEventListener('change', () => {
  lang = $('lang').value;
  localStorage.setItem('lang', lang);
  applyWords();
});

async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = await fetch(path, init);
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

function show(user) {
  stream?.close();
  stream = null;
  $('signin').hidden = Boolean(user);
  $('bar').hidden = $('chat').hidden = !user;
  me = user;
  $('whoami').textContent = user ? say('signedIn', { name: user.displayName }) : '';
  if (user) return start();
  $('messages').replaceChildren();
  $('people').replaceChildren();
  $('username').focus();
}

// History first, then the live stream; ids dedupe the overlap.
async function start() {
  const { ok, data } = await api('/api/messages');
  if ($('chat').hidden) return; // signed out while loading
  if (!ok) return setTimeout(boot, 2000);
  shown = new Set();
  $('messages').replaceChildren();
  $('empty').hidden = false;
  data.messages.forEach(addMessage);
  const es = (stream = new EventSource('/api/events'));
  es.addEventListener('message', (e) => addMessage(JSON.parse(e.data)));
  es.addEventListener('presence', (e) => showPeople(JSON.parse(e.data)));
  es.onerror = () => {
    if (es !== stream || es.readyState !== EventSource.CLOSED) return; // still reconnecting
    stream = null;
    setTimeout(boot, 1000); // the server refused the stream: maybe signed out elsewhere
  };
  $('message').focus();
}

function addMessage(m) {
  if (shown.has(m.id)) return;
  shown.add(m.id);
  const name = document.createElement('strong');
  name.textContent = m.displayName;
  const li = document.createElement('li');
  li.append(name, `: ${m.text}`);
  $('messages').append(li);
  $('messages').scrollTop = $('messages').scrollHeight;
  $('empty').hidden = true;
}

function showPeople(users) {
  $('people').replaceChildren(...users.map((u) => Object.assign(document.createElement('li'), { textContent: u.displayName })));
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('signin-error', null);
  const { ok, status, data } = await api('/api/login', { username: $('username').value, password: $('password').value });
  if (!ok) return setError('signin-error', status === 401 ? 'wrong' : 'cannotSignIn');
  $('password').value = '';
  show(data);
});

$('signout').addEventListener('click', async () => {
  stream?.close();
  await api('/api/logout', {});
  show(null);
});

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('message');
  const text = box.value.trim();
  setError('send-error', null);
  if (!text) return setError('send-error', 'writeFirst');
  const { ok, status, data } = await api('/api/messages', { text });
  if (status === 401) return show(null);
  if (!ok) {
    // The server's own words, when it says why: in its language.
    if (data.error) {
      said.delete('send-error');
      $('send-error').textContent = data.error;
      return;
    }
    return setError('send-error', 'cannotSend');
  }
  box.value = '';
  box.focus();
  addMessage(data);
});

// Enter sends, Shift+Enter starts a new line.
$('message').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  $('send-form').requestSubmit();
});
$('message').addEventListener('input', () => setError('send-error', null));

applyWords();

async function boot() {
  const { ok, data } = await api('/api/me');
  show(ok ? data : null);
}
boot();
