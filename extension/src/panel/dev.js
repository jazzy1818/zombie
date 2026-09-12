// [B] Scenario switches for testing the panel's failure paths by hand.
//
// The happy path is easy to see — run a lesson and it works. The paths that
// matter on stage are the awkward ones: the user sitting still while hints
// escalate, the user clicking the wrong thing, the resolver coming back empty.
// None of those happen on their own while the teach.js stub answers "correct"
// to everything, so this lets you force them.
//
// Wraps whatever window.__TEACH currently is rather than replacing it, so it
// keeps working after Checkpoint 1 when the real composition lands — useful for
// rehearsing the deliberate wrong click in the demo script (PLAN.md §14).
//
// Lives in panel/ deliberately: teach.js belongs to A and D from Checkpoint 1
// onward, and nothing here needs to touch it.
//
// Usage — DevTools console, context switched to "Browser Teacher":
//   __BT_DEV.hints()          hold the step open, watch hints escalate
//   __BT_DEV.wrong('Font')    next click is wrong; twice for the generic path
//   __BT_DEV.noResolve()      highlight() fails, step falls back to text
//   __BT_DEV.verifyFail()     verify() never passes
//   __BT_DEV.off()            back to normal

const never = () => new Promise(() => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function installDev() {
  const real = window.__TEACH;
  if (!real) return;

  let overrides = {};
  const log = msg => console.log(`%c[bt-dev] ${msg}`, 'color:#4F9CF9;font-weight:bold');

  window.__TEACH = {
    async highlight(t) {
      if (overrides.noResolve) { log('highlight -> false'); return false; }
      return real.highlight(t);
    },
    clear: () => real.clear(),
    moveCursor: t => real.moveCursor(t),
    demo: t => real.demo(t),

    async waitForClick(t) {
      if (overrides.stall) { log('waitForClick will never resolve — watch the hints'); return never(); }
      if (overrides.wrongQueue?.length) {
        const name = overrides.wrongQueue.shift();
        await sleep(600);
        log(`waitForClick -> wrong: ${name}`);
        return { wrong: name };
      }
      return real.waitForClick(t);
    },

    async verify(v) {
      if (overrides.verifyFail) { log('verify -> false'); return false; }
      return real.verify(v);
    },

    flashCorrect: () => real.flashCorrect(),
    setCursorVisible: v => real.setCursorVisible(v),
  };

  window.__BT_DEV = {
    /** Hold the current step open so the three hint tiers can escalate. */
    hints() { overrides = { stall: true }; log('stalling — tier 1 at 8s, 2 at 16s, 3 at 24s'); },

    /** Queue wrong clicks. Two names exercises the generic fallback message. */
    wrong(...names) {
      overrides = { wrongQueue: names.length ? names : ['Font'] };
      log(`queued wrong clicks: ${overrides.wrongQueue.join(', ')}`);
    },

    /** Make the resolver come back empty — the "user hasn't opened the menu" case. */
    noResolve() { overrides = { noResolve: true }; log('highlight will fail'); },

    /** Never pass verification — should retry twice, then advance on the click. */
    verifyFail() { overrides = { verifyFail: true }; log('verify will always fail'); },

    off() { overrides = {}; log('cleared'); },

    status() { return { ...overrides }; },
  };

  log('ready — __BT_DEV.hints() / .wrong() / .noResolve() / .verifyFail() / .off()');
}
