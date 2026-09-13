import { DEMO_DWELL_MS } from '../constants.js';
import { onUnmount } from '../paint/host.js';
import { watchNavigation } from '../paint/navigation.js';
import { abortError, abortable, checkAbort, delay } from './async.js';
import { resolveTarget, findTarget, actionFromPath, verifyOutcome } from './resolution.js';
import { createGestureTracker } from '../resolve/gesture.js';
import { clickedLabel } from '../resolve/click.js';

export function createTeaching({ paint, resolver }) {
  if (!paint) throw new Error('Paint must be initialized before teaching.');
  let session = new AbortController();
  let visual = null;
  let waiter = null;
  let stopNavigation = null;
  let cursorVisible = true;

  function ensureSession() {
    if (!stopNavigation) stopNavigation = watchNavigation(() => clear());
    return session.signal;
  }

  function stopVisual(reason) {
    if (visual) {
      visual.reason = reason;
      visual.controller.abort(abortError(`Teaching visual ${reason}`));
      visual = null;
    }
  }

  function clear() {
    stopNavigation?.();
    stopNavigation = null;
    session.abort(abortError());
    session = new AbortController();
    stopVisual('cancelled');
    paint.clear();
  }

  onUnmount(clear);

  async function show(target, mode) {
    paint.init();
    const signal = ensureSession();
    stopVisual('replaced');
    const current = { controller: new AbortController(), reason: null };
    visual = current;
    const abort = () => current.controller.abort(signal.reason || abortError());
    signal.addEventListener('abort', abort, { once: true });
    const currentSignal = current.controller.signal;
    try {
      const element = await resolveTarget(target, { signal: currentSignal, resolver });
      checkAbort(currentSignal);
      if (!element) { paint.clear(); return false; }
      if (mode !== 'cursor') {
        paint.setCursorVisible(false);
        await abortable(paint.spotlight(element), currentSignal);
        checkAbort(currentSignal);
      }
      paint.setCursorVisible(cursorVisible);
      await abortable(paint.moveCursor(element), currentSignal);
      checkAbort(currentSignal);
      if (mode === 'demo') {
        await delay(DEMO_DWELL_MS, currentSignal);
        await abortable(paint.clickCursor(), currentSignal);
        checkAbort(currentSignal);
      }
      return true;
    } catch (error) {
      // Completing a real click cancels outstanding scroll/cursor work, but is
      // a successful interaction, not a failed lesson operation.
      if (['activated', 'replaced'].includes(current.reason) && !signal.aborted) return true;
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (visual === current) visual = null;
    }
  }

  function waitForClick(target) {
    // Arm synchronously, before the caller begins resolve/scroll/animation.
    paint.init();
    const signal = ensureSession();
    waiter?.abort(abortError('Click waiter replaced'));
    const controller = new AbortController();
    waiter = controller;
    const abort = () => controller.abort(signal.reason || abortError());
    signal.addEventListener('abort', abort, { once: true });
    return new Promise((resolve, reject) => {
      let settleTimer = null;
      const tracker = createGestureTracker(target, descriptor => findTarget(descriptor, resolver), actionFromPath);
      function cleanup() {
        document.removeEventListener('click', click, true);
        tracker.dispose();
        signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelled);
        if (settleTimer !== null) clearTimeout(settleTimer);
        if (waiter === controller) waiter = null;
      }
      function cancelled() { cleanup(); reject(controller.signal.reason || abortError()); }
      function click(event) {
        const activation = tracker.read(event);
        if (!activation) return;
        let result;
        if (activation.target) {
          stopVisual('activated');
          paint.clear();
          result = 'correct';
        } else {
          const wrong = activation.action;
          if (!wrong) return;
          paint.flashWrong(wrong);
          result = { wrong: clickedLabel(activation.path, target) };
          // Re-arm in the caller's next microtask, without waiting for a cursor
          // animation or a timer that could lose the next real click.
          cleanup();
          resolve(result);
          return;
        }
        document.removeEventListener('click', click, true);
        // Let the real click bubble, run default actions and open any modal
        // before resolving the next same-document step. Redirects abort here.
        settleTimer = setTimeout(() => { cleanup(); resolve(result); }, 0);
      }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      document.addEventListener('click', click, true);
      if (signal.aborted) abort();
    });
  }

  return {
    highlight: target => show(target, 'highlight'),
    clear,
    moveCursor: async target => { await show(target, 'cursor'); },
    demo: async target => { await show(target, 'demo'); },
    waitForClick,
    // Preserve cancellable verification, open-shadow lookups and labelled
    // readouts while the same evidence rules are shared with A.
    verify: verification => verifyOutcome(verification, { signal: ensureSession(), resolver }),
    flashCorrect: () => paint.flashCorrect(),
    setCursorVisible: visible => { cursorVisible = Boolean(visible); paint.setCursorVisible(cursorVisible); },
  };
}
