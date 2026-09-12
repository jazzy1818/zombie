# Browser Teacher

**A teacher that lives in your browser.** It points at things and waits for *you* to click them.

Product tours (WalkMe, Pendo, Intercom) are hand-authored by humans — per app, per flow, forever.
We generate them automatically from a natural-language question, using a cloud browser agent.

**Read [PLAN.md](PLAN.md) before writing a line of code.** It is the spec, the schedule and the
contracts. This file is just how to get moving.

**[A] and [D]: read [CHECKPOINT-1.md](CHECKPOINT-1.md) before H3:30.** B's layer is built; that file
is what it needs from yours, plus one structural change to where the frozen import order lives.

---

## Two halves that never talk at runtime

**Authoring** (cloud, ahead of time) — a Steel session explores Google Docs, makes mistakes, finds
the path, prunes it, describes each step *semantically*, and replays to verify. Emits `lessons/*.json`.

**Teaching** (local, at use time) — a Chrome extension resolves those descriptors against the live
DOM, spotlights the control, narrates *why*, and **waits for the user's click**.

The handoff is a JSON file. Descriptors carry **no coordinates and no screenshots** — the cloud
browser's window differs from the user's, so coordinates don't survive the trip.

---

## Who owns what

Ownership is at **directory** level. **Nobody edits another person's directory.** That is the entire
merge-conflict strategy.

| | Owns | Branch |
|---|---|---|
| **A** | `extension/src/resolve/` — DOM intelligence. Finds elements, judges outcomes. Draws nothing. | `resolve` |
| **B** | `extension/src/panel/`, `manifest.json`, `content.js` — UI & orchestration | `panel` |
| **C** | `pipeline/`, `extension/lessons/` — the Steel pipeline and the lessons it emits | `pipeline` |
| **D** | `extension/src/paint/`, `docs/` — the visual layer. Draws. Knows nothing about Docs. | `paint` |

Merge to `main` only at Checkpoint 1 and Checkpoint 2. If you hit a conflict outside your own
directory, you've broken rule 1 — revert, don't resolve.

### The three shared files

- **`extension/src/constants.js`** — written hour 0, **never edited again**
- **`extension/src/content.js`** — B's; import order frozen
- **`extension/src/teach.js`** — the shared composition now connects the panel and paint.
  Its cancellable adapter and the handoff to A are described in
  [extension integration](docs/extension-integration.md); Contract 4 keeps its eight methods.

---

## Start working

```bash
git checkout -b <your-branch>
```

Everything is scaffolded with your interface already defined and `TODO [X]` where the body goes.
The three contracts (`window.__RESOLVE`, `window.__PAINT`, `window.__TEACH`) are frozen at hour 1 —
which is what means **no two people ever have to read each other's code.**

**Load the extension:** `chrome://extensions` → Developer mode → Load unpacked → pick `extension/`.
Refresh an HTTP/HTTPS website tab after loading or reloading the extension. The
real teach bridge connects the panel to D's paint layer. The bundled lessons are
Google Docs examples; other websites need matching lesson descriptors. See
[extension integration and testing](docs/extension-integration.md) for the local
extension fixture, cancellation behavior and the temporary adapter for A's stubs.

**Development contracts** (select the Browser Teacher console context):

```js
// B — the real __TEACH bridge composes resolution and paint
// D — no stub needed, use raw rects
__PAINT.spotlight({ top: 120, left: 300, width: 180, height: 32 });
// A — no stub needed, log elements
__RESOLVE.find({ scope: 'toolbar', name: 'Bold' }).then(console.log);
```

**Pipeline:**

```bash
cd pipeline && npm install
export STEEL_API_KEY=... PROFILE_PATH=...
```

---

## The one number to write on the wall

## 1440×900

Steel's viewport **and** the demo laptop's window. The Docs toolbar collapses controls into a `More`
overflow button as width shrinks — a button present at 1440px is **absent from the DOM** at 1000px.
If the two disagree, lessons reference elements that don't exist and it looks like a resolver bug.

Set the demo laptop's window to match before rehearsal.

---

## Two things that will bite you

- **~200 menu items are in the DOM at all times, most of them hidden.** Docs pre-renders every menu
  on page load. The `isVisible()` filter is mandatory — it's the #1 resolver risk.
- **The document body is canvas-rendered.** No DOM element exists for a paragraph, word, or cursor
  position. Lessons live in the chrome — menus, toolbar, sidebars, dialogs — **never in the page.**
  For steps that need the body, instruct and verify on a DOM side-effect.
