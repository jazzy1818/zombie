# Google Docs findings

The validated findings live in [PLAN.md §7](../PLAN.md). **Do not re-derive them.**
This file is for what we learn *during* the build.

## Open questions — resolve before the lesson is final

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
