// [B] Idle timers + three-tier hint escalation. PLAN.md §12.
//
// Tier order is the whole point. hints[0] is conceptual ("which menu handles
// adding things?"), hints[1] is spatial ("Insert menu, near the bottom").
// A spatial hint fired early skips the learning, and the learning is the product.
import { IDLE_HINT_MS, HINT_ESCALATE_MS } from '../constants.js';

/**
 * Start escalating hints for a step. Call the returned cancel() as soon as the
 * user does anything — a step that's been answered must never hint.
 *
 *   tier 1  IDLE_HINT_MS            → conceptual
 *   tier 2  +HINT_ESCALATE_MS       → spatial
 *   tier 3  +HINT_ESCALATE_MS       → give up, highlight it for them
 *
 * @param {object} step  the Step being waited on
 * @param {object} ui    panel facade, needs .hint(text)
 */
export function startHints(step, ui, { signal } = {}) {
  const tiers = [];

  const [conceptual, spatial] = step.hints || [];
  if (conceptual) tiers.push(() => ui.hint(conceptual));
  if (spatial) tiers.push(() => ui.hint(spatial));

  // Tier 3 only exists if there's something to point at. On a `solo` step this
  // is the moment we stop making them hunt.
  if (step.target) {
    tiers.push(() => {
      ui.hint('Here it is.');
      window.__TEACH.setCursorVisible(true);
      Promise.resolve(window.__TEACH.highlight(step.target)).catch(error => {
        if (!signal?.aborted && error?.name !== 'AbortError') console.warn('[browser-teacher] Hint could not be shown', error);
      });
    });
  }

  const timers = tiers.map((fn, i) =>
    setTimeout(() => { if (!signal?.aborted) fn(); }, IDLE_HINT_MS + i * HINT_ESCALATE_MS),
  );

  function cancel() {
    timers.forEach(clearTimeout);
    signal?.removeEventListener('abort', cancel);
  }
  signal?.addEventListener('abort', cancel, { once: true });
  return cancel;
}
