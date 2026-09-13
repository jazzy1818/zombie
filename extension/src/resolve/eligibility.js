// Shared action-candidate rules for A's resolver and the teaching fallback.
export const parentOf = element => element.assignedSlot || element.parentElement || element.getRootNode()?.host || null;

export function isEnabled(element) {
  if (element?.nodeType !== 1 || element.matches(':disabled')) return false;
  for (let node = element; node; node = parentOf(node)) {
    if (node.getAttribute('aria-disabled')?.trim().toLowerCase() === 'true') return false;
  }
  return true;
}

export function isStateReadout(element) {
  return /\b(?:list|menu)\.\s.+\sselected\.\s*$/i.test(element?.getAttribute?.('aria-label') || '');
}

export function isTeacherUI(element) {
  for (let node = element; node?.nodeType === 1; node = parentOf(node)) {
    if (node.id === 'browser-teacher-root' || node.getAttribute('data-browser-teacher') === 'ui'
      || node.hasAttribute('data-browser-teacher-paint')) return true;
  }
  return false;
}

export function roleOf(element) {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'option') return 'option';
  if (tag === 'dialog') return 'dialog';
  if (tag !== 'input') return '';
  const type = element.type;
  if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
  if (['checkbox', 'radio'].includes(type)) return type;
  if (type === 'range') return 'slider';
  if (type === 'number') return 'spinbutton';
  if (type === 'hidden') return '';
  return type === 'search' ? 'searchbox' : 'textbox';
}

export function collapseNested(matches) {
  const pool = new Set(matches);
  return matches.filter(element => {
    for (let node = parentOf(element); node; node = parentOf(node)) {
      if (pool.has(node)) return false;
    }
    return true;
  });
}

// Where a set of choices lives. Container roles are far better standardised
// across sites than row roles: a font list, a calendar grid, a style picker and
// a radio group all announce themselves, while their rows may be options, radio
// items, checkbox items, or — as in Docs' font menu — plain divs with no role
// at all. So a choice is defined by the list it sits in, never by what ARIA
// the row happens to carry.
const LIST_ROLES = new Set(['listbox', 'menu', 'radiogroup', 'grid', 'tree']);
export const LIST_SELECTOR = [...LIST_ROLES].map(role => `[role="${role}"]`).join(', ');

// A list wider and taller than most of the window is a layout container that
// happens to carry a role, not a column of choices. Spotlighting it would black
// out the page it is trying to point at.
const LIST_AREA_LIMIT = 0.7;

// Typing into a list's search box is not choosing from it.
const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
// A row's label is a word or a phrase. Anything longer is a wrapper reading out
// every row it contains.
const MAX_CHOICE_LABEL = 80;

/**
 * The list an option belongs to, or null when the page gives it none.
 * Ancestor-only by design: a collapsed toolbar widget is not an ancestor of the
 * popup it opens, so it can never be mistaken for the popup's list.
 */
export function optionList(element) {
  if (element?.nodeType !== 1) return null;
  const viewport = (globalThis.innerWidth || 0) * (globalThis.innerHeight || 0);
  const root = element.ownerDocument?.documentElement;
  for (let node = parentOf(element); node?.nodeType === 1; node = parentOf(node)) {
    if (node === element.ownerDocument?.body || node === root || isTeacherUI(node)) return null;
    if (!LIST_ROLES.has(roleOf(node))) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (viewport && rect.width * rect.height > viewport * LIST_AREA_LIMIT) return null;
    return node;
  }
  return null;
}

/** What a row calls itself: its label or text, minus a submenu arrow or a shortcut. */
export function bareLabel(element) {
  if (element?.nodeType !== 1) return '';
  const raw = element.getAttribute('aria-label') || element.innerText || element.textContent || '';
  return raw.replace(/\s+/g, ' ').trim()
    .replace(/\s*[►▸▶›»]\s*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

/** A pattern from a lesson's `any` — "any heading level" — or null for "any row at all". */
export function anyPattern(any) {
  if (typeof any !== 'string' || !any) return null;
  try { return new RegExp(any); } catch { return null; }
}

/**
 * The row a click inside `list` landed on, or null when it landed on nothing
 * choosable: the list's own padding, a wrapper, a search field, a disabled
 * row, a readout. Walks the click path from the target outward to the first
 * element inside the list with a short label of its own, then keeps climbing
 * while the label stays the same, so a click on the text inside a row still
 * names the row. That is what a person means by "I clicked Georgia", whatever
 * role the page gave the row, if any.
 */
export function choiceIn(list, path) {
  if (list?.nodeType !== 1) return null;
  let choice = null;
  for (const node of path) {
    if (node?.nodeType !== 1) continue;
    if (node === list || !list.contains(node)) break;
    if (node.matches(FIELD) || !isEnabled(node) || isStateReadout(node)) return null;
    const label = bareLabel(node);
    if (!label || label.length > MAX_CHOICE_LABEL) { if (choice) break; continue; }
    if (choice && label !== bareLabel(choice)) break;
    choice = node;
  }
  return choice;
}

/**
 * The click a free-choice step accepts: a row chosen from the example's list.
 * Same role as the example when the example has one — that is what keeps
 * "More fonts" (a command) out of a list of font rows — and any row at all
 * when it has none. `any` may be a pattern the row's label must match, for a
 * lesson that means "any heading level" rather than "anything in the list".
 */
export function chosenFrom(example, path, any) {
  if (example?.nodeType !== 1) return null;
  const list = optionList(example) ?? example.parentElement;
  const doc = example.ownerDocument;
  if (!list || list === doc?.body || list === doc?.documentElement) return null;
  const choice = choiceIn(list, path);
  if (!choice) return null;
  if (roleOf(example) && roleOf(choice) !== roleOf(example)) return null;
  const pattern = anyPattern(any);
  if (pattern && !pattern.test(bareLabel(choice))) return null;
  return choice;
}

/**
 * Are these two the same kind of choice from the same list? Same role, and
 * one's list contains the other — containment rather than identity because
 * Docs nests: the Recent fonts sit directly in the popup while the alphabetical
 * run is wrapped in its own scrolling box. Used by the resolvers to treat two
 * same-named rows in one list as one answer rather than an ambiguity.
 */
export function samePeerGroup(a, b) {
  if (a?.nodeType !== 1 || b?.nodeType !== 1) return false;
  if (roleOf(a) !== roleOf(b)) return false;
  if (a === b) return true;
  const listA = optionList(a);
  const listB = optionList(b);
  if (listA || listB) return Boolean(listA?.contains(b) || listB?.contains(a));
  return Boolean(a.parentElement) && a.parentElement === b.parentElement;
}
