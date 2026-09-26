// Two-person chat, browser side: vanilla JS, no build step.
const $ = (id) => document.getElementById(id);
let stream = null; // the EventSource while signed in
let shown = new Set(); // ids of the messages already in the list

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
  $('whoami').textContent = user ? `Signed in as ${user.displayName}` : '';
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
  $('signin-error').textContent = '';
  const { ok, status, data } = await api('/api/login', { username: $('username').value, password: $('password').value });
  if (!ok) return ($('signin-error').textContent = status === 401 ? 'Wrong username or password.' : 'Could not sign in. Try again.');
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
  $('send-error').textContent = '';
  if (!text) return ($('send-error').textContent = 'Write something first.');
  const { ok, status, data } = await api('/api/messages', { text });
  if (status === 401) return show(null);
  if (!ok) return ($('send-error').textContent = data.error || 'Could not send. Try again.');
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
$('message').addEventListener('input', () => ($('send-error').textContent = ''));

async function boot() {
  const { ok, data } = await api('/api/me');
  show(ok ? data : null);
}
boot();
