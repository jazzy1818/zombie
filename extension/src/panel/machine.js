// [B] The lesson runner: narrate → branch on mode → verify → advance.
//
// Pure orchestration. Touches no DOM of its own — the host page goes through
// window.__TEACH, the panel goes through the injected `ui` facade. That's what
// lets this run end-to-end against the teach.js stub before A's resolver or D's
// overlay exist.
import { startHints } from './hints.js';

const T = () => window.__TEACH;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * How many times we'll disbelieve a correct click before giving up on verify
 * and advancing anyway.
 *
 * PLAN.md §15 lists "Styles button textContent doesn't expose current style" as
 * a live risk whose sanctioned fallback is `verify.kind: 'none'` — advance on
 * the click alone. This is that fallback, applied at runtime: a broken verify
 * hook must never trap the user on a step they've already done correctly.
 */
const MAX_VERIFY_RETRIES = 2;

/** Breath after a wrong click. Long enough to read the correction, and it caps
 *  the loop rate so a misbehaving waitForClick can't spin the tab. */
const RE_ARM_MS = 250;

/** Actions the panel can hand back while a step is waiting. */
export const ACTION = {
  CONTINUE: 'continue',   // "Got it →" on instruct-only steps
  DEMO_REST: 'demo-rest', // "Just do it for me"
  QUIT: 'quit',
};

export async function runLesson(lesson, ui) {
  ui.lessonStarted(lesson);

  try {
    const start = await ui.card({
      kind: 'preamble',
      title: lesson.goal,
      body: lesson.preamble,
      actions: [{ label: 'Show me', value: ACTION.CONTINUE }, { label: 'Not now', value: ACTION.QUIT }],
    });
    if (start === ACTION.QUIT) return;

    for (let i = 0; i < lesson.steps.length; i++) {
      const outcome = await runStep(lesson.steps[i], i, lesson, ui);

      if (outcome === ACTION.QUIT) return;
      if (outcome === ACTION.DEMO_REST) {
        await demoRemaining(lesson, i, ui);
        break;
      }
    }

    T().clear();
    await ui.card({
      kind: 'generalization',
      title: 'What you actually learned',
      body: lesson.generalization,
      actions: [{ label: 'Done', value: ACTION.CONTINUE }],
    });
  } finally {
    T().clear();
    T().setCursorVisible(true);
    ui.lessonEnded();
  }
}

async function runStep(step, index, lesson, ui) {
  ui.step(step, index, lesson.steps.length);

  // The ghost cursor is the teacher's hand. On a `solo` step there is no
  // teacher — that's the point of the step.
  T().setCursorVisible(step.mode !== 'solo');

  try {
    if (!step.target) return await runInstructOnly(step, ui);
    if (step.mode === 'demo') return await runDemo(step, ui);
    return await runInteractive(step, ui);
  } finally {
    T().setCursorVisible(true);
  }
}

/**
 * target: null — a canvas action Docs gives us no element for ("click the title
 * line, watch the Styles box"). We can't highlight it and we can't detect it.
 *
 * If the step has a real verify we poll that. If it doesn't (styles-toc s2),
 * there is genuinely nothing to wait on, so we ask the user to tell us they're
 * done. Safe here specifically because no menu is open on an instruct-only
 * step — the focus change can't dismiss anything.
 */
async function runInstructOnly(step, ui) {
  T().clear();

  if (step.verify && step.verify.kind !== 'none') {
    const ok = await T().verify(step.verify);
    if (ok) return null;
  }

  return ui.actions([
    { label: 'Got it', value: ACTION.CONTINUE },
    { label: 'Just do it for me', value: ACTION.DEMO_REST, subtle: true },
  ]);
}

async function runDemo(step, ui) {
  await T().demo(step.target);
  await T().verify(step.verify);
  T().clear();
  return null;
}

/**
 * guided and solo. The difference is one line — whether we show them where it
 * is — and that one line is the entire product.
 */
async function runInteractive(step, ui) {
  if (step.mode === 'guided') {
    const found = await T().highlight(step.target);

    // Resolver came back empty. Almost always means the user hasn't opened the
    // menu the target lives in — which is exactly the state this step is
    // waiting on, not an error. Degrade to a text hint and keep waiting.
    // (PLAN.md §8.2 tier 5.)
    if (!found) ui.hint(step.hints?.[0] || 'Have a look through the menus.');
  } else {
    T().clear();
  }

  let verifyFailures = 0;

  for (;;) {
    const cancelHints = startHints(step, ui);

    let result;
    try {
      // Race the page click against the panel's own buttons, so "just do it for
      // me" still works while we're blocked waiting for a click that may never
      // come.
      result = await Promise.race([
        T().waitForClick(step.target).then(r => ({ click: r })),
        ui.pendingAction().then(a => ({ action: a })),
      ]);
    } finally {
      cancelHints();
    }

    if (result.action) return result.action;

    if (result.click === 'correct') {
      T().flashCorrect();
      const ok = await T().verify(step.verify);
      if (ok) {
        T().clear();
        return null;
      }

      // Right control, wrong outcome. Ask them to try once more — but only
      // once. Past that, believe the click and move on: a verify hook that
      // can't see a correct action is our bug, and making the user pay for it
      // by trapping them on the step is worse than advancing optimistically.
      if (++verifyFailures > MAX_VERIFY_RETRIES) {
        console.warn(`[browser-teacher] ${step.id}: verify never passed, advancing on the click`);
        T().clear();
        return null;
      }

      ui.hint("That's the right control — it just didn't take. Give it another go.");
      await sleep(RE_ARM_MS);
      continue;
    }

    // Wrong click. This is a teaching moment, not a failure state: correct them
    // and go straight back to waiting.
    ui.wrong(wrongMessage(step, result.click?.wrong));
    if (step.mode === 'guided') await T().highlight(step.target);
    await sleep(RE_ARM_MS);
  }
}

function wrongMessage(step, name) {
  const specific = name && step.wrongHints?.[name];
  if (specific) return specific;
  if (name) return `That's ${name} — not quite. ${step.intent}`;
  return `Not that one. ${step.intent}`;
}

/** "Just do it for me" — also the panic button if a step wedges on stage. */
async function demoRemaining(lesson, from, ui) {
  for (let i = from; i < lesson.steps.length; i++) {
    const step = lesson.steps[i];
    ui.step(step, i, lesson.steps.length);
    T().setCursorVisible(true);

    if (step.target) {
      await T().demo(step.target);
      await T().verify(step.verify);
    } else {
      // Nothing to click on the user's behalf — narrate it and move on.
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  T().clear();
}
