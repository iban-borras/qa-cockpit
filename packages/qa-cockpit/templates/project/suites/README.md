# Suites

Unit and API tests prove each piece on its own, with made-up accounts.
**This is the other half**: what really happens between two or more people,
in the whole app, with everything in between. A person can play a suite by
hand today; an agent can play it tomorrow and leave it recorded, so that it
then runs by itself (see «Written for agents», below).

## How a suite reads

Each suite is one file in this folder, named after the piece it tests
(`chat.md`), with these parts, in this order:

1. **A title and one paragraph**: what the piece is, in the words of the
   people who use it.
2. **What it does not test**, and where that is tested instead, so nobody
   looks here for what lives somewhere else.
3. **Cast**: who plays. Always the same people, with the same names and the
   same accounts, in every suite (the config's `cast`), so a step can say
   «Alice» without explaining who Alice is. Each person in **bold**: that is
   how the cockpit knows who plays in the suite. When it matters, a
   «Device» column says what each one plays on (a laptop, a phone...): the
   recording follows it.
4. **Setup**: the state that must exist before the first test (accounts,
   data, settings). Every row carries its own check: a setup done halfway
   gives tests that lie.
5. **Tests**, one heading each: `### T1 · <what it proves>`. Each test is a
   table of steps:

   | # | Who | Does | Must see |
   |---|-----|------|----------|

   **One step, one person, one action, one thing to see.** «Must see» says
   what shows on the screen (the exact text, between «»), never what happens
   inside. If a step needs to look at a log or the database, it says so and
   gives the command.
6. **Runs**: a table at the end, one row per run: the date, who ran it, the
   result and what they found. A test that fails is a row here and a note
   somewhere your team keeps them, never a silent fix. This table is left out
   of the suite's hash, so writing a row never makes a recording look stale.

The tests of a suite run in order: many leave the state as the next one
needs it. A test that destroys something (deletes an account, signs someone
out) says so in its title and goes last.

## Writing a new one

- One file per piece, and a row in the index below.
- Reuse the cast. When a piece needs somebody new, add them to the config's
  `cast` with the same pattern as the others.
- Say first what the suite does not test.
- Quote the app's texts exactly as the app writes them, between «».

## Written for agents

The format above (a fixed cast, a setup with checks, one step per person
with one observable expectation and the exact text) is what an agent needs
to play a suite on its own: a director that reads the suite, the browser of
each person of the cast, and each step given to the person in «Who». Nothing
in the format is decoration: if a step does not say who, what and what must
be seen, neither a person nor an agent can play it without asking.

How a suite becomes a recording, and how a red recording is healed, is in
the skill (`SKILL.md`): the director and the healer.

## Index

| Suite | Piece | Tests | Last run |
|-------|-------|-------|----------|
| [example](example.md) | An example to copy, then delete: the format with its parts in place | 1 | (none yet) |
