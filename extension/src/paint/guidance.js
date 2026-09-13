// Optional composition for click-driven guidance. Rendering stays in paint;
// target resolution and deciding a correct activation are injected by the app.
import { normalizeBox, isElement } from './geometry.js';
import { onUnmount } from './host.js';
import { watchNavigation } from './navigation.js';

function aborted(signal) {
  return signal.reason || new DOMException('Guidance cancelled', 'AbortError');
}

function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(aborted(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function afterClick(signal) {
  return new Promise((resolve, reject) => {
    let frame = 0;
    const abort = () => { cancelAnimationFrame(frame); reject(aborted(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    frame = requestAnimationFrame(() => { signal.removeEventListener('abort', abort); resolve(); });
    if (signal.aborted) abort();
  });
}

/**
 * @param {object} options
 * @param {object} options.paint Contract 3 implementation (methods are read live).
 * @param {function} options.resolve (target, {signal}) => Element|null or Promise.
 * @param {function} options.waitForActivation ({target,element,signal}) => Promise
 *   Resolve ONLY for a correct user activation; remove listeners on abort.
 * @param {function} [options.onStep] ({step,index,total,phase}) => void
 * @param {function} [options.onComplete] () => void
 * @param {function} [options.onCancel] (reason) => void
 * @param {function} [options.onError] (error) => void
 */
export function createGuidance({ paint, resolve, waitForActivation,
  onStep = () => {}, onComplete = () => {}, onCancel = () => {}, onError = () => {} }) {
  if (!paint || typeof resolve !== 'function' || typeof waitForActivation !== 'function') {
    throw new TypeError('Guidance requires paint, resolve and waitForActivation adapters.');
  }
  let current = null;
  let destroyed = false;
  const cleanVisuals = () => { paint.clear(); paint.setCursorVisible(false); };

  function cancel(reason = 'cancelled') {
    const run = current;
    if (!run) return;
    current = null;
    run.controller.abort();
    run.stopNavigation?.();
    cleanVisuals();
    onCancel(reason);
  }
  const stopUnmount = onUnmount(() => cancel('navigation'));

  async function start(input) {
    if (destroyed) throw new Error('This guidance controller was destroyed.');
    if (!Array.isArray(input) || !input.length || input.some(step => !step || !('target' in step))) {
      throw new TypeError('Guidance needs a nonempty array of steps with targets.');
    }
    const steps = input.map(step => ({ ...step }));
    cancel('replaced');
    // Recover a removed host before registering the new run's unmount lifetime.
    paint.init();
    const run = { controller: new AbortController(), stopNavigation: null };
    current = run;
    const signal = run.controller.signal;
    run.stopNavigation = watchNavigation(() => cancel('navigation'));
    const alive = () => current === run && !signal.aborted;
    try {
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        const element = await abortable(resolve(step.target, { signal }), signal);
        if (!alive()) return 'cancelled';
        if (!isElement(element)) throw new Error(`Guidance target ${index + 1} was not found.`);
        normalizeBox(element);
        const activationController = new AbortController();
        const abortActivation = () => activationController.abort();
        signal.addEventListener('abort', abortActivation, { once: true });
        let activated = false;
        try {
          // Install the activation waiter before any scrolling/animation so a
          // fast correct click is accepted. Paint never decides correctness.
          const activation = abortable(waitForActivation({
            target: step.target, element, signal: activationController.signal,
          }), activationController.signal).then(value => {
            if (alive()) { activated = true; cleanVisuals(); }
            return value;
          });
          const visuals = (async () => {
            if (!alive() || activated) return;
            paint.setCursorVisible(false);
            onStep({ step, index, total: steps.length, phase: 'preparing' });
            if (!alive() || activated) return;
            await paint.spotlight(element);
            if (!alive() || activated) return;
            paint.setCursorVisible(true);
            await paint.moveCursor(element);
            if (alive() && !activated) onStep({ step, index, total: steps.length, phase: 'waiting' });
          })();
          await Promise.all([activation, visuals]);
        } finally {
          signal.removeEventListener('abort', abortActivation);
          activationController.abort();
        }
        if (!alive()) return 'cancelled';
        // Let the user's click finish bubbling/default actions (e.g. opening a
        // dialog or navigating) before resolving the next same-page target.
        await afterClick(signal);
      }
      if (!alive()) return 'cancelled';
      current = null;
      run.stopNavigation();
      run.controller.abort();
      cleanVisuals();
      onComplete();
      return 'complete';
    } catch (error) {
      if (!alive()) return 'cancelled';
      cancel('error');
      onError(error);
      return 'error';
    }
  }

  return {
    start,
    cancel,
    get active() { return current !== null; },
    destroy() { cancel('destroyed'); stopUnmount(); destroyed = true; },
  };
}
