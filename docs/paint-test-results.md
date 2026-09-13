# Paint browser test results

Run: 2026-09-13T03:49:23.354Z

Browser: 153.0.8010.37 (headless Chrome), 1440x900; responsive check at 820x700.

46/46 checks passed. Page errors: 0.

- PASS: Contract 3, idempotent init and resolver independence
- PASS: Real click-through, no focus stealing and no synthetic cursor click
- PASS: Snapshot rectangles do not follow document scroll or caller mutation
- PASS: Scroll tracking, layout shifts and responsive viewport
- PASS: Nested scrolling clips and restores the visible highlight
- PASS: Scrolling a highlighted target outside the viewport preserves dimming and click-through
- PASS: Offscreen dimming clears when the target becomes hidden or disconnected
- PASS: Offscreen window guidance scrolls progressively and resolves at the destination
- PASS: Nested guidance scrolls progressively and resolves at the destination
- PASS: Nested harness guidance awaits scroll completion before moving the ghost cursor
- PASS: Primary guidance ignores wrong clicks and clears all effects on the correct click
- PASS: Nested guidance clears after the real target is clicked
- PASS: Modal guidance waits for the opener click, then the confirmation click
- PASS: Same-page chain advances once per correct click and ignores wrong and double clicks
- PASS: Restarting guidance prevents an earlier chain from advancing
- PASS: Clearing a chain removes its pending click listener and cannot resurrect the next step
- PASS: Synchronous adapter or step-hook cancellation cannot repaint a stale guide
- PASS: Clear cancels an active scroll, settles its promise and prevents stale harness continuation
- PASS: Replacing an active offscreen scroll keeps only the latest spotlight
- PASS: Hidden menus return, removed/replaced elements require a new handoff
- PASS: Invisible ancestors, zero size, SVG and shadow-root elements
- PASS: Static controls inside fixed or absolute wrappers escape intermediate overflow clipping
- PASS: Paint containment clips an absolute target even with visible overflow
- PASS: Will-change transform establishes clipping for a fixed descendant
- PASS: Initial offscreen scroll and fixed-position targets
- PASS: Latest spotlight wins and clear settles interrupted work
- PASS: Cursor interruption and persistent solo visibility
- PASS: A ghost with no observed pointer starts at its destination instead of an invented origin
- PASS: Every ghost movement starts at the actual pointer, including after an earlier ghost movement
- PASS: Trusted pointer coordinates survive host teardown and ignore synthetic pointer events
- PASS: The resting ghost cursor follows its target, hides offscreen and stops after cleanup
- PASS: Feedback resets and does not accumulate nodes
- PASS: Reduced motion and promise return types
- PASS: Reduced-motion offscreen guidance reaches its target without animated scrolling
- PASS: Validation and explicit foreign-frame boundary
- PASS: Host teardown, pending promises and remount
- PASS: Host removal by the page recovers on the next call
- PASS: SPA navigation during scrolling cancels pending guidance and prevents stale continuation
- PASS: SPA navigation cancels the pending chain before old targets can advance it
- PASS: Pagehide clears and cancels guidance retained by a document lifecycle transition
- PASS: A real redirect clears the departing guidance and starts the next document without effects
- PASS: Host styling survives aggressive website CSS and transformed body
- PASS: A later modal can be highlighted without blur or click interception
- PASS: Static ownership boundaries and no real click dispatch
- PASS: Second website presentation needs no paint changes
- PASS: Contract 4 composition with an A-shaped resolver double

These checks load the real paint ES modules. Resolver composition uses a test double; live Google Docs and the complete extension were not tested. The screenshot is saved to `docs/.paint-artifacts/paint-workshop.png`.
