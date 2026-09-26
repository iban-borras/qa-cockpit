# The chat

Two people in one room: what one writes reaches the other live, an empty
message is refused, and «Who is here» follows who comes and goes.

**What it does not test:** the server's limits on a message's length and on
a request's size (the app's own API checks cover them), and more than one
room (there is one).

## Cast

| Person | Username | Password | Device |
|--------|----------|----------|--------|
| **Alice** | `alice` | `demo-pass-1` | a laptop (`Desktop Chrome`) |
| **Bob** | `bob` | `demo-pass-1` | a phone (`iPhone 15`) |

## Setup

| # | What | Check |
|---|------|-------|
| S1 | A fresh app: no messages, nobody signed in (`POST /api/test/reset`). | `GET /api/messages` answers an empty list. |
| S2 | Alice and Bob sign in once, and their sessions are kept. | Each lands on «Signed in as Alice» / «Signed in as Bob». |

## Tests

### T1 · A message reaches the other person live

| # | Who | Does | Must see |
|---|-----|------|----------|
| 1 | Bob | Opens the chat. | «No messages yet.» |
| 2 | Alice | Opens the chat, writes «Hello, Bob!» in «Message» and presses «Send». | «Alice: Hello, Bob!» under «Messages», and «Message» empty again. |
| 3 | Bob | Does nothing. | «Alice: Hello, Bob!» arrives, without reloading. |

### T2 · An empty message is refused

| # | Who | Does | Must see |
|---|-----|------|----------|
| 1 | Alice | Presses «Send» with «Message» empty. | «Write something first.» |

### T3 · Who is here (destructive: signs Bob out, the last)

| # | Who | Does | Must see |
|---|-----|------|----------|
| 1 | Alice | Opens the chat. | «Alice» alone under «Who is here». |
| 2 | Bob | Opens the chat. | «Alice» and «Bob» under «Who is here», on both screens. |
| 3 | Bob | Presses «Sign out». | The «Sign in» form. |
| 4 | Alice | Does nothing. | «Alice» alone under «Who is here» again. |

## Runs

| Date | Who | Result | Notes |
|------|-----|--------|-------|
| | | | |
