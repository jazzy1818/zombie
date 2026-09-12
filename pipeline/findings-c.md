# C's console findings

`docs/findings.md` belongs to **D**. C must not edit another person's directory, so
findings land here first and get handed to D to copy across.

Run everything on a live Doc at **1440×900**. Clicking into DevTools blur-dismisses an open
menu, so anything that needs a menu open goes behind a 5s `setTimeout`.

---

## T0 — the three open questions

### 1. `Insert → Table of contents` — blocks `styles-toc` step s6

It did not appear in the ~200-item menu dump; the Insert list ended at `Page elements►`.
If it is nested, **s6 splits into two steps**.

```js
// Open Insert, then run:
setTimeout(() => console.log(
  [...document.querySelectorAll('[role="menuitem"]')]
    .filter(e => e.offsetParent !== null)
    .map(e => e.textContent.trim())
), 5000);
```

- [ ] Result:
- [ ] Verdict: reachable in one click / nested under `______` / not found

### 2. Do menubar items (`File`, `Edit`) resolve at all?

`version-history.json` step s1 targets `{ scope: 'menu', name: 'File' }`. If the menubar
uses something other than `role="menuitem"`, that step resolves to nothing.
`dom-probe.js` queries both shapes and records which one hit in `source` — so this is
answerable directly from probe output.

```js
// Menus CLOSED. Both queries, so we learn which one carries the menubar:
console.log('role=menuitem:', [...document.querySelectorAll('#docs-menubar [role="menuitem"]')]
  .filter(e => e.offsetParent !== null).map(e => e.textContent.trim()));
console.log('aria-label:  ', [...document.querySelectorAll('#docs-menubar [aria-label]')]
  .filter(e => e.offsetParent !== null).map(e => e.getAttribute('aria-label')));
```

- [ ] Result:
- [ ] Verdict: `source` on the File candidate is `menubar-role` / `menubar-aria` / neither

### 3. Styles button readout — two `{kind:'label'}` verifies depend on it

`styles-toc` s4 and s5 both verify by reading the current style out of the toolbar. A is
reporting on this in hour 1 too; cross-check rather than trusting one of us.

```js
// Put the cursor on a Heading 1 line first.
const el = document.querySelector('#docs-toolbar-wrapper [aria-label="Styles"]');
console.log(JSON.stringify(el?.textContent), '| contains "Heading 1":',
            el?.textContent.includes('Heading 1'));
```

- [ ] Result:
- [ ] Verdict: `textContent` reliable / nest in a child / fall back to `{kind:'none'}`

### 4. Sanity check the visibility filter before trusting anything else

```js
// Format menu CLOSED — must print a much smaller number than ~200.
console.log([...document.querySelectorAll('[role="menuitem"]')]
  .filter(e => e.offsetParent !== null).length);
```

- [ ] Closed:  ____ visible   (expect a handful — the menubar)
- [ ] Format open: ____ visible   (expect ~15, not ~200)

---

## Answers to hand to D

_(paste the query and its raw output — D copies this into `docs/findings.md`)_

### CONFIRMED — viewport is genuinely 1440 in the Steel session

`assertViewport` neither threw nor warned across several `verify` runs, so `innerWidth`
is ≥1400 without needing the `Emulation.setDeviceMetricsOverride` fallback. Risk retired.

### CONFIRMED — Docs ships the menubar DISABLED until the doc loads

`version-history` s1 resolved `File` to
`<div role="menuitem" aria-disabled="true" class="goog-menuitem goog-menuitem-disabled goog-submenu">`
and Playwright waited 5s for it to become clickable. **`isVisible()` alone is not enough —
A needs an `aria-disabled` filter in `resolve/` too**, or the resolver will hand the panel
a dead element during the first seconds after load. [A]

### NEW — every toolbar dropdown exposes a second, richer aria-label

Toolbar dump while the Styles menu was open:

```
"Zoom"            "Zoom list. 100% selected."            "Zoom"
"Font size"       "Font size list. 11 selected."         "Font size"
                  "Styles list. Normal text selected."
```

So each dropdown is an outer button (`"Styles"`) plus an inner list whose aria-label
**states the current selection**: `"Styles list. Normal text selected."`

Two consequences:

1. The plain `"Styles"` button is **absent while its own menu is open**. Any step that
   targets it must run with the menu closed.
2. `"Styles list. <X> selected."` is a cleaner signal for s4/s5 than reading `textContent`
   off the button. **But `Verify.kind: 'label'` reads `textContent`, not attributes**, and
   §5 is frozen — so we cannot use it without a schema change. Worth raising with A: if
   their `verify.js` reads the aria-label for `kind:'label'` as well as textContent, both
   implementations get a much more reliable hook for free. [C + A]
