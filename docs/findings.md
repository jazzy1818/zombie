# Integration findings

## Current handoff review — integrated main at `eae12ab`

The entries below distinguish teammate observations from local reproductions.
The earlier build notes later in this file are historical; use this section and
[the testing workflow](testing-workflow.md) for the current rehearsal.

- **A is implemented.** `resolve/` now supplies target matching, real click
  classification and verification. The teaching adapter remains necessary for
  cancellation, trusted input and generic website support. Describing A as a stub
  is no longer accurate.
- **A's new tests exposed an integration failure.** A Docs-shaped menu row
  updates the page and hides on `mouseup`. A's direct click check succeeds, but
  the bridge's later visible-target lookup loses the row. The integrated-main
  baseline reproduced this: **16/17 resolver checks passed**, with the loaded
  extension stuck after the correct action. This is a local fixture reproduction,
  not a new signed-in Docs observation.
- **C's dropdown controls include `role="option"`.** Heading and Zoom choices
  must resolve through the menu scope, including a listbox. Authoring and teaching
  must use the same enabled candidate pool and collapse nested copies of one
  control before deriving `nth`. The recorded Zoom cache uses an older raw
  candidate index and is not proof that its descriptor works in the extension.
- **Generated output is a separate handoff.** A JSON file under `pipeline/out/`
  does not appear in the extension automatically. Successful replay must precede
  publication into `extension/lessons/` and its `index.json`, followed by extension
  reload and website refresh.

### Corrections and final local verification

The integrated follow-up fixes the mouseup/click gap using a snapshot of the real
input gesture. It still completes only on a trusted click, preserves cancellation
and ignores teacher UI. Shared candidate rules now filter disabled controls and
changing state readouts before applying `nth`, collapse nested copies, and accept
option/listbox controls and the observed `Updated`/`New` menu badges. Wrong-click
labels support both the current bare lesson names and the earlier `Apply '…'`
form. Visibility and label outcomes can still inspect rendered disabled readouts.

The pipeline now has an explicit publisher and a bundled index. Publication
requires a complete successful replay bound to the exact lesson; skipped, failed,
modified and thrown replays cannot supply current default success evidence. A
local `open` crash is fixed, and cached demo replay now stops on unresolved
targets or failed outcomes. Historical Zoom cache data remains unchanged and
requires replay or regeneration before it can be treated as current evidence.

Final checks on 2026-09-13 UTC used Chromium **151.0.7922.34**:

| Suite | Result | Scope |
| --- | --- | --- |
| [Paint](paint-test-results.md) | 46/46 | Rendering, scrolling, cursor and cleanup |
| [Resolver](resolver-test-results.md) | 25/25 | A directly and through the loaded extension, including mouseup menus |
| [Teaching](teaching-test-results.md) | 34/34 | Generic matching, actual A handoff and outcome checks |
| [Extension](extension-test-results.md) | 37/37 | Real manifest, normal question box, lesson library, publication and user clicks |
| [Pipeline](pipeline-test-results.md) | 12/12 | Local observation, descriptor generation, fresh replay and publication |

**154/154 final checks passed.** The recorded browser suites reported no uncaught
page/extension errors. JavaScript syntax checks passed for all 52 source/test
files. The modal screenshot was inspected: the target stays bright, the ghost
aligns with it, and narration and Stop remain readable and accessible.

An earlier standalone run in branded Chrome 153 timed out while restarting a
guide, then during a later page navigation, before finishing the suite. The full
run above passed with unchanged assertions and no paint-source changes. The
earlier timeout's cause is not established; it is not evidence that every browser
configuration has passed. Live signed-in Docs and paid cloud/model authoring were
not run. Their rehearsal steps and remaining outcome checks are in the testing
workflow.

### Latest C observations and lesson coverage

These observations are reported in the merged `pipeline/findings-c.md` and lesson
updates. They have not been independently repeated in a signed-in Doc here.

- The Styles lesson now has **nine steps**. The confirmed authoring path is
  **Insert → Page elements → Table of contents** at s7–s9. Heading 1 and Heading 2
  are s4 and s6; their existing text-based Styles checks passed C's replay. Keep
  those verified selectors rather than applying the older proposed replacement.
- Dropdown readouts such as `Zoom list. 150% selected.` are useful **outcomes**,
  but unstable **action targets**. C demonstrated the exact attribute selector
  `{kind:'dom', selector:'[aria-label="Zoom list. 150% selected."]'}`. No new schema
  field is required. The adapter also accepts a selected element's own aria-label
  for `label` checks; that does not make a sibling readout part of another element.
- C measured a **1435×809 inner viewport in Steel** and **1440×900 locally**.
  The earlier assertion only guaranteed width ≥1400. Measure the learner's inner
  viewport and actual target availability during rehearsal; the renderer itself
  has no fixed 1440×900 requirement.
- C updated the version-history lesson to verify `[aria-label="Versions"]` and
  target `Name this version`. Its four steps stop at opening the naming control,
  with `verify:none`. The test user must still enter/submit a name and inspect the
  saved result; completing the lesson alone does not prove the full stated goal.
- The Styles lesson also ends with `verify:none`. Inspect the document to confirm
  an actual table of contents was inserted, including any final presentation
  choice required by the live application.
- C's Word count observations show that the attempted name/attribute checks
  failed or matched the menu item one step early. They do not prove that every
  possible stable `dom` selector is impossible. A reliable dialog-specific check
  remains unestablished; avoid advertising that flow as verified.

## Historical build notes

The validated findings live in [PLAN.md §7](../PLAN.md). **Do not re-derive them.**
This file is for what we learn *during* the build.

## Original open questions — superseded by the current handoff above

