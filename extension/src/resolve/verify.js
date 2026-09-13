// [A] All four Verify kinds. Polls to VERIFY_TIMEOUT_MS. PLAN.md §5.
//   { kind: 'label',   selector, match }  element text contains match
//   { kind: 'dom',     selector }         element appears
//   { kind: 'visible', name, scope? }     named element becomes visible
//   { kind: 'none' }                      advance on click alone
import { VERIFY_TIMEOUT_MS } from '../constants.js';
import { findSync } from './resolver.js';
import { isVisible } from './visible.js';
import { isTeacherUI } from './eligibility.js';

const TARGET_SCOPES = new Set(['toolbar', 'menu', 'dialog', 'any']);

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidRule(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;

  switch (v.kind) {
    case 'none':
      return true;
    case 'dom':
      return hasText(v.selector);
    case 'label':
      return hasText(v.selector) && hasText(v.match);
    case 'visible':
      return hasText(v.name)
        && (v.scope === undefined || TARGET_SCOPES.has(v.scope));
    default:
      return false;
  }
}

function query(selector) {
  try {
    return [...document.querySelectorAll(selector)].filter(el => isVisible(el) && !isTeacherUI(el));
  } catch {
    return [];
  }
}

function checkOnce(v) {
  switch (v.kind) {
    case 'dom':
      return query(v.selector).length > 0;
    case 'label': {
      const expected = v.match.replace(/\s+/g, ' ').trim();
      return query(v.selector).some(el => [el.textContent, el.getAttribute('aria-label')]
        .some(value => value?.replace(/\s+/g, ' ').trim().includes(expected)));
    }
    case 'visible':
      return findSync({ name: v.name, scope: v.scope, role: v.role, any: true }, { requireEnabled: false, allowReadouts: true }) !== null;
    default:
      return false;
  }
}

export async function verify(v) {
  if (!isValidRule(v)) return false;
  if (v.kind === 'none') return true;
  if (typeof document === 'undefined') return false;

  const start = performance.now();
  let firstAttempt = true;

  while (firstAttempt || performance.now() - start < VERIFY_TIMEOUT_MS) {
    firstAttempt = false;
    if (checkOnce(v)) return true;

    if (performance.now() - start >= VERIFY_TIMEOUT_MS) return false;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  return false;
}
