// [D] Reusable feedback nodes; the caller decides correctness and narration.
import { CORRECT, WRONG, ACCENT, SPOT_PADDING } from '../constants.js';
import { currentHost, mountHost, raiseHost, onUnmount, prefersReducedMotion } from './host.js';
import { normalizeBox, readRect, placeRect } from './geometry.js';
import { onSpotlightClear } from './spotlight.js';
import { tween } from './animation.js';

let correct = null;
let wrong = null;

function stopCorrect() {
  correct?.cancel();
  correct = null;
  const surface = currentHost();
  if (surface) {
    surface.spot.style.outlineColor = ACCENT;
    surface.spot.style.outlineWidth = '2px';
  }
}

function stopWrong() {
  wrong?.cancel();
  wrong = null;
  const surface = currentHost();
  if (surface) surface.feedback.hidden = true;
}

export function flashCorrect() {
  stopCorrect();
  const surface = currentHost();
  if (!surface || surface.spot.hidden) return;
  const reduced = prefersReducedMotion();
  surface.spot.style.outlineColor = CORRECT;
  const animation = tween(reduced ? 160 : 500, progress => {
    if (!surface.host.isConnected || surface.spot.hidden) return false;
    surface.spot.style.outlineWidth = `${reduced ? 2 : 2 + 3 * Math.sin(progress * Math.PI)}px`;
  });
  correct = animation;
  animation.promise.then(() => { if (correct === animation) stopCorrect(); });
}

export function flashWrong(box) {
  const target = normalizeBox(box);
  stopWrong();
  const surface = mountHost();
  raiseHost();
  const initial = readRect(target);
  if (!initial) return;
  const reduced = prefersReducedMotion();
  surface.feedback.style.borderColor = WRONG;
  surface.feedback.style.opacity = '1';
  placeRect(surface.feedback, initial, SPOT_PADDING);
  surface.feedback.hidden = false;
  const animation = tween(reduced ? 160 : 500, progress => {
    const rect = readRect(target);
    if (!surface.host.isConnected || !rect) return false;
    placeRect(surface.feedback, rect, SPOT_PADDING + (reduced ? 0 : progress * 5));
    surface.feedback.style.opacity = String(reduced ? 1 : 1 - progress);
  });
  wrong = animation;
  animation.promise.then(() => { if (wrong === animation) stopWrong(); });
}

onSpotlightClear(() => { stopCorrect(); stopWrong(); });
onUnmount(() => { stopCorrect(); stopWrong(); });
