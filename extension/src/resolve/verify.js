// [A] All four Verify kinds. Polls to VERIFY_TIMEOUT_MS. PLAN.md §5.
//   { kind: 'label',   selector, match }  element text contains match
//   { kind: 'dom',     selector }         element appears
//   { kind: 'visible', name, scope? }     named element becomes visible
//   { kind: 'none' }                      advance on click alone
import { VERIFY_TIMEOUT_MS } from '../constants.js';

export async function verify(v) {
  if (!v || v.kind === 'none') return true;
  // TODO [A]
  return true;
}
