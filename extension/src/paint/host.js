// [D] Shadow DOM host — mount/unmount. Everything the paint layer draws lives
// inside this shadow root so Docs' stylesheets can't reach it and ours can't
// reach Docs.
//
// CRITICAL: the overlay must be pointerEvents:'none'. Docs menus dismiss on
// blur — if the scrim eats the click, the menu closes and the step is dead.
import { OVERLAY_Z } from '../constants.js';

export function mountHost() {
  // TODO [D] — idempotent
}
