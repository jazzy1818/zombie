// [B] The demo / guided / solo state machine. PLAN.md §5.
//
//   demo    → __TEACH.demo(target); narrate; advance
//   guided  → highlight, then WAIT for the user's click. The waiting IS the
//             product — don't shortcut it.
//   solo    → setCursorVisible(false), no highlight; verify by outcome
//
// A step with target: null is instruct-only (canvas actions Docs gives us no
// element for) — narrate, then verify on a DOM side-effect.

export async function runStep(step) {
  // TODO [B]
}

export async function runLesson(lesson) {
  // TODO [B] — preamble card → steps → generalization card
}
