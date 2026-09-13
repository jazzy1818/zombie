import { DEMO_DWELL_MS } from '../constants.js';
import { onUnmount } from '../paint/host.js';
import { watchNavigation } from '../paint/navigation.js';
import { abortError, abortable, checkAbort, delay } from './async.js';
import { resolveTarget, findTarget, isTeacherUI, accessibleName, actionFromPath, pathActivates, verifyOutcome } from './resolution.js';

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
      function cleanup() {
        document.removeEventListener('click', click, true);
        signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelled);
        if (settleTimer !== null) clearTimeout(settleTimer);
        if (waiter === controller) waiter = null;
      }
      function cancelled() { cleanup(); reject(controller.signal.reason || abortError()); }
      function click(event) {
        if (!event.isTrusted || event.button !== 0) return;
        const path = event.composedPath();
        if (path.some(node => node?.nodeType === 1 && isTeacherUI(node))) return;
        const element = findTarget(target, resolver);
        let result;
        if (pathActivates(path, element)) {
          stopVisual('activated');
          paint.clear();
          result = 'correct';
        } else {
          const wrong = actionFromPath(path);
          if (!wrong) return;
          paint.flashWrong(wrong);
          result = { wrong: accessibleName(wrong) || roleName(wrong) };
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

  function roleName(element) { return element.getAttribute('role') || element.localName; }

  return {
    highlight: target => show(target, 'highlight'),
    clear,
    moveCursor: async target => { await show(target, 'cursor'); },
    demo: async target => { await show(target, 'demo'); },
    waitForClick,
    // A's current verify/wait stubs report success unconditionally. Keep this
    // adapter until A supplies real cancellable implementations; never advance
    // an outcome check because a stub returned true.
    verify: verification => verifyOutcome(verification, { signal: ensureSession(), resolver }),
    flashCorrect: () => paint.flashCorrect(),
    setCursorVisible: visible => { cursorVisible = Boolean(visible); paint.setCursorVisible(cursorVisible); },
  };
}
