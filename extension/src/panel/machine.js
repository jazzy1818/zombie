// [B+D] User-driven lesson orchestration. A resolves controls; D paints them.
// Every async phase belongs to a run and can be stopped without advancing it.
import { startHints } from './hints.js';

const T = () => window.__TEACH;
const MAX_VERIFY_RETRIES = 2;
// How long a "that's it" stays on screen before the next step replaces the
// card. Long enough to be read, short enough not to feel like a pause.
const OK_DWELL_MS = 900;
export const ACTION = { CONTINUE: 'continue', DEMO_REST: 'demo-rest', QUIT: 'quit', REGENERATE: 'regenerate' };
const REQUIRED = ['highlight', 'clear', 'moveCursor', 'demo', 'waitForClick', 'verify', 'flashCorrect', 'setCursorVisible'];
const aborted = () => new DOMException('Lesson cancelled', 'AbortError');

function check(signal) { if (signal?.aborted) throw aborted(); }

/** Race even legacy adapters against cancellation, and always observe failures. */
function cancellable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => finish(reject, aborted());
    const finish = (settle, value) => {
      signal?.removeEventListener('abort', cancel);
      settle(value);
    };
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    check(signal);
    const cancel = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/**
 * @param {object} opts
 * @param {number}  opts.from        step index to start at — rehearsal shortcut
 * @param {boolean} opts.regenerate  offer "not this one" on the preamble. The
 *   matcher picked this lesson for a typed question; if the user says it's the
 *   wrong one the caller sends the question to the authoring bridge instead.
 *   Resolves ACTION.REGENERATE in that case.
 */
export async function runLesson(lesson, ui, { from = 0, signal, isCurrent = () => true, regenerate = false } = {}) {
  const teach = T();
  const missing = REQUIRED.filter(method => typeof teach?.[method] !== 'function');
  if (missing.length) throw new Error('window.__TEACH is missing: ' + missing.join(', '));
  check(signal);
  const clearOnAbort = () => { if (isCurrent()) teach.clear(); };
  signal?.addEventListener('abort', clearOnAbort, { once: true });
  ui.lessonStarted(lesson);
  try {
    if (from === 0) {
      const start = await cancellable(ui.card({
        kind: 'preamble', title: lesson.goal, body: lesson.preamble,
        actions: [
          { label: 'Show me', value: ACTION.CONTINUE },
          ...(regenerate ? [{ label: "No, I'm not talking about this", value: ACTION.REGENERATE, subtle: true }] : []),
          { label: 'Not now', value: ACTION.QUIT, subtle: regenerate },
        ],
      }, { signal }), signal);
      check(signal);
      if (start === ACTION.QUIT) return;
      if (start === ACTION.REGENERATE) return ACTION.REGENERATE;
    }
    let showWhere = false;
    for (let index = from; index < lesson.steps.length; index++) {
      check(signal);
      let step = lesson.steps[index];
      if (showWhere && step.target) step = { ...step, mode: 'demo' };
      const outcome = await runStep(step, index, lesson, ui, signal);
      check(signal);
      if (outcome === ACTION.QUIT) return;
      if (outcome === ACTION.DEMO_REST) {
        showWhere = true;
        // Re-run this step with visual guidance. The user still activates it.
        if (step.target) index--;
      }
    }
    teach.clear();
    await cancellable(ui.card({
      kind: 'generalization', title: 'What you actually learned', body: lesson.generalization,
      actions: [{ label: 'Done', value: ACTION.CONTINUE }],
    }, { signal }), signal);
  } finally {
    signal?.removeEventListener('abort', clearOnAbort);
    // A cancelled older run must never clear a newly started lesson.
    if (isCurrent()) {
      teach.clear();
      teach.setCursorVisible(true);
      ui.lessonEnded();
    }
  }
}

async function runStep(step, index, lesson, ui, runSignal) {
  check(runSignal);
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort();
  runSignal?.addEventListener('abort', cancel, { once: true });
  const signal = lifetime.signal;
  ui.step(step, index, lesson.steps.length);
  T().setCursorVisible(step.mode !== 'solo');
  try {
    // Arm footer actions before resolution, scrolling, demonstration or verify.
    const action = ui.pendingAction({ signal });
    const work = step.target ? runInteractive(step, ui, signal) : runInstructOnly(step, ui, signal);
    return await cancellable(Promise.race([action, work]), signal);
  } finally {
    lifetime.abort();
    runSignal?.removeEventListener('abort', cancel);
    // Run-level cancellation already cleared the bridge. Avoid late cleanup
    // from this step touching the next run's freshly mounted paint.
    if (!runSignal?.aborted) {
      T().clear();
      T().setCursorVisible(true);
    }
  }
}

async function runInstructOnly(step, ui, signal) {
  T().clear();
  if (step.verify && step.verify.kind !== 'none') {
    if (await cancellable(T().verify(step.verify), signal)) return null;
    check(signal);
  }
  // Keep the waiter installed by runStep; only replace its visible buttons.
  ui.setActions([
    { label: 'Got it', value: ACTION.CONTINUE },
    { label: 'Stop', value: ACTION.QUIT, subtle: true },
  ]);
  return cancellable(new Promise(() => {}), signal);
}

async function runInteractive(step, ui, signal) {
  let verifyFailures = 0;
  for (;;) {
    check(signal);
    let cancelHints = startHints(step, ui, { signal });
    try {
      // The click is armed FIRST: even a click during scrolling is accepted,
      // and native dialog/menu opening is always performed by the user's click.
      let activated = false;
      const click = waitForCorrect(step, signal, name => {
        cancelHints();
        ui.wrong(wrongMessage(step, name));
        cancelHints = startHints(step, ui, { signal });
      }).then(result => { activated = true; return result; });
      const presentation = step.mode === 'demo' ? T().demo(step.target)
        : step.mode === 'guided' ? T().highlight(step.target) : Promise.resolve(true);
      const visual = Promise.resolve(presentation).then(found => {
        if (found === false && !activated && !signal.aborted) ui.hint(step.hints?.[0] || 'Open the control described above.');
        return found;
      });
      const result = await cancellable(Promise.all([click, visual]), signal);
      check(signal);
      if (result[0] === 'correct') {
        // The bridge already removed effects in the click handler. Give page
        // handlers/default actions a turn before resolving the following step.
        cancelHints();
        await pause(0, signal);
        const ok = await cancellable(T().verify(step.verify), signal);
        check(signal);
        if (ok) {
          // The wrong control earns a red note; the right one earns a green one.
          // Held briefly, because the next step's card would otherwise replace it
          // in the same frame and it would never be seen.
          ui.ok(okMessage(step));
          await pause(OK_DWELL_MS, signal);
          return null;
        }
        if (++verifyFailures > MAX_VERIFY_RETRIES) return null;
        ui.hint("That's the right control — it just didn't take. Give it another go.");
      }
    } finally {
      cancelHints();
    }
  }
}

async function waitForCorrect(step, signal, onWrong) {
  for (;;) {
    check(signal);
    const result = await cancellable(T().waitForClick(step.target), signal);
    check(signal);
    if (result === 'correct') return result;
    onWrong(result?.wrong);
    // Re-arm immediately, even if the initial smooth scroll is still running.
  }
}

function okMessage(step) {
  return step.target?.any ? "Yes — that works. Any of those would have." : "Yes — that's the one.";
}

function wrongMessage(step, name) {
  return (name && step.wrongHints?.[name]) || (name
    ? "That's " + name + ' — not quite. ' + step.intent : 'Not that one. ' + step.intent);
}
