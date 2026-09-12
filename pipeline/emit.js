// [C] Stage 4 — semantic emission. MUST emit exactly the extension/lessons/
// format (PLAN.md §5). The two hand-written lessons in extension/lessons/ are
// this emitter's executable spec.
//
// Record WHAT the thing was, never where. No coordinates, no screenshots —
// the cloud browser's window differs from the user's.
//
// Authoring rules:
//   - `name` is the BARE label: "Paragraph styles", never "Paragraph styles►"
//   - never include shortcuts: "Find and replace", not "Find and replaceCtrl+H"
//   - never include CSS classes — Docs classes are minified and change
//   - `nth` counts VISIBLE matches only, not DOM matches
//
// Narration is written here, with the full trace as context — that's what lets
// it explain WHY rather than just naming the button.

export function emit(prunedTrace, meta) {
  // TODO [C] — returns a Lesson object
}
