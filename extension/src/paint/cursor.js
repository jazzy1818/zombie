// [D] This is a drawing, never an OS cursor or a source of real page clicks.
import { CURSOR_TWEEN_MS } from '../constants.js';
import { mountHost, currentHost, raiseHost, onUnmount, prefersReducedMotion } from './host.js';
import { normalizeBox, readRect, isElement } from './geometry.js';
import { tween, ease } from './animation.js';
import { onSpotlightClear } from './spotlight.js';
import { getPointerPosition } from './pointer.js';

let position = null;
let visible = true;
let movement = null;
let click = null;
let anchor = null;
let tracking = 0;

const center = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

function draw(surface, point, scale = 1) {
  position = point;
  surface.cursor.style.transform = `translate(${point.x}px, ${point.y}px) scale(${scale})`;
}

function cancelClick() {
  click?.cancel();
  click = null;
  const surface = currentHost();
  if (surface) {
    surface.ripple.hidden = true;
    if (position) draw(surface, position);
  }
}

function cancelMovement() {
  movement?.cancel();
  movement = null;
}

function stopTracking() {
  cancelAnimationFrame(tracking);
  tracking = 0;
}

function trackAnchor() {
  stopTracking();
  const tick = () => {
    tracking = 0;
    const surface = currentHost();
    if (!visible || !anchor || !surface) return;
    if (isElement(anchor) && !anchor.isConnected) {
      surface.cursor.hidden = true;
      anchor = null;
      return;
    }
    if (!movement && !click) {
      const rect = readRect(anchor);
      surface.cursor.hidden = !rect;
      if (rect) draw(surface, center(rect));
    }
    tracking = requestAnimationFrame(tick);
  };
  tick();
}

function clearCursor() {
  stopTracking();
  cancelMovement();
  cancelClick();
  anchor = null;
  const surface = currentHost();
  if (surface) surface.cursor.hidden = true;
}

export async function moveCursor(box) {
  const target = normalizeBox(box);
  const surface = mountHost();
  raiseHost();
  stopTracking();
  cancelMovement();
  cancelClick();
  anchor = target;
  const initial = readRect(target);
  if (!initial) { surface.cursor.hidden = true; position = null; trackAnchor(); return; }
  const destination = center(initial);
  // Every new guide starts at the latest real pointer, not the last ghost target.
  // Keyboard/touch entry or a pointer outside this document has no known origin.
  const from = getPointerPosition();
  surface.cursor.hidden = !visible;
  if (!visible) { draw(surface, destination); return; }
  if (!from) { draw(surface, destination); trackAnchor(); return; }
  draw(surface, from);
  const animation = tween(prefersReducedMotion() ? 0 : CURSOR_TWEEN_MS, progress => {
    const rect = readRect(target);
    if (!surface.host.isConnected || !rect) {
      surface.cursor.hidden = true;
      position = null;
      return false;
    }
    const to = center(rect);
    draw(surface, { x: from.x + (to.x - from.x) * ease(progress), y: from.y + (to.y - from.y) * ease(progress) });
  });
  movement = animation;
  await animation.promise;
  if (movement === animation) { movement = null; trackAnchor(); }
}

export async function clickCursor() {
  const surface = currentHost();
  cancelClick();
  if (!surface || !visible || !position || surface.cursor.hidden) return;
  cancelMovement();
  const reduced = prefersReducedMotion();
  surface.ripple.hidden = false;
  const animation = tween(reduced ? 0 : 320, progress => {
    const rect = anchor && readRect(anchor);
    if (!surface.host.isConnected || !rect) return false;
    const point = center(rect);
    const press = 1 - 0.16 * Math.sin(progress * Math.PI);
    draw(surface, point, press);
    surface.ripple.style.transform = `translate(${point.x - 15}px, ${point.y - 15}px) scale(${0.4 + progress * 1.4})`;
    surface.ripple.style.opacity = String(1 - progress);
  });
  click = animation;
  await animation.promise;
  if (click === animation) { cancelClick(); trackAnchor(); }
}

export function setCursorVisible(value) {
  visible = Boolean(value);
  if (!visible) { stopTracking(); cancelMovement(); cancelClick(); }
  const surface = currentHost();
  if (surface) surface.cursor.hidden = !visible || !anchor || !readRect(anchor);
  if (visible && anchor) trackAnchor();
}

onSpotlightClear(clearCursor);
onUnmount(() => { clearCursor(); position = null; });
