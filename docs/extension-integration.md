# Paint in the loaded extension

The extension loads the same `paint/` modules as the standalone preview. Its
classic content script imports `main.js`, which loads resolver → paint → teach →
panel in the existing order. All runtime contracts live in Chrome's extension
isolated world. The webpage's `window.__TEACH` is deliberately separate.

## Install and try it

For the complete Windows setup, normal question-based launch, and verified lesson
publication sequence, use [testing-workflow.md](testing-workflow.md).

1. Open `chrome://extensions` in Chrome and turn on Developer mode.
2. Choose **Load unpacked** and select the repository's `extension/` directory.
   For an existing installation, use its **Reload** button.
3. Refresh the website tab. The extension runs on HTTP and HTTPS pages, including
   localhost. Chrome's internal pages and other protected browser pages are outside
   this scope.
4. Open the local `docs/extension-fixture.html` test page to exercise the extension
   without importing a second copy of paint into the webpage. The original
   `paint-harness.html` remains the standalone renderer preview.

With the local fixture open, open DevTools → Console, select the **Browser
Teacher** execution context instead of `top`, and run:

```js
fetch('/docs/extension-practice.json')
  .then(response => response.json())
  .then(lesson => __BT_DEV.runLesson(lesson));
```

Click **Show me** in the extension's panel. The practice goes through a normal
button, a nested scroller, a menu, a two-step modal, a downpage target and a real
redirect. The final redirect deliberately ends the lesson. This is lesson data
only; the fixture does not import or replace the extension's renderer.

The two bundled lessons still describe Google Docs. Universal rendering and target
matching do not generate new lessons: a different website needs a lesson whose
named targets and outcomes describe that site.

## Composition and teammate handoff

- `paint/` continues to accept live Elements or viewport rectangles and contains
  no website selectors. The eight-method `__PAINT` contract is unchanged.
- `teach.js` replaces the fake-success stub with the real composition. It
  sequences smooth spotlight positioning and pointer animation, listens for real
  activation, and clears pending visual work on cancellation.
- `teaching/` contains the compatibility and lifecycle adapter around A's now
  implemented resolver. It prefers an eligible Element returned by A's live
  `findSync()` and retains generic matching for supported native/ARIA controls.
  It preserves trusted-click handling, cancellation and real outcome checks.
- `panel/machine.js` owns lesson order. Click listening begins before animations.
  Each user activation completes one step; menus and modals open through the
  website's own click handler. Demonstrations point to the control and wait for
  the user, including the first step of a modal lesson.
- The panel and paint host coordinate their top-layer order so narration and
  cancellation controls stay above the scrim. Neither layer focuses the target.

The fallback is an integration adapter, not a second site-specific resolver.
When changing which A methods it delegates to, run the loaded-extension tests and
preserve trusted-event handling, exclusion of teacher UI clicks, abortable waits,
hidden-target filtering, ambiguity handling, and real verification outcomes.

The adapter now also filters native/ARIA-disabled action targets before applying
`nth`, including Elements supplied by A. Existing retries wait for controls that
enable during application loading. `visible`, `dom` and `label` verification can
still inspect rendered disabled readouts. Label verification accepts either the
matched element's textContent or its own aria-label, with no new JSON fields.
See the [pipeline findings handoff](findings.md#pipeline-findings-applied-to-the-extension)
for the observed dropdown labels and the remaining A/C authoring alignment work.

## Behavior to preserve

1. Scroll smoothly to the resolved element, including a nested scroll container.
2. Move the ghost from the latest observed real mouse/pen position. Without an
   observed pointer, show it at the destination without inventing a starting point.
3. Keep the page dimmed when a rendered highlighted target leaves view.
4. Clear visual effects immediately on the correct real click, before verification
   finishes. Wrong clicks do not advance the lesson; teacher UI clicks are ignored.
5. Resolve the next step after the current click has finished its page action.
   Modal and menu lessons explicitly include their opener as an earlier step.
6. Stop/Close, replacement lessons, page exits and route changes cancel pending
   work. A redirected document starts without an active lesson or paint effects.

## Automated verification

Run from the repository root with Node and Playwright available:

```sh
node docs/paint-tests.cjs
node docs/extension-tests.cjs
node docs/teaching-tests.cjs
node docs/resolver-tests.cjs
```

The first suite checks standalone paint behavior. The second launches a separate
persistent Chromium profile with the actual `extension/` loaded, serves a local
fixture, and drives trusted browser input. It does not replace the resolver,
teach bridge or paint with mocks. `__BT_DEV.runLesson(lesson)` supplies fixture
lesson data through the same panel and runner used by bundled lessons. Additional
checks read the actual packaged lesson index and launch the shipped lessons by
typing into the real chat bar; an unknown question exercises the lesson picker.
One additional check collects success from a trusted local fixture replay, publishes
that lesson with the real pipeline publisher into a temporary copy of the extension,
and selects/completes it through the copied extension's normal question box. That
copy changes lesson data only; it does not replace production runtime code or run
cloud authoring.

The third suite checks semantic adapter edge cases in a real browser. Its one
explicit A handoff double checks returned-Element precedence; all remaining
checks use actual DOM elements and the production adapter. The fourth suite checks
A's resolver contract and its target/click/outcome edge cases.

Set `NODE_PATH` to an existing Playwright installation when necessary. For loaded
extension tests, use Playwright's Chromium (`npx playwright install chromium`) or
set `CHROME_PATH` to its full executable. Browser profiles and screenshots stay
under ignored `docs/.paint-artifacts/`. See
[Playwright extension testing](https://playwright.dev/docs/chrome-extensions) for
the persistent-context requirement and supported browser configuration.

Reports: [standalone paint](paint-test-results.md) and
[loaded extension](extension-test-results.md), plus
[semantic adapter checks](teaching-test-results.md) and
[resolver checks](resolver-test-results.md). Consult each report's run date,
browser version and selected-test scope; an earlier passing run is not a claim
that a later merge has already been checked.

## Limits

Live signed-in Google Docs lessons still require a separate human rehearsal.
C reports cloud replay observations in [pipeline findings](../pipeline/findings-c.md);
browser fixtures verify extension behavior, not the current labels or menu structure
of an external application. The four-step version-history lesson finishes at the
naming control and does not verify entry/submission of a name. Cross-frame targets,
canvas internals, closed shadow roots without an existing target reference, and
complex nonrectangular clipping still need appropriate adapters. Hash-only SPA
routers need an explicit cancellation hook; ordinary same-document anchor links
are intentionally allowed.
