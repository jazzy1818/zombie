// [D] Scrim + outline + rAF reposition loop.
// Takes an Element OR a raw {top,left,width,height} rect — which is what lets
// this whole layer be built and tested before A's resolver exists.
import { SPOT_PADDING, SPOT_RADIUS, SCRIM, ACCENT, TRANSITION_MS } from '../constants.js';

export async function spotlight(box) {
  // TODO [D] — scrollIntoView first, then draw, then start the rAF loop
}

export function clear() {
  // TODO [D] — idempotent; stop the rAF loop
}
