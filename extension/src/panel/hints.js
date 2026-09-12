// [B] Idle timers + hint escalation.
// hints[0] is conceptual ("which menu handles adding things?"),
// hints[1] is spatial ("Insert menu, near the bottom"). Conceptual first —
// a spatial hint given too early skips the learning.
import { IDLE_HINT_MS, HINT_ESCALATE_MS } from '../constants.js';

export function startHints(step, show) {
  // TODO [B] — tier 1 at IDLE_HINT_MS, then every HINT_ESCALATE_MS
  return () => {};  // returns cancel()
}
