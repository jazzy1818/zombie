// [C] Stage 5 — verification replay. The highest-value thing Steel does.
// Fresh session, clean state, replay using ONLY the emitted descriptors — not
// the original trace, the actual JSON you're about to ship.
//
//   completes → valid, ship
//   fails     → descriptors too fragile, discard and re-run
//
// You can't test a lesson against a user's real account. Here you can test it
// a hundred times against throwaway ones.

export async function verifyLesson(lesson) {
  // TODO [C] — returns boolean
}
