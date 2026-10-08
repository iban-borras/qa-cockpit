// A look at a screen's accessibility, as Chromium's own accessibility tree
// has it (`replay --a11y`): the roles and the names a screen reader would
// say. The worker (worker.mjs) takes it with each step's photo, and each
// problem goes to the cockpit as a finding, a box on that photo. Chromium
// only, and never a red run: a look that fails is a look missing.
//
// Four rules, few and sure, so that a finding is worth a look:
//   name      a button, a link, a tab, a menu item with no name: a screen
//             reader says «button», and nothing else
//   label     a field with no label: «edit text», and no word of what for
//   alt       an image with no text alternative (an <img>, or what says
//             role="img"; an icon's bare <svg> is too often decoration)
//   keyboard  a control nobody can reach with the keyboard: a <div
//             role="button"> without tabindex, say
// Each problem is told once a run, where it first shows: a header's icon
// button would be on every step's photo otherwise.

const NAMED = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem']);
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox', 'checkbox', 'radio', 'switch']);
// Those whose focus a parent may hold for them (a listbox's options, a
// tree's items) are not asked to take it themselves.
const FOCUSED = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab']);
const MOST = 30;

/** An element as a person reading the code finds it: «button#close.icon [data-testid=close]». */
function describe(node) {
  const attrs = {};
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) attrs[list[i]] = list[i + 1];
  const classes = String(attrs.class ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((c) => `.${c}`)
    .join('');
  const test = attrs['data-testid'] ?? attrs['data-test'] ?? attrs['data-cy'];
  return {
    tag: String(node.localName ?? node.nodeName ?? '').toLowerCase(),
    attrs,
    what: `${String(node.localName ?? '').toLowerCase()}${attrs.id ? `#${attrs.id}` : ''}${classes}${test ? ` [data-testid=${test}]` : ''}`.slice(0, 120),
  };
}

/**
 * The accessibility problems on a page's screen now, those not told yet in
 * this run. Boxes in the document's pixels, the frame of a step's photo.
 * @param {any} page Playwright's page
 * @param {{ x: number, y: number }} scroll where the page was scrolled to
 * @param {Set<string>} told problems told already in this run
 */
export async function a11yFindings(page, scroll, told) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const found = [];
    for (const n of nodes) {
      if (found.length >= MOST) break;
      if (n.ignored || !n.backendDOMNodeId) continue;
      const role = n.role?.value;
      const name = String(n.name?.value ?? '').trim();
      const props = Object.fromEntries((n.properties ?? []).map((p) => [p.name, p.value?.value]));
      const rules = [];
      if (NAMED.has(role) && !name) rules.push('name');
      if (FIELDS.has(role) && !name) rules.push('label');
      if ((role === 'image' || role === 'img') && !name) rules.push('alt');
      if (FOCUSED.has(role) && !props.focusable && !props.disabled) rules.push('keyboard');
      if (!rules.length) continue;
      let el;
      try {
        el = describe((await cdp.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId })).node);
      } catch {
        continue;
      }
      // An icon's <svg> says «image» with no name, mostly inside a button
      // that has its own: only what declares itself an image is asked.
      if (rules[0] === 'alt' && el.tag !== 'img' && el.attrs.role !== 'img') continue;
      let box = null;
      try {
        const q = (await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId })).model.border;
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        box = {
          x: Math.round(Math.min(...xs) + scroll.x),
          y: Math.round(Math.min(...ys) + scroll.y),
          w: Math.round(Math.max(...xs) - Math.min(...xs)),
          h: Math.round(Math.max(...ys) - Math.min(...ys)),
        };
      } catch {
        // No box (nothing drawn): told all the same, without a place.
      }
      let path = '';
      try {
        path = new URL(page.url()).pathname;
      } catch {
        // A page without an address.
      }
      for (const rule of rules) {
        const key = `${rule}|${role}|${name}|${el.what}|${path}`;
        if (told.has(key)) continue;
        told.add(key);
        found.push({ kind: 'a11y', rule, role, name: name || null, what: el.what, box });
      }
    }
    return found;
  } finally {
    await cdp.detach().catch(() => {});
  }
}
