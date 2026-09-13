// [A] PLAN.md §8.2–8.3 — resolution ladder + retry loop.
import { RESOLVE_TIMEOUT_MS } from '../constants.js';
import { isVisible } from './visible.js';
import { toolbarMatch, menuMatch } from './match.js';
import { isEnabled, isStateReadout, isTeacherUI, roleOf, collapseNested, samePeerGroup } from './eligibility.js';

// Ladder (every tier filters through isVisible() FIRST):
//   1  #docs-toolbar-wrapper [aria-label]   → toolbarMatch
//   2  semantic menu-item roles             → menuMatch
//   3  [aria-label]  (dialogs, sidebars)    → toolbarMatch
//   4  apply target.nth to what's left      (nth counts VISIBLE matches)
//   5  fail → null; panel falls back to a text-only hint
// target.scope skips to the relevant tier. NEVER tier on CSS class names.
const TOOLBAR_TIER = ['#docs-toolbar-wrapper [aria-label], [role="toolbar"] [aria-label]', toolbarMatch];
const MENU_TIER = [
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="listbox"]',
  menuMatch,
];
const GENERIC_TIER = ['[aria-label]', toolbarMatch];
const DIALOG_TIER = ['dialog [aria-label], [role="dialog"] [aria-label], [role="alertdialog"] [aria-label]', toolbarMatch];

const TIERS_BY_SCOPE = {
  toolbar: [TOOLBAR_TIER],
  menu: [MENU_TIER],
  any: [TOOLBAR_TIER, MENU_TIER, GENERIC_TIER],
  dialog: [DIALOG_TIER],
};

function normalizeTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (typeof target.name !== 'string' || !target.name.trim()) return null;
  if (target.nth !== undefined && (!Number.isInteger(target.nth) || target.nth < 0)) {
    return null;
  }

  const scope = target.scope === undefined ? 'any' : target.scope;
  if (typeof scope !== 'string' || !Object.hasOwn(TIERS_BY_SCOPE, scope)) return null;

  if (target.role !== undefined && (typeof target.role !== 'string' || !target.role.trim())) return null;
  if (target.any !== undefined && typeof target.any !== 'boolean' && typeof target.any !== 'string') return null;
  return { name: target.name.trim(), scope, nth: target.nth, role: target.role?.trim(), any: Boolean(target.any) };
}

function pick(matches, { nth, any }) {
  // Docs sometimes gives a combobox and its nested input the same aria-label.
  // Treat that nested pair as one control, preferring the outer hit target.
  const controls = collapseNested(matches);

  if (nth !== undefined) return controls[nth] ?? null;
  // Repeated examples within one choice group still identify that group.
  // Duplicates in separate menus remain ambiguous, even for a free choice.
  if (any && controls.every(element => samePeerGroup(element, controls[0]))) return controls[0];
  return controls.length === 1 ? controls[0] : null;
}

function resolveOnce(target, { requireEnabled = true, allowReadouts = false } = {}) {
  if (typeof document === 'undefined') return null;

  for (const [selector, matchesName] of TIERS_BY_SCOPE[target.scope]) {
    const matches = [...document.querySelectorAll(selector)]
      .filter(isVisible)
      .filter(el => !isTeacherUI(el) && (!requireEnabled || isEnabled(el))
        && (allowReadouts || !isStateReadout(el))
        && (!target.role || roleOf(el) === target.role))
      .filter(el => matchesName(el, target.name));

    // A tier with matches owns the result. If it is ambiguous or nth is out
    // of range, fail safely instead of falling through to a different control.
    if (matches.length) return pick(matches, target);
  }

  return null;
}

export function tryResolve(target, options) {
  const normalized = normalizeTarget(target);
  return normalized ? resolveOnce(normalized, options) : null;
}

export function findSync(target, options) {
  return tryResolve(target, options);
}

export async function find(target, timeout = RESOLVE_TIMEOUT_MS) {
  const normalized = normalizeTarget(target);
  if (!normalized || typeof document === 'undefined') return null;

  const maxWait = Number.isFinite(timeout) && timeout >= 0
    ? timeout
    : RESOLVE_TIMEOUT_MS;
  const start = performance.now();
  let firstAttempt = true;

  while (firstAttempt || performance.now() - start < maxWait) {
    firstAttempt = false;
    const el = resolveOnce(normalized);
    if (el) return el;

    if (performance.now() - start >= maxWait) return null;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  return null;
}
