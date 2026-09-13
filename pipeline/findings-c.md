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

### CORRECTED — the Steel session is 1435×809, not 1440×900

Earlier runs only proved `assertViewport` didn't throw, and its bar is `≥1400`. Measured:

```
local Chrome:  1440x900
Steel session: 1435x809
```

Steel's `dimensions` sets the **window**, so browser chrome comes off the inside. 1435 is
wide enough that the toolbar does not collapse — both lessons pass in the cloud — so this
is not blocking. But authoring happens at 809px tall and the learner is at 900, and
`isVisible()` is the thing that differs: a menu item near the bottom of a tall list can be
invisible to the author and visible to the learner. Worth one `Emulation.setDeviceMetrics
Override` if anything ever resolves in one environment and not the other. [C]

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
   §5 is frozen.

### RESOLVED — no schema change needed; it is a `dom` verify, not a `label` verify

`{kind:'dom', selector:'[aria-label="Zoom list. 150% selected."]'}` passes against the live
page and is already inside §8.6's whitelist of safe selectors. §5 stays frozen.

This matters because `label` **cannot** work for these controls: `Zoom`'s own `textContent`
is the empty string — the value lives only in the sibling's aria-label. Measured:

```
before: ["Zoom list. 100% selected.", "Styles list. Heading 2 selected."]
after:  ["Zoom list. 150% selected.", "Styles list. Heading 2 selected."]
```

`Styles` is the lucky case, not the rule: it carries its readout in both places, which is
why `styles-toc` s4/s6 pass with `kind:'label'`. Leave those alone. [A]

### NEW — these aria-labels are a verify signal and a descriptor trap

The same string that makes a good verify makes a **fatal** target name: it changes when the
value does. The pipeline authored a zoom lesson targeting `"Zoom list. 100% selected."`,
which replayed clean once and would have failed on any doc not already at 100%.

`dom-probe` now flags them (`c.state`) and `explore` omits them from the observation
entirely, so the model cannot pick one. **A's resolver should refuse them as target names
too** — pattern `/\b(?:list|menu)\.\s.+\sselected\.\s*$/`. A lesson that names one is
already broken. [A]

### NEW — the Word count dialog is invisible to every Verify kind

`Tools → Word count` opens a `role="dialog"` with **no `aria-label`, no `id`, and no roles
on any child**. Its only probe-visible contents are two generic buttons, `Cancel` and `OK`.

```
--- after clicking Tools ---
  TRUE   {"kind":"visible","name":"Word count","scope":"menu"}
--- after clicking Word count ---
  false  {"kind":"visible","name":"Word count","scope":"menu"}
  false  {"kind":"dom","selector":"[aria-label=\"Word count\"]"}
```

The check goes true one click early, then false again after the correct click. Nothing in
§5 can express "this dialog is open". Avoid dialog-terminated goals; the pipeline's shallow
goal is zoom instead. If B's panel ever needs to detect a Docs dialog, this is why it
can't. [B + D]
