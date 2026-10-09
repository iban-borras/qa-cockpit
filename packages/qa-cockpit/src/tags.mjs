// THE SUITES' TAGS: groups of suites, played one after another as a group
// (`replay --tag smoke`), to see that nothing broke. One file beside the
// suites, <suites>/tags.json, which people, agents (by hand or with `tags`)
// and the cockpit's page all edit:
//
//   {
//     "smoke": { "about": "The paths that must never break", "suites": ["login", "chat"] },
//     "messaging": { "suites": ["chat", "rooms"] }
//   }
//
// A tag's suites play in the order listed. It is kept out of the suites'
// own documents on purpose: a tag added or taken off never makes a
// recording look stale (suites.mjs, suiteHash).
import fs from 'node:fs';
import path from 'node:path';

/** A tag's name: lowercase letters, digits and hyphens. */
export const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const tagsFileOf = (config) => path.join(config.paths.suites, 'tags.json');

/**
 * The tags, as the file has them: in its order, each with its suites in
 * theirs. What is wrong in it (a name, a suite that is not one) is said,
 * not thrown: a run of the rest still goes.
 * @param {any} config
 * @param {Set<string> | null} [known] the suites there are, to tell the others
 * @returns {{ tags: { name: string, about: string, suites: string[] }[], problems: string[] }}
 */
export function readTags(config, known = null) {
  const file = tagsFileOf(config);
  if (!fs.existsSync(file)) return { tags: [], problems: [] };
  const where = path.basename(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { tags: [], problems: [`${where} is not JSON: ${e instanceof Error ? e.message : e}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tags: [], problems: [`${where} is { "tag": { "about": "…", "suites": ["suite", …] } }.`] };
  const tags = [];
  const problems = [];
  for (const [name, v] of Object.entries(raw)) {
    if (!TAG.test(name)) {
      problems.push(`«${name}» is no tag name: lowercase letters, digits and hyphens.`);
      continue;
    }
    const suites = Array.isArray(v?.suites) ? [...new Set(v.suites.filter((s) => typeof s === 'string'))] : [];
    if (!Array.isArray(v?.suites)) problems.push(`«${name}» has no "suites" list.`);
    if (known) for (const s of suites) if (!known.has(s)) problems.push(`«${s}», in «${name}», is no suite here.`);
    tags.push({ name, about: typeof v?.about === 'string' ? v.about.trim() : '', suites });
  }
  return { tags, problems };
}

/** The tags back to the file: in their order, the file's own indentation. */
export function writeTags(config, tags) {
  const out = Object.fromEntries(tags.map((x) => [x.name, { ...(x.about ? { about: x.about } : {}), suites: x.suites }]));
  fs.mkdirSync(path.dirname(tagsFileOf(config)), { recursive: true });
  fs.writeFileSync(tagsFileOf(config), `${JSON.stringify(out, null, 2)}\n`);
}

/** The tags a suite is in, by name. */
export const tagsOfSuite = (tags, suite) => tags.filter((x) => x.suites.includes(suite)).map((x) => x.name);

/**
 * A change to the tags, written at once: a suite added to a tag (made when
 * new) or taken off it (the tag gone with its last suite, unless it says
 * what it is about), or what a tag is about.
 * @param {{ add?: string[], remove?: string[], about?: string }} change with the tag's name and its suites
 * @returns {string} what changed, in a line
 */
export function changeTags(config, name, { add = [], remove = [], about } = {}) {
  if (!TAG.test(name)) throw new Error(`«${name}» is no tag name: lowercase letters, digits and hyphens («smoke», «checkout-flow»).`);
  const { tags, problems } = readTags(config);
  // A file that does not read is not written over: what it held would be lost.
  if (problems.some((p) => p.includes('is not JSON') || p.startsWith('tags.json is {'))) throw new Error(problems[0]);
  let tag = tags.find((x) => x.name === name);
  if (!tag) {
    if (!add.length && about === undefined) throw new Error(`No tag «${name}».`);
    tag = { name, about: '', suites: [] };
    tags.push(tag);
  }
  const added = add.filter((s) => !tag.suites.includes(s));
  tag.suites.push(...added);
  const removed = remove.filter((s) => tag.suites.includes(s));
  tag.suites = tag.suites.filter((s) => !remove.includes(s));
  if (about !== undefined) tag.about = String(about).trim();
  const gone = !tag.suites.length && !tag.about;
  writeTags(config, gone ? tags.filter((x) => x !== tag) : tags);
  return [
    added.length && `«${name}» now has ${added.join(', ')}.`,
    removed.length && `${removed.join(', ')} off «${name}».`,
    about !== undefined && `«${name}»: ${tag.about || '(no words)'}.`,
    gone && `«${name}» had no suite left, and is gone.`,
  ]
    .filter(Boolean)
    .join(' ') || `«${name}» was so already.`;
}
