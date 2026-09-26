# The piece (an example: copy it, then delete it)

One paragraph: what the piece is, in the words of the people who use it,
and what this suite proves about it.

**What it does not test:** what lives somewhere else, and where it is
tested instead.

## Cast

| Person | Account |
|--------|---------|
| **Alice** | `alice@example.com` |
| **Bob** | `bob@example.com` |

## Setup

| # | What | Check |
|---|------|-------|
| S1 | A fresh app (`npx qa-cockpit reset`). | The app answers, with none of the data below. |
| S2 | Alice and Bob sign in once, and their sessions are kept. | Each lands on the page the app shows after signing in. |

## Tests

### T1 · What one person does reaches the other

| # | Who | Does | Must see |
|---|-----|------|----------|
| 1 | Bob | Opens the page where it will arrive. | «The exact text the page shows before». |
| 2 | Alice | Does one thing, in the app's own words («Send», «Share»...). | «The exact text that confirms it, on her screen». |
| 3 | Bob | Does nothing. | «What arrives on his screen», without reloading. |

## Runs

| Date | Who | Result | Notes |
|------|-----|--------|-------|
| | | | |
