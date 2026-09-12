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
