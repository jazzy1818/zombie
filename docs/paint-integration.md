# Paint integration: handoff from D to A and B

## What is ready

The implementation is `extension/src/paint/index.js` plus its sibling modules.
Importing it installs `window.__PAINT` and initializes a passive Shadow DOM host.
It has no external runtime dependencies, site-specific selectors, resolver
imports, fixed viewport size, or code that clicks the website.

For correct-click completion, click-driven modal steps and same-page chains, use
the optional [guidance controller](paint-guidance.md). Its resolver and activation
adapters are injected, and the public paint interface below stays unchanged.

The detailed build sequence is in [paint-workflow.md](paint-workflow.md). Standalone
browser results are in [paint-test-results.md](paint-test-results.md). The real
extension now composes paint through `teach.js`; see
[extension integration](extension-integration.md) for its adapter, panel lifecycle
and loaded-extension tests. A's unfinished resolver files remain unchanged.

## Contract 3: unchanged public surface

```ts
type Rect = { top: number; left: number; width: number; height: number };
type Box = Element | Rect;

window.__PAINT = {
  init(): void,
  spotlight(box: Box): Promise<void>,
  clear(): void,
  moveCursor(box: Box): Promise<void>,
  clickCursor(): Promise<void>,
  flashCorrect(): void,
  flashWrong(box: Box): void,
  setCursorVisible(visible: boolean): void,
};
```

### What A supplies

Pass the Element returned by `__RESOLVE.find(target)` directly. Do not convert it
into a rectangle: keeping the Element lets paint follow scrolling, layout shifts,
and visibility changes. A remains responsible for selecting the correct semantic
target and judging the user's action.

- `find()` returning `null` is a resolution failure. Do not pass null to paint.
- Elements must belong to the document where paint was initialized. A may supply
  regular elements, SVG elements, or elements from that document's shadow roots.
- A hidden element is tolerated and produces no highlight. If the same connected
  element becomes visible, the active spotlight resumes automatically.
- When a rendered target scrolls outside the viewport or its scrolling container,
  the page stays dimmed. The hole and cursor disappear until it returns. Hiding
  the target with CSS removes the dimming too; removal ends guidance tracking.
- A disconnected element ends spotlight tracking. If a site replaces a control,
  resolve again and call `spotlight(newElement)` through the adapter.
- Paint does not call `findSync()`. PLAN.md's instruction to use a descriptor in
  D's animation loop conflicts with the Element/Rect-only contract. The public
  contract is preserved; semantic re-resolution stays outside paint.

### Coordinates and geometry

- Raw rectangles use the local viewport's CSS pixels, like
  `getBoundingClientRect()`. They are copied on entry and do not follow a page
  anchor. To move one, call paint again with a new rectangle.
- A supplies local live geometry, not authoring-browser coordinates. The lesson
  schema should remain semantic.
- Ordinary scroll-container clipping and viewport clipping are applied before
  drawing. The spotlight then adds the agreed four pixels of padding.
- Offscreen elements scroll smoothly into view once at the start. `spotlight()`
  waits for that scroll to settle before a caller sequences cursor movement.
  Reduced motion uses immediate positioning. Wheel/touch/pointer interaction,
  scrolling keys, clear or replacement stop the automatic scroll at its current
  position. Paint does not focus targets or repeatedly fight the user's scrolling.
- Invalid/nonfinite rectangles throw TypeError; negative dimensions throw
  RangeError; zero-area rectangles produce no visible highlight.
- Promise-returning methods reject on invalid input. Feedback methods throw
  synchronously on invalid input. Use the same error boundary as the lesson UI.

### Timing, replacement, and cleanup

- `spotlight()` resolves after the initial scroll and transition (immediately
  if neither is needed). It continues tracking until clear/removal. Resolution is not proof of
  lesson success or of a still-visible element: A owns verification.
- A new spotlight replaces the old one, cancels feedback, and settles the old
  transition's promise. Invalid new input leaves existing state unchanged.
- Cancelling native smooth scrolling allows two animation frames for a queued
  browser scroll update to drain before the old/new spotlight promises settle.
  Visual cleanup is immediate; no delayed command can stop a newer scroll.
- `moveCursor()` resolves after movement; another move or hiding the cursor
  cancels and settles it. `clickCursor()` is only a ripple/press animation.
- Movement starts at the latest trusted mouse/pen position, never the previous
  ghost position. With no observed pointer, the ghost appears at the destination
  without fabricated travel. See the pointer behavior in the guidance guide.
- Once movement finishes, the cursor stays anchored to that element. It follows
  scrolling, hides when clipped/hidden, returns with the element, and stops
  tracking when the element is removed or guidance is cleared.
- Cancelled animation promises resolve void to preserve Contract 3. B must still
  guard its own async state machine with a step/run token. Promise completion
  does not authorize a later real click after the user cancels a lesson.
- `clear()` removes the spotlight, full-page dimming, cursor and feedback; it
  cancels scrolling, animations and tracking. It preserves the requested cursor
  visibility preference for the next move. `setCursorVisible(false)` additionally
  keeps subsequent cursor moves hidden until explicitly restored for another mode.
- Moving a hidden cursor does not reveal it. Restore with
  `setCursorVisible(true)` before demo/guided cursor use.
