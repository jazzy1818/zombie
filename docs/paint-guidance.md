# Click-driven guidance and same-page chains

The visual API remains the eight methods in Contract 3. The optional
`createGuidance()` export in `extension/src/paint/guidance.js` composes those
methods with injected target resolution and correct-activation adapters.
It can drive a single step or a sequence without changing A's resolver files.

## Behavior

1. Resolve the step's target to a live Element.
2. Install the correct-activation waiter before scrolling or animation.
3. Show the prompt and smoothly bring the target into view.
4. Move the ghost from the latest observed real pointer to the target.
5. Wait for the user to activate the right control. Wrong clicks do not advance.
6. Clear dimming, outline, ghost and feedback immediately on a correct activation.
7. Let the click finish its page action, then resolve the next same-page target.
8. End after the final step. Cancel on clear, replacement, teardown or navigation.

No controller code opens menus/dialogs or dispatches page clicks. Those are
consequences of the user's real click and the website's normal event handler.
The workshop demonstrates a modal as **Open modal fixture -> Confirm in modal**,
and a chain as **Preview -> Options -> Schedule publication**.

## Integration with A and B

```js
import { createGuidance } from './paint/guidance.js';

const guide = createGuidance({
  paint: window.__PAINT,
  resolve: (target, { signal }) => resolveTarget(target, signal),
  waitForActivation: ({ target, element, signal }) =>
    waitUntilCorrect({ target, element, signal }),
  onStep: ({ step, index, total, phase }) =>
    showInstruction(step.prompt, index + 1, total, phase),
  onComplete: () => showLessonComplete(),
  onCancel: reason => dismissInstruction(reason),
  onError: error => showLessonError(error),
});

await guide.start([
  { target: { name: 'Options' }, prompt: 'Click Options.' },
  { target: { name: 'Schedule publication' }, prompt: 'Now schedule the publication.' },
]);
```

`resolveTarget`, `waitUntilCorrect` and the UI callbacks above are the A/B
integration adapters, not globals installed by paint. The standalone workshop
uses CSS selectors and a small capture-phase click waiter for its known fixtures.
Production continues to use A's semantic descriptors and outcome checks.

### Adapter requirements

- `resolve(target, {signal})` returns `Element|null` or a promise. Resolve the next
  target only when its page UI is ready; A can use its existing retry behavior.
- `waitForActivation({target, element, signal})` must return a promise that resolves
  **only for a correct activation**. A's `waitForClick()` wrong-label result is not
  a successful activation: keep waiting/report its correction rather than resolving.
- Remove click/outcome listeners when the signal aborts. The controller cancels
  its own wait even if a provider ignores the signal, but it cannot remove
  listeners owned by an opaque provider. A can supply a cancellable adapter or an
  optional signal argument while retaining existing call compatibility.
- If a step needs outcome verification, perform it in the injected activation
  adapter before resolving. The workshop uses click correctness only.
- `onStep` receives `{step,index,total,phase}` with zero-based index and phases
  `preparing` then `waiting`. Callbacks must not focus the website away from an
  active menu. Cancellation/replacement inside a callback is supported.
- Use one controller per teaching flow. `start()` cancels its previous run and
  returns a promise resolving to `complete`, `cancelled` or `error`.
- `cancel(reason)` removes current work; `destroy()` also removes the controller's
  lifecycle subscription. `.active` reports whether a run is in progress.
- Raw rectangles remain valid for paint, but a click-driven controller requires
  an Element and an activation adapter. It cannot infer which click a rectangle
  represents.

## Actual pointer origin

`pointer.js` observes trusted mouse/pen `pointermove` and `pointerdown` events in
viewport CSS pixels. Each `moveCursor()` samples the latest actual pointer
position, including moves between steps. Clearing/remounting paint preserves that
position; leaving the document, losing focus, hiding or exiting the page resets it.

Browsers do not expose an arbitrary OS cursor position. Before any real pointer
event, or for keyboard/touch entry, there is no reliable origin. The ghost appears
at its destination without invented travel in that case. Synthetic events cannot
spoof the recorded origin. Tracking listeners are installed once per document and
do not intercept input.

## Navigation behavior

Normal document exits, reloads and redirects clear the host. SPA changes to
origin/path/query also clear it and abort active guide listeners/continuations.
Nothing is saved or restarted on the destination page, including a return through
the browser's back/forward cache. A new guide must be explicitly started.

Same-page fragment anchors are treated as scrolling within the existing page.
For applications that encode page routes in `#...`, call `guide.cancel('navigation')`
from the router's route-change hook. The browser Navigation API is used when
available; older browsers get page lifecycle/history listeners plus a scoped
URL check. Website history methods are never patched.

References: [Navigation events](https://developer.mozilla.org/en-US/docs/Web/API/Navigation/navigate_event),
[pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event).

## Workshop controls

- **Highlight primary action**, **Highlight nested target**, **Guide me down the
  page**: one correct click completes and clears each guide.
- **Guide me in a modal**: first click the highlighted opener yourself, then the
  highlighted confirmation. If the dialog is already open, guide its confirmation.
- **Try a 3-step guide**: Preview -> Options -> Schedule publication, on one page.
- **Try next-page cleanup**: follow the actual link to a new page; no old effects
  or pending chain remain.
- **Clear visuals**: cancel any current sequence, including in-progress scrolling.

The readable floating prompt is workshop UI. B can render the controller callbacks
in the existing side panel instead. See [paint-test-results.md](paint-test-results.md)
for the actual browser run and [paint-integration.md](paint-integration.md) for the
remaining full-extension checkpoint work.
