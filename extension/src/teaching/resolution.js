// A owns scoped matching; this fallback adds native names and open-shadow DOM.
import { RESOLVE_TIMEOUT_MS, VERIFY_TIMEOUT_MS } from '../constants.js';
import { isVisible } from '../resolve/visible.js';
import { checkAbort, delay } from './async.js';
import { parentOf as parent, isEnabled, isStateReadout, roleOf, collapseNested } from '../resolve/eligibility.js';
export { isEnabled, roleOf } from '../resolve/eligibility.js';

export const CONTROL = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role], [aria-label], [aria-labelledby]';
export const ACTION_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
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

export function withinScope(element, scope = 'any') {
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
  const rest = name.slice(expected.length);
  const suffix = rest.trim();
  return /^(?:Updated|New)\s*[►▸▶›»]?$/i.test(suffix)
    || /^(?:[►▸▶›»]|\(?\s*(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|⌘|⌥|⇧|F\d{1,2})(?:\b|[+⌘⌥⇧]).*\)?)$/i.test(suffix)
    // A single-key accelerator, glued on: Docs ships "Text(S)", "Details(B)".
    || /^\([^\s()]\)$/.test(suffix)
    // Outside Docs the noise glued to a label is usually a count badge rather
    // than a keyboard shortcut: GitHub's "Issues 12" tab, Gmail's "Inbox 1,203".
    // Same problem, same fix — a lesson names the control, not the number, and
    // the number changes between authoring the lesson and teaching it anyway.
    //
    // Whitespace-separated, or "Heading 1" swallows "Heading 10": the suffix "0"
    // reads as a badge, the two collapse into one match, and neither resolves.
    || (/^\s/.test(rest) && /^\(?\d[\d,.\u202f\u00a0]*\+?k?\)?$/i.test(suffix));
}

export function findTarget(target, resolver, { requireEnabled = true, allowReadouts = false } = {}) {
  const eligible = element => usable(element) && (!requireEnabled || isEnabled(element))
    && (allowReadouts || !isStateReadout(element));
  if (target?.nodeType === 1) return eligible(target) ? target : null;
  if (!target || typeof target.name !== 'string' || !target.name.trim()) return null;
  if (target.nth !== undefined && (!Number.isInteger(target.nth) || target.nth < 0)) return null;
  // Read A live so a completed resolver can replace the stub without changing D.
  const provided = resolver?.()?.findSync?.(target, { requireEnabled, allowReadouts });
  if (eligible(provided)) return provided;
  const matches = collapseNested(queryDeep(CONTROL).filter(element => eligible(element)
    && withinScope(element, target.scope)
    && (!target.role || roleOf(element) === target.role)
    // A menu/toolbar container's concatenated text is not its child's button
    // name. Grouping and static roles require an explicit role in the target.
    && (target.role || !roleOf(element) || ACTION_ROLES.has(roleOf(element)))
    && matchesName(element, target.name)));
  if (target.nth === undefined && matches.length !== 1) return null;
  return matches[target.nth ?? 0] || null;
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
    if (verification.kind === 'visible') return Boolean(findTarget(verification, resolver, { requireEnabled: false, allowReadouts: true }));
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
