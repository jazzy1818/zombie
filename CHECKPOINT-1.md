# Checkpoint 1 — what B needs from A and D

B's layer (`panel/`, `content.js`, `manifest.json`) is done and running in Chrome against the
`teach.js` stub. Full lessons play start to finish, hints escalate, wrong clicks get corrected.

Nothing below is a change to a frozen contract. It's the handful of things that only show up once
two layers touch, plus one structural change everyone should know about.

---

## Everyone — one structural change (30 seconds)

Chrome refused the module content script. `"type": "module"` is only honoured from Chrome 111+, and
where it is honoured it *also* requires every statically imported file to be web-accessible — two
independent ways to fail on a demo laptop.

So:

- `manifest.json` no longer declares `"type": "module"`
- `content.js` is now a plain script that does one thing: `import(chrome.runtime.getURL('src/main.js'))`
- **The frozen import order moved into the new `src/main.js`** — same four lines, same order, verbatim

**Your files did not change and your imports still work exactly as before.** But the file you'd look
in for the import order is now `src/main.js`, not `content.js`.

---

## A — `resolve/`

### 1. `waitForClick` must ignore clicks on B's panel  ← the only real ask

B's panel is a shadow host on `document.documentElement` with the id **`browser-teacher-root`**.
Its buttons ("Got it", "Just do it for me", "Stop") are panel UI, not the user answering a step — but
they're real clicks on the page, so your capture-phase listener will see them and report them as
wrong answers.

One line, near the top of your click handler:

```js
if (e.composedPath().some(n => n.id === 'browser-teacher-root')) return;
```

`composedPath()` rather than `e.target` because the click originates inside a shadow root, so
`e.target` is retargeted to the host and a plain `closest()` won't see the button.

### 2. Your wrong-click labels have to match C's `wrongHints` keys

When you resolve `{ wrong: name }`, B looks `name` up in `step.wrongHints` — keys C authored, e.g.
`"Font"`, `"Apply 'Title'"`, `"Make a copy"`. An exact match gives the user the specific, written
correction. A miss silently degrades to a generic one, which still works but loses the best writing
in the lesson.

Worth comparing one example with C early — B can't detect the mismatch, it just quietly gets worse.

### 3. `waitForClick` must not resolve synchronously

B loops on it: wrong click → correct → wait again. If it ever resolves without an actual user click,
that loop spins. B has a 250ms floor and bounded retries so it can't lock the tab, but a resolver
that returns instantly will race through a lesson in a way that's confusing to debug.

### 4. `find()` returning `null` is normal, not an error

B treats it as "the user hasn't opened the right menu yet" and falls back to a text-only hint while
continuing to wait — PLAN.md §8.2 tier 5. Don't add retries on B's behalf; the retry window is yours
(`RESOLVE_TIMEOUT_MS`) and B is fine with a `null` after it.

---

## D — `paint/`

### 1. The scrim will cover B's panel — needs a decision, ~2 minutes

Current z-indexes:

| Layer | z-index |
|---|---|
| D's overlay (`OVERLAY_Z`) | 2147483647 |
| B's launcher button | 2147483646 |
| B's panel | 2147483645 |

`OVERLAY_Z` is the maximum possible value, so B **cannot** go above it. As written, your full-viewport
scrim at 55% black will dim the narration panel along with the page.

That's backwards: the panel is the one thing that must stay readable while everything else is dimmed.

**Suggested fix (D's call):** inset the scrim on the panel side by `PANEL_WIDTH` from `constants.js`
— `right: 340px` — so it dims the document and stops at the panel edge. Alternatively leave a
transparent cut-out for that rect. Either is fine; B needs no change for either.

### 2. `pointer-events: none` on the overlay — B depends on it too

PLAN.md already calls this non-negotiable for Docs menus. Same applies to B: if the overlay eats
pointer events, the panel's buttons stop working and there's no way to advance an instruct-only step.

### 3. B never calls `__PAINT` directly

Everything goes through `__TEACH`. You don't need to know B exists. B's panel host is
`#browser-teacher-root` if you ever need to exclude it from something.

---

## The `teach.js` swap

`teach.js` currently holds B's stub. At Checkpoint 1 you two replace the whole file with the
reference implementation from PLAN.md §6. **B changes nothing** — same import, same object shape,
same method names.

What B calls, and what it does with the answer:

| Call | B's expectation |
|---|---|
| `highlight(t)` | `true` found, `false` → text-hint fallback, keep waiting |
| `demo(t)` | resolves when the demonstration has finished |
| `waitForClick(t)` | `'correct'` or `{ wrong: name }`. Blocks until a real click. |
| `verify(v)` | `true`/`false`. B retries twice, then advances on the click alone. |
| `flashCorrect()` | fire-and-forget |
| `setCursorVisible(v)` | B sets `false` for `solo` steps, restores `true` after |
| `clear()` | called between steps and on teardown; must be idempotent |

---

## Testing the awkward paths without a lesson going wrong

B ships console switches. DevTools → Console → switch the context dropdown from `top` to
**Browser Teacher** (extension code runs in a separate world):

```js
__BT_DEV.hints()         // hold a step open, watch hints escalate at 8s / 16s / 24s
__BT_DEV.wrong('Font')   // force a wrong click; two args exercises the generic fallback
__BT_DEV.noResolve()     // highlight() fails — the "menu not open yet" path
__BT_DEV.verifyFail()    // verify() never passes
__BT_DEV.off()
```

These wrap whatever `__TEACH` currently is, so they keep working after the real composition lands.
Useful for rehearsing the deliberate wrong click in the demo script (§14) without having to fluff it
live.

Hints only fire from **step 3** onward in `styles-toc` — step 1 is `demo` and step 2 has no target,
so neither waits on a click.
