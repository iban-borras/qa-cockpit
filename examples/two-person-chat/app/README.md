# Two-person chat (example app)

A tiny chat that two people use at once: the example project for QA Cockpit's
multi-person Playwright suites. Plain Node 20+, zero dependencies, all state in
memory (a restart forgets everything).

```sh
node server.mjs                                   # http://127.0.0.1:4310
PORT=4399 DEMO_TEST_HOOKS=1 node server.mjs       # custom port, test hooks on
```

Demo accounts (public fixtures, not secrets): `alice` / `demo-pass-1` (Alice)
and `bob` / `demo-pass-1` (Bob).

| Endpoint | What it does |
| --- | --- |
| `GET /health` | `{"status":"ok"}` |
| `POST /api/login` `{username,password}` | sets the `session` cookie, returns `{username,displayName}`; 401 if wrong |
| `POST /api/logout` | ends the session and its live streams |
| `GET /api/me` | the signed-in user, or 401 |
| `GET /api/messages` | `{messages:[{id,username,displayName,text,at}]}`, the last 100 |
| `POST /api/messages` `{text}` | signed in only; trimmed, 1 to 500 characters, else 400 `{error}` |
| `GET /api/events` | server-sent events: `message` (one new message) and `presence` (`[{username,displayName}]` connected now) |
| `POST /api/test/reset` | only with `DEMO_TEST_HOOKS=1` (404 otherwise): clears messages and sessions, restores the two accounts |
