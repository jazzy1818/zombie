// [D] One spotlight, one live geometry loop. No semantic target resolution.
import { SPOT_PADDING, SPOT_RADIUS, SCRIM, ACCENT, TRANSITION_MS } from '../constants.js';
import { currentHost, mountHost, raiseHost, onUnmount, prefersReducedMotion } from './host.js';
import { normalizeBox, isElement, readRect, placeRect, sameRect } from './geometry.js';
import { scrollTargetIntoView } from './scroll.js';
import { ease } from './animation.js';

let active = null;
let cancellation = Promise.resolve();
const clearListeners = new Set();

export function onSpotlightClear(callback) {
  clearListeners.add(callback);
}

export async function spotlight(box) {
  const target = normalizeBox(box);
  const previous = active?.rect;
  clear();
  const previousCancellation = cancellation;
  const surface = mountHost();
  raiseHost();
  const scroll = scrollTargetIntoView(target);
  const duration = previous && !prefersReducedMotion() ? TRANSITION_MS : 0;
  const start = performance.now();
  let settle;
  const ready = new Promise(resolve => { settle = resolve; });
  const state = { target, frame: 0, rect: null, settle, scroll };
  active = state;
  Object.assign(surface.spot.style, {
    borderRadius: `${SPOT_RADIUS}px`, boxShadow: `0 0 0 9999px ${SCRIM}`,
    outlineColor: ACCENT, opacity: '1',
  });

  const tick = now => {
    if (active !== state) return;
    if (!surface.host.isConnected || (isElement(target) && !target.isConnected)) {
      clear();
      return;
    }
    const rect = readRect(target);
    const progress = duration ? Math.min(1, (now - start) / duration) : 1;
    if (rect) {
      const displayed = previous && progress < 1
        ? Object.fromEntries(Object.keys(rect).map(key => [key, previous[key] + (rect[key] - previous[key]) * ease(progress)]))
        : rect;
      if (!sameRect(state.rect, displayed)) placeRect(surface.spot, displayed, SPOT_PADDING);
      surface.spot.hidden = false;
      surface.scrim.hidden = true;
      state.rect = displayed;
    } else {
      surface.spot.hidden = true;
      // A rendered target outside the viewport still belongs to the active step.
      // Keep dimming, with no misleading hole, until it returns or guidance clears.
      surface.scrim.hidden = !readRect(target, false);
      state.rect = null;
    }
    if (!scroll.pending && (progress === 1 || !rect)) state.settle();
    state.frame = requestAnimationFrame(tick);
  };
  tick(start);
  await Promise.all([ready, previousCancellation]);
}

export function clear() {
  if (active) {
    const previous = active;
    cancelAnimationFrame(previous.frame);
    previous.scroll.cancel();
    if (previous.scroll.pending) {
      cancellation = previous.scroll.promise;
      cancellation.then(previous.settle);
    } else previous.settle();
    active = null;
  }
  const surface = currentHost();
  if (surface) { surface.spot.hidden = true; surface.scrim.hidden = true; }
  for (const callback of clearListeners) callback();
}

onUnmount(clear);
