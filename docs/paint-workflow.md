# D implementation workflow

The product is a universal website teacher. Google Docs is the initial demo,
not a dependency of the visual layer. D owns `extension/src/paint/` and `docs/`
on branch `paint`. This workflow describes the implementation and acceptance
gates; the browser test report records what has actually passed.

## 1. Freeze the boundary before coding

- Preserve all eight methods in PLAN.md Contract 3 (`window.__PAINT`).
- Inputs are same-document Elements or `{top,left,width,height}` snapshots in
  viewport CSS pixels. No selectors, lesson objects, app names or coordinates
  from the authoring browser belong in paint.
- Import shared constants without changing them. Do not import `resolve/`.
- A finds and verifies; D renders; B sequences steps through `__TEACH`.
- Keep shared `teach.js` unchanged until the team's integration checkpoint.
- Resolve the plan's `findSync(target)` inconsistency by tracking the supplied
  Element, hiding it when hidden/removed, and leaving semantic re-resolution to
  A/the adapter. D cannot recover a descriptor it was never given.

Acceptance: public method names/return types match the contract, and static
dependency checks find no imports from another owner's directory.

## 2. Build an isolated, passive host

`host.js` owns the host, Shadow DOM, styles, and teardown registrations.

- Idempotent mount, reusable nodes, top-level z-index from constants.
- Use a manual popover when supported to escape page stacking contexts; fixed
  overlay fallback. No focus calls, click listeners, or input interception.
- Reset host styles and keep all visual descendants pointer-transparent.
- Hide decorative content from accessibility APIs. Narration belongs to B.
- Cancel registered work on unmount/page exit. Remount cleanly after removal.

Acceptance: repeated init creates one host; hostile page CSS does not alter
geometry; a real pointer click reaches the target and retains expected focus.

## 3. Normalize geometry once

`geometry.js` validates input, reads live bounds, checks render visibility,
clips to the viewport/ordinary scrolling ancestors, and applies styles.

- Use `getBoundingClientRect()` plus a fixed overlay: never add scroll offsets.
- Rectangles are immutable snapshots for each request, not live page anchors.
- Reject foreign-document elements rather than silently using wrong coordinates.
- Support regular DOM, SVG and elements supplied from shadow roots.
- Treat zero-sized, hidden, disconnected and fully clipped targets as absent for
  the outline. A rendered offscreen target retains the full-page dimming.
- Honor positioned ancestors and CSS containment when computing clipping.
- `scroll.js` smoothly brings an offscreen element into view once without focus;
  await stable scroll positions, bound the wait, and cancel on new user input,
  replacement or clear. Reduced-motion users get immediate positioning.

Acceptance: real elements and rectangles align; nested scroll clips the hole;
removed/hidden targets do not leave a stale rectangle; invalid inputs fail clearly.

## 4. Implement the spotlight lifecycle

`spotlight.js` owns one spotlight and one requestAnimationFrame tracking loop.

- Render scrim, padded outline and radius using frozen constants.
- Transition between targets; follow scrolling/layout changes without trailing.
- Read first and write only when geometry changes.
- Retain a full-viewport scrim when a rendered target leaves view, without an
  inaccurate hole. Hide when a connected target is not rendered; allow it to reappear. Stop
  entirely on disconnection until the caller supplies another element.
- Latest request wins. `clear()` stops spotlight/cursor tracking and smooth
  scrolling, cancels transitions/feedback,
  hides the spotlight and settles an interrupted spotlight promise.
- Raw rectangles stay at their supplied viewport location on document scroll.

Acceptance: scrolling, resizing, layout shifts, rapid replacement, clear twice,
and target removal all behave predictably, with no leftover frame callbacks.

## 5. Add cursor and feedback

`animation.js` supplies cancellable promise-based animation; `cursor.js` owns
cursor position and visibility; `feedback.js` owns temporary pulses.

- Cursor movement uses CURSOR_TWEEN_MS with easing. Click is only an animation.
- Start each move from the latest trusted mouse/pen position captured by
  `pointer.js`; when no origin is known, display at the destination.
- After arrival the cursor follows its live anchor, hides out of view, and
  returns when that element is visible again.
- Replaced/cancelled animations settle; no caller waits forever.
- Hiding the cursor cancels its pending visual work. Moving it while hidden
  does not show it; B explicitly restores it when leaving solo mode.
- Honor reduced-motion preferences with immediate movement/minimal feedback.
- Green current-target pulse, red location pulse, no real click dispatch.
- Unmount cleans up animations and temporary nodes.

Acceptance: no synthetic clicks, completed and interrupted promises settle,
solo visibility persists, reduced motion works, feedback disappears.

## 6. Verify in an actual browser

Build `docs/paint-harness.html` with contrasting website layouts and targets:
normal buttons, nested scroll, fixed controls, hidden menus, layout shifts,
shadow-root targets, SVG, a modal, and an offscreen target. Load actual ES modules.

Run `docs/paint-tests.cjs` using Playwright and installed Chrome. The runner
serves the repository on loopback, runs behavioral assertions, captures a
screenshot, writes a report, and always closes the server/browser. Include an
A-shaped resolver double and a Contract 4 adapter inside the test only, proving
the composition without editing A's unfinished resolver or the shared stub.

Acceptance: contract, behavior, cleanup, click-through, scroll tracking and
composition checks pass; screenshot is visually inspected. Record limitations
instead of claiming untested live-Docs or full-extension behavior.

## 7. Deliver the integration handoff

`docs/paint-integration.md` specifies arguments, return values, cancellation,
disappearance, same-frame constraints, integration examples, and B's loader
check. Follow the checkpoint order: load resolver, paint, real teach adapter,
panel; then run one guided step before the full lesson.

The merged classic content script dynamically imports `main.js`. All three
interfaces run in the same extension isolated world. The subsequent real bridge
and loaded-extension workflow are documented in
[extension-integration.md](extension-integration.md).

## 8. Demo acceptance

After integration: run guided/solo/demo modes, intentionally click wrong, close
the target menu, resize/scroll, end and restart the lesson. Test a second website
with the same paint files. Use 1440x900 for the Docs rehearsal because the sample
lesson depends on its toolbar layout; paint itself has no fixed viewport.

Prepare the sample Doc, rehearse, and record the backup only after the integrated
application works. Those external activities are separate from local code QA.

## 9. Click-driven sequences and navigation cleanup

`guidance.js` is an optional composition layer with injected resolution and
correct-activation adapters. Keep the eight paint methods unchanged. Register a
waiter before visuals, clear on correct activation, wait for the page click to
finish, then resolve the next step. Abort listeners/continuations on replacement,
clear or route/document navigation. The modal fixture must be opened by the user.

Acceptance: real pointer origins, correct-click cleanup, wrong-click persistence,
two modal steps, ordered same-page chain, no double-click skipping, no stale
continuations after cancellation, and no effects on the destination page. Adapter
contracts and the pointer/navigation boundaries are in [paint-guidance.md](paint-guidance.md).