- [ ] **`Insert → Table of contents`** (blocks `styles-toc` step s6). It did not
      appear in the ~200-item menu dump — the Insert list ended at `Page elements►`.
      It may be nested under a submenu. If it is, s6 splits into two steps. **[C]**
- [ ] **`version-history.json` descriptors are unverified.** The lesson was drafted
      from the path in PLAN.md §9.2, not from a console dump. Confirm in the console
      that `File`, `Version history`, `See version history` and `Name current version`
      all match via the ladder, and that the menubar items (`File`) resolve at all —
      they may need tier 3 (`[aria-label]`) rather than `[role="menuitem"]`. **[C]**
- [ ] Which `verify` kind actually fires reliably for "the version history panel
      opened"? Currently `{ kind: 'none' }` as a placeholder. **[C + A]**

## The console queries

```js
// toolbar
[...document.querySelectorAll('#docs-toolbar-wrapper [aria-label]')]
  .map(e => e.getAttribute('aria-label'))

// menus — ~200 items, all present at once, most hidden
[...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim())
```

## New findings

_(append here — include the query you ran and the raw output)_

### D visual layer: local browser validation

- Paint is site-independent and consumes an Element or viewport rectangle.
- The automated command `node docs/paint-tests.cjs` loads the real paint modules
  in Chrome. Results: [paint-test-results.md](paint-test-results.md).
- The screenshot checks confirmed a blue outline/ghost cursor over a normal
  control and above a modal opened after initialization. Real clicks reached
  those controls; no focus blur occurred during modal highlighting.
- The plan's call to `findSync(target)` from paint cannot work with Contract 3's
  Element/Rect-only input. Paint tracks the supplied element; replacement requires
  A/the adapter to supply the new element. No resolver import is needed.
- B's module bootstrap is now merged. The real bridge, fallback target adapter
  and loaded-extension verification are described in
  [extension-integration.md](extension-integration.md).
- These are local fixture results, not new observations from Google Docs.

### D follow-up review and user-requested corrections

The full local paint review is recorded in [paint-review.md](paint-review.md).
The regression suite now covers persistent dimming when a target leaves view,
smooth scrolling, nested cursor sequencing, cancelled guidance, idle cursor
anchoring and three positioned/contained layout cases. The recorded run has
46 passing checks and zero page errors, including the later click-driven
sequence, actual-pointer and navigation cleanup additions.

### Pipeline findings applied to the extension

Source: [pipeline/findings-c.md at 256caad](https://github.com/jazzy1818/zombie/blob/256caadc13d808c57046485c92546ca0ec8f7864/pipeline/findings-c.md).
Read from the fetched `pipeline` branch. The observations below were reported by
C; they were not independently rerun against a signed-in Google Doc in this change.

**Visible does not mean enabled.** C's replay resolved File during document load to:

```html
<div role="menuitem" aria-disabled="true" class="goog-menuitem goog-menuitem-disabled goog-submenu">
```

The teaching adapter now excludes disabled targets before highlighting or moving
the ghost. This applies to direct Elements, A's returned Elements, fallback
matches, and click classification. The existing retry window can wait for a
control to become enabled. Native `:disabled` handles fieldset/legend behavior;
`aria-disabled="true"` also excludes descendant controls, including across open
shadow/slot boundaries. Paint itself still draws only the Elements it is given.
Outcome verification remains visibility-based: a disabled readout can still
show a valid result. Native and ARIA disabling follow the
[HTML disabled rules](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#enabling-and-disabling-form-controls:-the-disabled-attribute)
and [ARIA disabled state](https://www.w3.org/TR/wai-aria-1.2/#aria-disabled).

**Dropdown state can be exposed in an attribute.** C recorded these labels:

```text
Zoom
Zoom list. 100% selected.
Font size
Font size list. 11 selected.
Styles list. Normal text selected.
```

`verify.kind: 'label'` now checks textContent or the matched element's own
aria-label. The JSON shape is unchanged; the extension's accepted evidence is
broader. Empty matches, hidden elements, and labels on unrelated descendants do
not establish success. This is generic support for labelled readouts on any site.

C also reports that the plain Styles button is absent while its menu is open.
Keep its opener as a user-driven step and resolve the next control after the
click; do not automatically dismiss or reopen website menus to force a match.

**Still requires A/C follow-up:**

- The current s4/s5 selector matches the outer `[aria-label="Styles"]`, not the
  richer list label. C must capture the Heading 1/2 readouts, uniqueness and
  menu-closed behavior before updating those lesson selectors. The adapter
  does not guess replacement selectors or silently claim the live lesson passes.
- `pipeline/dom-probe.js` still verifies label outcomes through text only.
  Its `visible` check uses enabled target resolution. Align these semantics
  with the extension's text-or-attribute and visibility-only outcome checks
  when adopting the new readout evidence in generated lessons.
- C's `observe()` retains disabled candidates, while replay resolution skips
  them. `emit.deriveTarget()` should derive `nth` from the same enabled candidate
  pool used during replay and teaching; otherwise a disabled duplicate shifts
  the index. The extension applies `nth` after visibility and enabled filtering.
- The table-of-contents route, full version-history path, Styles textContent
  readout, and closed/open menu counts remain unfilled in the source findings.
  Finding a disabled File menuitem partly answers its role, not its full path.
- C reports its viewport assertion passed. The supplied evidence confirms a
  width of at least 1400; it does not supply a measured 1440×900 size.

Regression evidence is in [teaching-test-results.md](teaching-test-results.md)
and [extension-test-results.md](extension-test-results.md). Tests reproduce the
loading and changing-label behavior on local browser fixtures; A's resolver,
C's lessons and pipeline files remain unchanged.
