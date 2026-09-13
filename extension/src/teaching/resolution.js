// A owns scoped matching; this fallback adds native names and open-shadow DOM.
import { RESOLVE_TIMEOUT_MS, VERIFY_TIMEOUT_MS } from '../constants.js';
import { isVisible } from '../resolve/visible.js';
import { checkAbort, delay } from './async.js';
import { parentOf as parent, isEnabled, isStateReadout, roleOf, collapseNested, optionList, samePeerGroup, LIST_SELECTOR } from '../resolve/eligibility.js';
export { isEnabled, roleOf } from '../resolve/eligibility.js';

const CONTROL = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role], [aria-label], [aria-labelledby]';
const ACTION_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const uiHost = element => element.id === 'browser-teacher-root'
  || element.getAttribute('data-browser-teacher') === 'ui'
  || element.hasAttribute('data-browser-teacher-paint');

export function isTeacherUI(element) {
  for (let node = element; node?.nodeType === 1; node = parent(node)) {
    if (uiHost(node)) return true;
  }
  return false;
}

export function usable(element) {
  if (element?.nodeType !== 1 || element.ownerDocument !== document || isTeacherUI(element) || !isVisible(element)) return false;
  for (let node = element; node; node = parent(node)) {
    if (node.inert || node.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
}

export function accessibleName(element) {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const root = element.getRootNode();
    const label = normalize(labelledBy.split(/\s+/).map(id => root.getElementById?.(id)?.textContent || '').join(' '));
    if (label) return label;
  }
  const aria = normalize(element.getAttribute('aria-label'));
  if (aria) return aria;
  if (element.labels?.length) {
    const label = normalize(Array.from(element.labels, item => item.textContent).join(' '));
    if (label) return label;
  }
  if (element.localName === 'input' && ['button', 'submit', 'reset'].includes(element.type)) {
    return normalize(element.value || (element.type === 'submit' ? 'Submit' : element.type === 'reset' ? 'Reset' : ''));
  }
  if (element.localName === 'input' && element.type === 'image') return normalize(element.alt);
  const text = normalize(element.innerText || element.textContent);
  return text || normalize(element.getAttribute('title'));
}

// Query the document and each open shadow tree. Closed roots and cross-origin
// frames need a resolver running inside that surface and are not guessed here.
export function queryDeep(selector, root = document) {
  const matches = [];
  function visit(container) {
    for (const element of container.children || []) {
      // Whole UI subtrees are pruned once; avoid an ancestor walk for every
      // ordinary page node on large documents.
      if (uiHost(element)) continue;
      if (element.matches(selector)) matches.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
      visit(element);
    }
  }
  visit(root);
  return matches;
}

function withinScope(element, scope = 'any') {
  if (scope === 'any') return true;
  for (let node = element; node; node = parent(node)) {
    const role = roleOf(node);
    if (scope === 'toolbar' && role === 'toolbar') return true;
    if (scope === 'menu' && (role === 'menu' || role === 'menubar' || role === 'listbox' || role === 'option' || role.startsWith('menuitem'))) return true;
    if (scope === 'dialog' && (role === 'dialog' || role === 'alertdialog')) return true;
  }
  return false;
}

function matchesName(element, wanted) {
  if (roleOf(element) === 'listbox' && !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) return false;
  const name = accessibleName(element);
  const expected = normalize(wanted);
  if (name === expected) return true;
  // Bare lesson names may omit keyboard shortcuts or a submenu arrow. Do not
  // use an unrestricted prefix ("Save" must not silently become "Save as").
  if (!name.startsWith(expected)) return false;
  const suffix = name.slice(expected.length).trim();
  return /^(?:Updated|New)\s*[►▸▶›»]?$/i.test(suffix)
    || /^(?:[►▸▶›»]|\(?\s*(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|⌘|⌥|⇧|F\d{1,2})(?:\b|[+⌘⌥⇧]).*\)?)$/i.test(suffix);
}

/**
 * `target.any` marks a control that is one of a set of interchangeable choices —
 * a font in the font list, a heading level, a zoom percentage. The trace can
 * only ever record the one the explorer happened to click, and pinning that
 * turns every other legitimate choice into a wrong click. Widening to the list
 * makes the spotlight cover the whole column. Click recognition keeps the
 * example option and checks its peers, so clicking empty space cannot advance.
 *
 * The list is not re-checked for enabled/readout eligibility: Docs labels the
 * font list "Font list. Arial selected.", which is exactly the readout rule
 * that stops it being an action target. It is not one here — nobody clicks the
 * list, they click into it.
 */
function widen(element, target) {
  return element && target?.any ? optionList(element) ?? element : element;
}

/**
 * Rows a page gave no role and no label — Docs' font menu is a column of plain
 * divs — never enter CONTROL, so by name alone they do not exist. For a free
 * choice, look for the name as the bare text of something inside a list: a
 * choice is defined by where it sits, not by the ARIA it carries. Toolbars are
 * left out because a widget's current-value caption reads "Arial" too, and
 * that is a readout of the choice, not a row of it.
 */
function textMatches(target) {
  const wanted = normalize(target.name);
  const found = [];
  for (const list of queryDeep(LIST_SELECTOR)) {
    if (!usable(list) || list.closest('[role="toolbar"]')) continue;
    for (const element of list.querySelectorAll('*')) {
      if (!normalize(element.textContent).startsWith(wanted)) continue;   // cheap gate before layout reads
      if (!usable(element) || !isEnabled(element) || isStateReadout(element)) continue;
      if (matchesName(element, target.name)) found.push(element);
    }
  }
  return collapseNested(found);
}

export function findTarget(target, resolver, { requireEnabled = true, allowReadouts = false, widenChoices = true } = {}) {
  const eligible = element => usable(element) && (!requireEnabled || isEnabled(element))
    && (allowReadouts || !isStateReadout(element));
  if (target?.nodeType === 1) return eligible(target) ? target : null;
  if (!target || typeof target.name !== 'string' || !target.name.trim()) return null;
  if (target.nth !== undefined && (!Number.isInteger(target.nth) || target.nth < 0)) return null;
  if (target.any !== undefined && typeof target.any !== 'boolean' && typeof target.any !== 'string') return null;
  // Read A live so a completed resolver can replace the stub without changing D.
  const provided = resolver?.()?.findSync?.(target, { requireEnabled, allowReadouts });
  if (eligible(provided)) return widenChoices ? widen(provided, target) : provided;
  let matches = collapseNested(queryDeep(CONTROL).filter(element => eligible(element)
    && withinScope(element, target.scope)
    && (!target.role || roleOf(element) === target.role)
    // A menu/toolbar container's concatenated text is not its child's button
    // name. Grouping and static roles require an explicit role in the target.
    && (target.role || !roleOf(element) || ACTION_ROLES.has(roleOf(element)))
    && matchesName(element, target.name)));
  if (!matches.length && target.any && requireEnabled) matches = textMatches(target);
  if (target.nth === undefined && matches.length !== 1
    && !(target.any && matches.length && matches.every(element => samePeerGroup(element, matches[0])))) return null;
  const found = matches[target.nth ?? 0] || null;
  return widenChoices ? widen(found, target) : found;
}

export async function resolveTarget(target, { signal, resolver, timeout = RESOLVE_TIMEOUT_MS }) {
  const end = performance.now() + timeout;
  for (;;) {
    checkAbort(signal);
    const element = findTarget(target, resolver);
    if (element) return element;
    if (performance.now() >= end) return null;
    await delay(Math.min(80, Math.max(0, end - performance.now())), signal);
  }
}

// A control that vanishes between mousedown and click is handled by
// resolve/gesture.js, which remembers what was under the pointer before the
// page could hide it. State readouts ("Styles list. Normal text selected.")
// are excluded from action targets by isStateReadout in resolve/eligibility.js.
// See pipeline/findings-c.md for the measurements behind both.

export function actionFromPath(path) {
  return path.find(element => element?.nodeType === 1 && usable(element)
    && isEnabled(element) && !isStateReadout(element)
    && (element.matches('button, a[href], input:not([type="hidden"]), select, textarea, summary') || ACTION_ROLES.has(roleOf(element)))) || null;
}

export function pathActivates(path, element) {
  if (!isEnabled(element)) return false;
  return path.includes(element) || path.some(node => node?.localName === 'label' && node.control === element);
}

export async function verifyOutcome(verification, { signal, resolver, timeout = VERIFY_TIMEOUT_MS }) {
  checkAbort(signal);
  if (!verification || verification.kind === 'none') return true;
  const end = performance.now() + timeout;
  function matches() {
    // Existence is proven by duplicate choices in one popup, even though a
    // normal action would need nth to choose between those same-name rows.
    if (verification.kind === 'visible') return Boolean(findTarget({ ...verification, any: true }, resolver, { requireEnabled: false, allowReadouts: true }));
    if (!['dom', 'label'].includes(verification.kind) || typeof verification.selector !== 'string') return false;
    let elements;
    try { elements = queryDeep(verification.selector); } catch { return false; }
    const expected = typeof verification.match === 'string' ? normalize(verification.match) : '';
    return elements.some(element => usable(element) && (verification.kind === 'dom'
      // A dropdown can expose its selection only in its accessible label.
      // Keep selector + match and existing text checks; do not guess another
      // element when the authored selector no longer matches the live page.
      || (expected && [element.textContent, element.getAttribute('aria-label')]
        .some(value => normalize(value).includes(expected)))));
  }
  for (;;) {
    checkAbort(signal);
    if (matches()) return true;
    if (performance.now() >= end) return false;
    await delay(Math.min(80, Math.max(0, end - performance.now())), signal);
  }
}
