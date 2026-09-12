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
