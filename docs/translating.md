# Translating the cockpit

The cockpit's page speaks the languages in
[`packages/qa-cockpit/src/server/public/i18n/`](../packages/qa-cockpit/src/server/public/i18n/),
a file per language, and
[`i18n.js`](../packages/qa-cockpit/src/server/public/i18n.js) looks each
sentence up. A new sentence is written in English, Catalan and Spanish; until
another language has it, the page says it in English. Before a release, the
other languages catch up.

```sh
cd packages/qa-cockpit
node scripts/i18n-check.mjs            # each language: what it is missing, and its errors
node scripts/i18n-check.mjs fr         # one language, each missing key named
```

An error is a key English does not have, a sentence with other
`{placeholders}` than English's, an empty one, or a plural form the language
does not have, or lacks. What is missing is not an error: it is said in
English meanwhile (`--strict` makes it one).

## Filling a language with agents

One agent per language, each with the brief below and its language's notes.
The cost is in the text, not in the number of agents. With one each, a
mistake stays in one language, and none has to keep twelve vocabularies
apart. A small model is enough. After each one, run the check, read what the
agent says about its terms, and have the languages you do not read
back-translated to English and compared with the source.

A new language is three lines in `i18n.js`:
- its `import`;
- its code in `DICT`, `LOCALES` and `ENDONYM`;
- an empty `i18n/<code>.js` for its agent to fill.

### The brief

> You translate the user interface of QA Cockpit, a local web page where developers watch automated browser tests (Playwright) of their own web app run with several people at once, one browser window per person, and leave notes on the screenshots for a coding agent to fix.
>
> **Sources.** `src/server/public/i18n/en.js` is the authoritative source. `ca.js` and `es.js` show the meaning where the English is terse; the same author wrote all three.
>
> **What to write.** Write in `src/server/public/i18n/<code>.js` only:
> - the whole file, for a new language;
> - or, for one that exists, the keys `node scripts/i18n-check.mjs <code>` lists as missing, each at the place it has in `en.js`.
>
> Do not touch other files and do not run git.
>
> **Format.** The same keys and order as `en.js`, two spaces of indentation. Each string in single quotes, or in double quotes when the text holds an apostrophe. Plain UTF-8 characters. Leave out `lang.ca`, `lang.es` and `lang.en`, since the page names languages through the browser.
>
> **Placeholders.** `{name}`, `{n}`, `{cli}` and the rest are filled in by the page. Copy them exactly; you may move them within the sentence. `{cli} up` and `{cli} cockpit --restart` are commands.
>
> **Counts.** A key ending in `_one` / `_other` in English counts something. Write the plural forms of your language, which the check names (`_one`, `_few`, `_many`, `_other`…; only `_other` in Chinese and Japanese). Every form contains `{n}` wherever English `_other` has it, because in some languages `_one` also serves 0 or 21.
>
> **Kept in English.** Product names (QA Cockpit, Playwright, Chromium, Docker, Markdown) and the command-named buttons **Reset DB**, **Setup**, **Replay** and **Suite**. A sentence that names a button uses the very words of that button's key. In `ins.keys`, the letters L, C, N, I and Esc are the keys pressed.
>
> **Tone.** Short, plain, concrete: a tool for developers. Labels stay short. Use your language's usual quotation marks throughout.
>
> **Words.**
> - A *run* is **Green** (passed) or **Red** (failed).
> - The *table* holds a *card* per person, showing their screen live.
> - The *cast* are the people a suite uses.
> - The *stack* is the app's services for testing.
> - *Play as* opens a window signed in as a person, and a *play report* is made from what was done there.
> - A *note* hangs from a *tack* dropped on a photo.
> - A *look* is an optional check of a run.
> - A *race* is a race condition between people, found over *rounds*, each slowed as its *seed* says.
> - *Changes* are what differs from an earlier green run.
>
> **Check.** Run `node scripts/i18n-check.mjs <code>` until it is clean. Then reply with how you translated run, Green, Red, step, photo, the table, card, cast, stack, Play as, note, tack, look, race, round, seed and Full run, and any sentence you found ambiguous.

Each agent's own notes say:
- how its language addresses the user (du, vous, você, вы…);
- its quotation marks;
- its plural forms;
- its name for the space bar.

Writing system and script choices go there too, like Hindi's English technical words in Devanagari or Japanese katakana terms.
