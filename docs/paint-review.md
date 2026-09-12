# D implementation review and corrections

Reviewed production paint modules, the workshop, browser checks and integration
documentation. A separate read-only review reproduced additional geometry bugs
in Chrome. This page records the original D-only review; the subsequent real
extension integration is covered in [extension-integration.md](extension-integration.md).

## Findings fixed

| Finding | Cause | Correction and evidence |
| --- | --- | --- |
| Page dimming disappears when the target scrolls out of view | Dimming was the spotlight's shadow, so hiding the spotlight also removed it | A full-viewport scrim replaces the hole while a rendered target is outside view; viewport and nested-scroll regressions verify persistence and click-through |
| Nested guidance does not move the ghost cursor | The workshop's nested button called only `spotlight()` | All workshop guidance uses one helper: await scroll/highlight, then move the cursor; test asserts call order and visible destination |
| Bringing a target into view jumps | Initial positioning explicitly requested instant scrolling | Native smooth scrolling, observed until stable, with reduced-motion fallback and interruption handling; tests record actual intermediate scroll positions |
| Cursor stays at an obsolete position after its tween ends | It stopped reading the target after arrival | Cursor remains anchored to the live element, hides when clipped/hidden, returns with it, and stops on removal/clear |
| A static control in a fixed/absolute wrapper is incorrectly clipped | Only the control's own positioning was considered | Track positioned ancestor boundaries; regressions confirm the escaped control is actually hit-testable |
| A control clipped by `contain:paint` is highlighted outside its parent | Only overflow clipping was checked | Apply paint containment clipping; browser hit tests confirm no control at the clipped location |
| A fixed child of `will-change:transform` ignores parent clipping | That containing-block trigger was missing | Include will-change and related transform/containment triggers; regression compares readRect with browser hit testing |
| Replacing a smooth scroll can report completion before it stops | Chrome can commit one queued compositor update after an instant stop | Stop immediately, allow two frames to drain, then settle both cancelled and replacement spotlight promises; never issue a delayed second scroll command |
| Clearing an in-progress workshop step can restart its cursor afterward | Async continuation was not tied to a current request | A shared run token invalidates old continuations before moving the cursor |

## Result

`node docs/paint-tests.cjs`: **46/46 passing**, zero browser page errors. See
[paint-test-results.md](paint-test-results.md) for the browser version and run.
The suite exercises actual ES modules, native smooth scrolling and pointer clicks.
The nested cursor and persistent offscreen dimming were also inspected in the
user-facing in-app preview.

The later click-driven additions were also reviewed: every move uses the last
trusted real pointer, correct activations clear effects, modal guidance waits
for its opener, chains advance one step per correct click, and navigation aborts
old work. Review caught and fixed a callback cancellation race that could repaint
after a synchronous adapter/onStep cancellation. A dedicated regression covers it.
The optional controller's A/B adapters are specified in
[paint-guidance.md](paint-guidance.md); it does not alter the eight-method paint API.

The public eight-method `__PAINT` surface is unchanged. `clear()` now cancels and
hides cursor work as well as the spotlight/feedback; the desired cursor visibility
preference remains available for the next request. `spotlight()` includes scroll
settlement in its promise. These semantics are documented for A and B in
[paint-integration.md](paint-integration.md).

## Remaining integration scope

- The separate loaded-extension suite exercises the real teach bridge, semantic
  fallback and B's panel. A's resolver files still contain stubs; live Docs needs
  a separate lesson rehearsal. See [extension integration](extension-integration.md).
- B's supported module bootstrap is merged. The frozen Contract 4 still has no
  public method for forwarding a wrong-click location.
- Cross-frame targets and complex clipping surfaces remain adapter/browser-support
  boundaries listed in the integration guide. The tests do not claim all possible
  website layouts are supported.
