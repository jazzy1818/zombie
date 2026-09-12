// [A] PLAN.md §8.0 — write this first. Apply before every match, at every tier.
// An invisible element is never a valid target: it means the user hasn't opened
// the right menu yet, which is exactly what a `guided` step should be waiting on.

export function isVisible(el) {
  if (!el || el.offsetParent === null) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
