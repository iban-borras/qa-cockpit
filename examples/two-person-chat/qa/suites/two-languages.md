# Two languages, one room

Alice reads the chat in English and Bob in Spanish, at the same time: each
sees the app's own words in their language, and every message as it was
written, whoever wrote it.

**What it does not test:** Catalan, and every screen in each language (the
look in other languages, `replay --languages`, covers them); the choice
surviving a new browser (each test opens Bob's fresh, so he picks
«Español» first).

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

### T1 · Each one reads it in their own language

| # | Who | Does | Must see |
|---|-----|------|----------|
| 1 | Bob | Opens the chat and picks «Español» in «Language». | «Todavía no hay mensajes.» |
| 2 | Alice | Opens the chat. | «No messages yet.» |
| 3 | Alice | Writes «Hello, Bob!» in «Message» and presses «Send». | «Alice: Hello, Bob!» under «Messages». |
| 4 | Bob | Does nothing. | «Alice: Hello, Bob!» arrives under «Mensajes», without reloading. |
| 5 | Bob | Writes «¡Hola, Alice!» in «Mensaje» and presses «Enviar». | «Bob: ¡Hola, Alice!» under «Mensajes». |
| 6 | Alice | Does nothing. | «Bob: ¡Hola, Alice!» arrives under «Messages», and «Who is here» is still in English. |

### T2 · An empty message is refused in Spanish

| # | Who | Does | Must see |
|---|-----|------|----------|
| 1 | Bob | Opens the chat and picks «Español» in «Language». | «Enviar» on the button. |
| 2 | Bob | Presses «Enviar» with «Mensaje» empty. | «Escribe algo primero.» |

## Runs

| Date | Who | Result | Notes |
|------|-----|--------|-------|
| | | | |
