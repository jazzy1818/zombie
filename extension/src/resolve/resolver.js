// [A] PLAN.md §8.2–8.3 — resolution ladder + retry loop.
import { RESOLVE_TIMEOUT_MS } from '../constants.js';
import { isVisible } from './visible.js';
import { toolbarMatch, menuMatch } from './match.js';

// Ladder (every tier filters through isVisible() FIRST):
//   1  #docs-toolbar-wrapper [aria-label]   → toolbarMatch
//   2  [role="menuitem"]                    → menuMatch
//   3  [aria-label]  (dialogs, sidebars)    → toolbarMatch
//   4  apply target.nth to what's left      (nth counts VISIBLE matches)
//   5  fail → null; panel falls back to a text-only hint
// target.scope skips to the relevant tier. NEVER tier on CSS class names.
export function tryResolve(target) {
  // TODO [A]
  return null;
}

export async function resolve(target, timeout = RESOLVE_TIMEOUT_MS) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const el = tryResolve(target);
    if (el) return el;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}
