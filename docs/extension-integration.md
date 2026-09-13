# Paint in the loaded extension

The extension loads the same `paint/` modules as the standalone preview. Its
classic content script imports `main.js`, which loads resolver → paint → teach →
panel in the existing order. All runtime contracts live in Chrome's extension
isolated world. The webpage's `window.__TEACH` is deliberately separate.

## Install and try it

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
- `teaching/` contains a separate semantic adapter for the portions of A's
  resolver that are still stubs. It prefers an Element returned by A's live
  `findSync()` and otherwise finds rendered named controls. A's files remain
  unchanged. It never accepts an immediate fake click success from the old stub.
- `panel/machine.js` owns lesson order. Click listening begins before animations.
  Each user activation completes one step; menus and modals open through the
  website's own click handler. Demonstrations point to the control and wait for
  the user, including the first step of a modal lesson.
- The panel and paint host coordinate their top-layer order so narration and
  cancellation controls stay above the scrim. Neither layer focuses the target.

The fallback is an integration adapter, not a second site-specific resolver.
Before A replaces it, run the loaded-extension tests against the replacement and
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
```

The first suite checks standalone paint behavior. The second launches a separate
persistent Chromium profile with the actual `extension/` loaded, serves a local
fixture, and drives trusted browser input. It does not replace the resolver,
teach bridge or paint with mocks. `__BT_DEV.runLesson(lesson)` supplies fixture
lesson data through the same panel and runner used by bundled lessons.

The third suite checks semantic adapter edge cases in a real browser. Its one
explicit A handoff double checks returned-Element precedence; all remaining
checks use actual DOM elements and the production adapter.

Set `NODE_PATH` to an existing Playwright installation when necessary. For loaded
extension tests, use Playwright's Chromium (`npx playwright install chromium`) or
set `CHROME_PATH` to its full executable. Browser profiles and screenshots stay
under ignored `docs/.paint-artifacts/`. See
[Playwright extension testing](https://playwright.dev/docs/chrome-extensions) for
the persistent-context requirement and supported browser configuration.

Reports: [standalone paint](paint-test-results.md) and
[loaded extension](extension-test-results.md), plus
[semantic adapter checks](teaching-test-results.md).

The pipeline-findings follow-up passed **59/59 checks** (32 loaded extension,
27 semantic adapter), with zero reported browser/extension errors in Chromium
151.0.7922.34. The extension report records an earlier shadow-modal timeout
that did not recur in focused checks or the final full run; its cause is not
established. Paint source is unchanged from the separate passing 46-check run
in Chrome 153.0.8010.36. The modal screenshot was also inspected to verify that
the target stays bright and the panel remains readable.

## Limits

Live signed-in Google Docs lessons still require a separate rehearsal with C's
verified descriptors. Browser fixtures verify extension behavior, not the
current labels or menu structure of an external application. Cross-frame targets,
canvas internals, closed shadow roots without an existing target reference, and
complex nonrectangular clipping still need appropriate adapters. Hash-only SPA
routers need an explicit cancellation hook; ordinary same-document anchor links
are intentionally allowed.
