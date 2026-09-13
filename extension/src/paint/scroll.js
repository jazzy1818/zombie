// [D] One native smooth scroll per highlight. Observe completion without owning
// the user's scrolling; a new interaction or clear/replacement cancels our work.
import { isElement, isRendered, parentOf, readRect } from './geometry.js';
import { prefersReducedMotion } from './host.js';

export function scrollTargetIntoView(target) {
  let pending = false;
  let stopping = false;
  let frame = 0;
  let settle;
  let cancel = () => {};
  const promise = new Promise(resolve => { settle = resolve; });
  const task = { promise, cancel: () => cancel(), get pending() { return pending; } };
  const raw = readRect(target, false);
  const visible = readRect(target);
  if (!isElement(target) || !raw || typeof target.scrollIntoView !== 'function'
      || (visible && visible.width >= raw.width - 1 && visible.height >= raw.height - 1)) {
    settle();
    return task;
  }
  if (prefersReducedMotion()) {
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    settle();
    return task;
  }

  const containers = [];
  for (let parent = parentOf(target); parent; parent = parentOf(parent)) {
    if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) containers.push(parent);
  }
  const offsets = () => containers.flatMap(element => [element.scrollLeft, element.scrollTop]);
  const initial = offsets();
  let previous = initial;
  let stableSince = performance.now();
  const start = stableSince;
  let hasMoved = false;
  pending = true;

  const finish = stopScrolling => {
    if (!pending || stopping) return;
    stopping = true;
    cancelAnimationFrame(frame);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      window.removeEventListener(type, interrupt, true);
    }
    if (stopScrolling) {
      // Abort our native animation at its current position, never rewind it.
      for (const container of containers) {
        container.scrollTo({ left: container.scrollLeft, top: container.scrollTop, behavior: 'instant' });
      }
      // Chromium can still commit a compositor scroll frame after scrollTo
      // returns. Drain it before promising a stable position. These callbacks
      // never scroll again, so they cannot cancel a replacement operation.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { pending = false; settle(); });
      });
    } else {
      pending = false;
      settle();
    }
  };
  function interrupt(event) {
    if (event.type === 'keydown' && !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Escape'].includes(event.key)) return;
    finish(true);
  }
  cancel = () => finish(true);
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    window.addEventListener(type, interrupt, { capture: true, passive: true });
  }
  const tick = now => {
    if (!pending || stopping) return;
    if (!isRendered(target)) return finish(true);
    const next = offsets();
    if (next.some((value, index) => value !== previous[index])) {
      stableSince = now;
      hasMoved = true;
    }
    previous = next;
    // Give native scrolling time to start, then wait for stable scroll offsets.
    // A hard bound handles unscrollable/clipped targets and ongoing site motion.
    if ((hasMoved && now - stableSince >= 80) || (!hasMoved && now - start >= 180) || now - start >= 2500) {
      finish(now - start >= 2500);
    } else frame = requestAnimationFrame(tick);
  };
  try {
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    frame = requestAnimationFrame(tick);
  } catch (error) {
    finish(true);
    throw error;
  }
  return task;
}
