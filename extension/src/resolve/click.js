// [A] Capture-phase click listening + wrong-click identification.
// Resolves 'correct' if the user hit the target, otherwise { wrong: <label> }
// — the best guess at what they actually hit, so the panel can correct them
// using the step's wrongHints.
//
// NOTE: Docs menus dismiss on blur. Never .focus() anything here.

export async function waitForClick(target) {
  // TODO [A]
  return 'correct';
}