- Reduced motion makes movement immediate and feedback brief without expansion.
- Internal `unmountHost()` in `paint/host.js` cancels all work and removes the
  host. It is not an extra public Contract 3 method. Page exit invokes it.

## Original checkpoint integration sequence

This sequence records the initial handoff. The installed composition and current
test procedure are in [extension integration](extension-integration.md).

1. Run the standalone paint tests below before merging.
2. Merge A's resolver and D's paint directory using the team's checkpoint policy.
3. Keep the existing import order: resolver, paint, teach adapter, panel.
4. A and D replace the shared `teach.js` stub together. Keep it as composition.
5. B verifies that the entry point is actually loaded as working JavaScript in
   the extension. All three `window.__*` interfaces must use the same execution
   world. An extension's isolated world and the page's main world have separate
   globals; the DevTools console must select the matching context.
6. Run one guided step with a real resolved element, then wrong-click, solo,
   cancellation and demo modes. Only then run the complete lesson.

The normal highlight adapter can be this small (proposed for the checkpoint;
not installed into the shared file by this change):

```js
async function highlight(target) {
  const element = await window.__RESOLVE.find(target);
  if (!element) {
    window.__PAINT.clear(); // no stale previous-step highlight on lookup failure
    return false;
  }
  await window.__PAINT.spotlight(element);
  return true;
}
```

The existing forwarding methods stay straightforward:

```js
waitForClick: target => window.__RESOLVE.waitForClick(target),
verify: outcome => window.__RESOLVE.verify(outcome),
clear: () => window.__PAINT.clear(),
flashCorrect: () => window.__PAINT.flashCorrect(),
setCursorVisible: visible => window.__PAINT.setCursorVisible(visible),
```

The original plan's automated demo click has been superseded by the user's
click-driven requirement. Demo mode points at the control and waits for the real
user activation. A modal lesson has an opener step followed by an inner-control
step. Neither paint nor the real teach adapter opens the modal on the user's behalf.

For guided mode, register A's capture-phase click wait before potentially long
animations so a fast user click is not missed. The panel sequences narration,
highlighting, checking the click result, and verification. Do not focus a panel
input while a website menu is active.

The workshop now uses `createGuidance()` for single targets and chains. Correct
activation clears effects immediately; the next step waits for the user's page
action to finish. Navigation aborts pending activation and visual work. It uses
an abortable run lifetime so cleared/replaced steps cannot restart the cursor.
Cursor motion remains an explicit call in the frozen paint interface.

## Shared-application integration

1. **Loading:** B's merged bootstrap loads classic `content.js`, which dynamically
   imports `main.js` in the extension isolated world. The manifest now supports
   HTTP/HTTPS websites and exposes the imported module resources on those sites.
2. **Wrong-location feedback:** Contract 3 exposes `flashWrong(box)`, but the
   frozen Contract 4 does not expose a wrong-flash method, and A returns only a
   wrong label. The current teaching adapter has the actual wrong control from
   the trusted capture event, so it calls paint with that Element and returns the
   label to B. This preserves both public interfaces and avoids guessing a
   location from a label. Keep that behavior when A takes over click resolution.

## Run and inspect locally

From the repository root, with Node, Playwright and Chrome available:

```sh
node docs/paint-tests.cjs
```

If Playwright is not installed, install it in your development environment
(`npm install --no-save --package-lock=false playwright`), or set `NODE_PATH` to
an existing installation. The test runner uses installed Chrome; set
`CHROME_PATH` to a different Chromium executable when needed. No package is
imported by the production paint code.

To use the interactive workshop, serve the repository root, for example:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/docs/paint-harness.html`. ES modules need HTTP rather
than opening the HTML with `file://`. Try the primary action, nested scroll,
wrong pulse, layout switch, clear button and modal fixture. Tests save images
in ignored `docs/.paint-artifacts/` and the readable report in this directory.

## Browser support and practical boundaries

Paint is site-independent; "universal" does not grant access to every rendering
surface. The verified scope is desktop Chrome, same-document DOM controls,
ordinary axis-aligned scrolling layouts, shadow-root elements, SVG and modal
targets. A manual popover keeps the visuals above ordinary stacking contexts
and is raised when a new guidance operation begins. There is a fixed-overlay
fallback on browsers without popovers, with weaker stacking guarantees. See
[showPopover](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/showPopover)
and [checkVisibility](https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility).
Geometry also handles fixed/absolute wrappers, paint containment and
`will-change` containing blocks; see [CSS containing blocks](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Display/Containing_block).
Smooth positioning follows [scrollIntoView](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoView).

- For iframe targets, run A/D inside that frame or translate coordinates in an
  adapter; cross-origin access/injection is an extension concern.
- Canvas/WebGL internals require an adapter supplying local rectangles and a
  separate verification signal. There is no DOM element for their internal UI.
- Arbitrary clip-paths, overlapping occluders, rotated scroll containers, mobile
  pinch zoom, fullscreen transitions and multiple concurrent teacher instances
  are not covered by this test suite. A closed shadow root requires A to already
  hold a reference to its target.
- Loaded-extension fixture coverage is documented separately in
  [extension integration](extension-integration.md). Live Docs lesson execution
  still needs rehearsal with verified lesson descriptors.
