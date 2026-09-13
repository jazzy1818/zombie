# Browser Teacher

**A teacher that lives in your browser.** It points at things and waits for *you* to click them.

> Product tours (WalkMe, Pendo, Intercom) are hand-authored by humans — per app, per flow, forever.
> We generate them automatically from a natural-language question, using a cloud browser agent.

**Hackathon:** Web Agents track · Steel.dev required · 4 people · 10 hours
**Target app:** Google Docs

---

## Table of contents

1. [The product](#1-the-product)
2. [Architecture](#2-architecture)
3. [Locked constants](#3-locked-constants--do-not-change)
4. [Repo structure & file ownership](#4-repo-structure--file-ownership)
5. [Contract 1 — Lesson JSON schema](#5-contract-1--lesson-json-schema)
6. [Contracts 2–4 — the three interfaces](#6-contracts-24--the-three-interfaces)
7. [Google Docs findings (validated)](#7-google-docs-findings-validated)
8. [The resolver & the paint layer](#8-the-resolver--the-paint-layer)
9. [The lessons](#9-the-lessons)
10. [The Steel pipeline](#10-the-steel-pipeline)
11. [10-hour schedule](#11-10-hour-schedule)
12. [Per-person task lists](#12-per-person-task-lists)
13. [Git workflow](#13-git-workflow)
14. [Demo script](#14-demo-script)
15. [Risks](#15-risks)
16. [Cut list](#16-cut-list)

---

## 1. The product

You're in Google Docs, lost. You open a side panel and type *"how do I add a table of contents?"*

The page dims except for one highlighted control. A narration explains **why** that control is the right one. Then it **stops and waits for you to click it.** It does not click for you.

- Stall for 8 seconds → escalating hints, conceptual before spatial before exact
- Click the wrong thing → it explains why that was wrong, then redirects
- By the last step → highlights disappear entirely; you do it alone
- At the end → a **generalization**, not a "complete" badge

Lessons are not hand-authored. A Steel.dev cloud browser agent explores the app ahead of time, works out the correct path, and emits a lesson file the extension replays.

### The teaching model — gradual release

| Mode | Behaviour |
|---|---|
| `demo` | Agent performs the step itself with the ghost cursor, narrating. Step 1 only — establishes the pattern. |
| `guided` | Highlight appears, narration explains, **agent blocks and waits for the user's click.** The default. |
| `solo` | Narration states the goal only. **No highlight.** Agent watches and verifies. |

**The inversion that makes this a teacher:** the agent is blocked on user action by default. Autopilot ("just do it for me") is an explicit escape hatch, never the default path.

### Why teach instead of automate

Agents and MCP handle tasks where only the output matters. This handles tasks where the **capability** is what you wanted — and tasks where you're not *allowed* to delegate. Nobody should let an AI submit their tax return, their immigration form, or their child's school registration. You have to be the person who clicked submit.

---

## 2. Architecture

Two halves that **never talk to each other at runtime.** The handoff is a JSON file.

```
┌────────────── AUTHORING (cloud, ahead of time) ───────────────┐
│  Steel session (cloud Chrome @ 1440×900)                      │
│    1. explore app over CDP, make mistakes, find the path      │
│    2. prune the trace to load-bearing steps only              │
│    3. describe each step semantically (never coordinates)     │
│    4. write narration + hints                                 │
│    5. REPLAY in a fresh session to verify                     │
└───────────────────────────────────────────────────────────────┘
                            ↓ emits
                    lessons/*.json
                            ↓
┌────────────── TEACHING (local, at use time) ──────────────────┐
│  Chrome extension, content script in the user's real Doc      │
│    1. resolve descriptors against the LIVE DOM                │
│    2. spotlight + ghost cursor                                │
│    3. narrate in the side panel                               │
│    4. WAIT for the user's click                               │
│    5. verify by outcome, advance                              │
└───────────────────────────────────────────────────────────────┘
```

**Why the split:** discovering an unknown app means being wrong repeatedly — ~40 actions to find 6 correct ones. That must never happen in a user's real account while they wait. It happens once, in a sandbox, hours earlier.

**Critical:** descriptors contain **no coordinates and no screenshots.** The cloud browser's window differs from the user's. Coordinates don't survive the trip. Semantic descriptors do.

---

## 3. Locked constants — DO NOT CHANGE

Single source of truth: `extension/src/overlay/constants.js`. Mirrored in `pipeline/config.js`.

```js
export const VIEWPORT        = { width: 1440, height: 900 };  // Steel AND demo laptop
export const TARGET_URL      = 'https://docs.google.com/document/d/*';

// Timing
export const RESOLVE_TIMEOUT_MS = 2000;   // resolver retry window
export const IDLE_HINT_MS       = 8000;   // before hint tier 1
export const HINT_ESCALATE_MS   = 8000;   // between subsequent tiers
export const CURSOR_TWEEN_MS    = 600;    // ghost cursor travel
export const TRANSITION_MS      = 250;    // spotlight move
export const DEMO_DWELL_MS      = 900;    // pause before demo-mode click
export const VERIFY_TIMEOUT_MS  = 3000;

// Spotlight geometry
export const SPOT_PADDING = 4;
export const SPOT_RADIUS  = 8;
export const SCRIM        = 'rgba(0,0,0,0.55)';
export const OVERLAY_Z    = 2147483647;

// Colors
export const ACCENT  = '#4F9CF9';
export const CORRECT = '#34A853';
export const WRONG   = '#EA4335';

// Panel
export const PANEL_WIDTH = 340;
export const PANEL_SIDE  = 'right';

// Pipeline
export const MAX_AGENT_ACTIONS = 15;      // hard cap; lost agents stay lost
export const AGENT_STEP_TIMEOUT_MS = 8000;
```

### Why 1440×900 specifically

The Docs toolbar collapses controls into a `More` overflow button as width decreases. A button present at 1440px is **absent from the DOM** at 1000px. If the Steel authoring session and the demo laptop disagree on width, lessons reference elements that don't exist and it looks like a resolver bug.

**Write 1440×900 on the wall. Set the demo laptop's window to match before rehearsal.**

---

## 4. Repo structure & file ownership

**Ownership is at directory level. Nobody edits another person's directory.** This is the entire merge-conflict strategy.

The overlay is split into **two independent layers** so no single person owns a disproportionate chunk:

- **Layer 1 — DOM intelligence [A]:** *finds* elements and *judges* outcomes. Pure logic. Returns elements. Draws nothing.
- **Layer 2 — Paint [D]:** *draws* on the page. Pure rendering. Takes an element or a raw rect. Knows nothing about Docs.

They meet in a ~40-line composition file written jointly at Checkpoint 1.

```
browser-teacher/
├── README.md
├── PLAN.md                       ← this file
│
├── extension/
│   ├── manifest.json             ← [B]
│   ├── src/
│   │   ├── content.js            ← [B] entry point
│   │   ├── teach.js              ← [SHARED] ~40-line composition, written at Checkpoint 1
│   │   ├── constants.js          ← [SHARED] §3. Written hour 0, never edited after.
│   │   │
│   │   ├── resolve/              ← [A] EXCLUSIVE — DOM intelligence
│   │   │   ├── index.js          ← builds window.__RESOLVE
│   │   │   ├── visible.js        ← isVisible()
│   │   │   ├── match.js          ← toolbarMatch, menuMatch
│   │   │   ├── resolver.js       ← tryResolve, resolve (ladder + retry)
│   │   │   ├── click.js          ← waitForClick, capture-phase, wrong-click identification
│   │   │   └── verify.js         ← all four Verify kinds
│   │   │
│   │   ├── paint/                ← [D] EXCLUSIVE — visual layer
│   │   │   ├── index.js          ← builds window.__PAINT
│   │   │   ├── host.js           ← shadow DOM host, mount/unmount
│   │   │   ├── spotlight.js      ← scrim, outline, rAF reposition loop
│   │   │   ├── cursor.js         ← ghost cursor, tween, click animation
│   │   │   └── feedback.js       ← correct/wrong pulses, scrollIntoView
│   │   │
│   │   └── panel/                ← [B] EXCLUSIVE — UI & orchestration
│   │       ├── panel.js          ← side panel, narration, cards
│   │       ├── panel.css
│   │       ├── machine.js        ← demo/guided/solo state machine
│   │       └── hints.js          ← idle timers, escalation
│   │
│   └── lessons/                  ← [C] EXCLUSIVE — same format C's pipeline emits
│       ├── styles-toc.json
│       └── version-history.json
│
├── pipeline/                     ← [C] EXCLUSIVE
│   ├── config.js
│   ├── session.js
│   ├── explore.js
│   ├── prune.js
│   ├── emit.js                   ← must emit exactly extension/lessons/ format
│   ├── verify.js
│   └── fallback-demo.js
│
└── docs/                         ← [D]
    ├── demo-script.md
    └── findings.md
```

### Why lessons belong to C

C's pipeline emits Lesson JSON. **C hand-writes both lessons in hour 1** — which doubles as the
executable spec for their own emitter. Writing the target output by hand before building the thing
that generates it is the right order, and it removes a cross-person dependency.

### The three shared files

| File | Rule |
|---|---|
| `constants.js` | Written in hour 0 by whoever opens the repo first. **Never edited again.** |
| `content.js` | B's. The import order is agreed in hour 0 and not touched after. |
| `teach.js` | Written **jointly at Checkpoint 1** by A and D, in the room, in one sitting. ~40 lines. |

```js
// content.js — agreed hour 0, frozen
import './resolve/index.js';   // defines window.__RESOLVE  [A]
import './paint/index.js';     // defines window.__PAINT    [D]
import './teach.js';           // composes window.__TEACH   [shared]
import { mountPanel } from './panel/panel.js';
mountPanel();
```

---

## 5. Contract 1 — Lesson JSON schema

**Frozen at hour 1. Nobody changes this afterwards.** If something doesn't fit, work around it in your own layer.

```ts
type Lesson = {
  id: string;
  app: 'google-docs';
  goal: string;              // "Add an automatic table of contents"
  preamble: string;          // mental model, shown before step 1
  generalization: string;    // the transferable rule, shown at the end
  steps: Step[];
};

type Step = {
  id: string;
  intent: string;            // the WHY — this is the narration
  mode: 'demo' | 'guided' | 'solo';
  target: Target | null;     // null only for instruct-only steps
  action: 'click';           // v1 scope: click only. No typing, no drag.
  verify: Verify;
  hints: [string, string];   // [conceptual, spatial]
  wrongHints?: Record<string, string>;  // targetName → correction message
};

type Target = {
  scope?: 'toolbar' | 'menu' | 'any';   // default 'any'
  name: string;              // BARE name. No shortcut. No trailing ►
  nth?: number;              // when >1 VISIBLE match remains. 0-indexed.
};

type Verify =
  | { kind: 'label';   selector: string; match: string }  // element text contains match
  | { kind: 'dom';     selector: string }                 // element appears
  | { kind: 'visible'; name: string; scope?: string }     // named element becomes visible
  | { kind: 'none' };                                     // advance on click alone
```

### Authoring rules

- `name` is always the **bare** label: `"Paragraph styles"`, never `"Paragraph styles►"`
- Never include shortcuts: `"Find and replace"`, never `"Find and replaceCtrl+H"`
- Never include CSS classes — Docs classes are minified (`gb_Je`) and change between deploys
- `nth` counts **visible** matches only, not DOM matches

---

## 6. Contracts 2–4 — the three interfaces

Three interfaces, so **no two people ever read each other's code.** Frozen at hour 1.

### Contract 2 — `window.__RESOLVE` · built by [A]

DOM intelligence. Finds things, judges outcomes. **Draws nothing.**

```ts
window.__RESOLVE = {
  /** Resolve a target to a live element. null = not found (user likely hasn't
   *  opened the right menu). Retries for RESOLVE_TIMEOUT_MS. */
  find(target: Target): Promise<Element | null>;

  /** Synchronous single attempt. Used by the rAF loop to detect disappearance. */
  findSync(target: Target): Element | null;

  /** Blocks until the user clicks anywhere. Capture-phase.
   *  'correct' if they hit target; otherwise the best-guess label of what they did hit. */
  waitForClick(target: Target): Promise<'correct' | { wrong: string }>;

  /** Outcome check per the Verify union. Polls to VERIFY_TIMEOUT_MS. */
  verify(v: Verify): Promise<boolean>;
};
```

### Contract 3 — `window.__PAINT` · built by [D]

Visual layer. Draws. **Knows nothing about Docs, menus, or lessons.**

Every method accepts an `Element` **or** a raw `{top,left,width,height}` rect — which is what lets D
build and test the entire layer with hardcoded rects, before A's resolver exists.

```ts
type Box = Element | { top: number; left: number; width: number; height: number };

window.__PAINT = {
  /** Mount shadow host. Idempotent. Called once on load. */
  init(): void;

  /** Draw/move the spotlight. Starts the rAF reposition loop.
   *  Scrolls the target into view first. */
  spotlight(box: Box): Promise<void>;

  /** Remove spotlight, stop the rAF loop. Idempotent. */
  clear(): void;

  /** Animate the ghost cursor to box over CURSOR_TWEEN_MS. No click. */
  moveCursor(box: Box): Promise<void>;

  /** Ghost cursor click animation (ripple + depress). Does NOT dispatch a real click. */
  clickCursor(): Promise<void>;

  /** Green pulse on the current spotlight. */
  flashCorrect(): void;

  /** Red pulse at a location, then fade. Used for wrong clicks. */
  flashWrong(box: Box): void;

  /** Show/hide the ghost cursor entirely (hidden during `solo` steps). */
  setCursorVisible(v: boolean): void;
};
```

### Contract 4 — `window.__TEACH` · composed in `teach.js` · [A + D jointly at Checkpoint 1]

What B calls. Thin glue over the two layers — ~40 lines, no logic of its own.

```ts
window.__TEACH = {
  highlight(target): Promise<boolean>;   // find → spotlight. false if not found.
  clear(): void;
  moveCursor(target): Promise<void>;
  demo(target): Promise<void>;           // find → move → dwell → clickCursor → el.click()
  waitForClick(target): Promise<'correct' | { wrong: string }>;
  verify(v): Promise<boolean>;
  flashCorrect(): void;
  setCursorVisible(v: boolean): void;
};
```

Reference implementation — copy this verbatim at Checkpoint 1:

```js
window.__TEACH = {
  async highlight(t) {
    const el = await __RESOLVE.find(t);
    if (!el) return false;
    await __PAINT.spotlight(el);
    return true;
  },
  clear: () => __PAINT.clear(),
  async moveCursor(t) {
    const el = await __RESOLVE.find(t);
    if (el) await __PAINT.moveCursor(el);
  },
  async demo(t) {
    const el = await __RESOLVE.find(t);
    if (!el) return;
    await __PAINT.spotlight(el);
    await __PAINT.moveCursor(el);
    await new Promise(r => setTimeout(r, DEMO_DWELL_MS));
    await __PAINT.clickCursor();
    el.click();
  },
  waitForClick: t => __RESOLVE.waitForClick(t),
  verify: v => __RESOLVE.verify(v),
  flashCorrect: () => __PAINT.flashCorrect(),
  setCursorVisible: v => __PAINT.setCursorVisible(v),
};
```

### Stubs — write yours before anything else

**B stubs `__TEACH`:**

```js
const sleep = ms => new Promise(r => setTimeout(r, ms));
window.__TEACH = {
  highlight: async t => (console.log('HL', t), true),
  clear: () => console.log('CLEAR'),
  moveCursor: async t => console.log('CURSOR', t),
  demo: async t => (console.log('DEMO', t), await sleep(800)),
  waitForClick: async t => (await sleep(1500), 'correct'),
  verify: async v => true,
  flashCorrect: () => console.log('OK'),
  setCursorVisible: v => console.log('CURSORVIS', v),
};
```

**D stubs nothing — uses raw rects:**

```js
__PAINT.init();
__PAINT.spotlight({ top: 120, left: 300, width: 180, height: 32 });
__PAINT.moveCursor({ top: 400, left: 500, width: 60, height: 24 });
```

**A stubs nothing — logs elements:**

```js
__RESOLVE.find({ scope: 'toolbar', name: 'Bold' }).then(console.log);
```

---

## 7. Google Docs findings (validated)

All confirmed by console query on a live document. **Do not re-derive these.**

### Toolbar — clean

```js
[...document.querySelectorAll('#docs-toolbar-wrapper [aria-label]')]
  .map(e => e.getAttribute('aria-label'))
```

→ `Undo (⌘Z)`, `Styles`, `Font size`, `Bold (⌘B)`, `Insert link (⌘K)`, `Insert image`, `More`, `Editing mode`, ~20 more.

**Format:** `aria-label`, shortcut in **parentheses**, platform-specific (`⌘B` on Mac, `Ctrl+B` on Windows).

### Menus — all present at once

```js
[...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim())
```

→ **~200 items.** Every menu: File, Edit, View, Insert, Format, Tools, Gemini, Extensions, Help, Accessibility, plus all submenus.

**Docs pre-renders every menu into the DOM on page load and hides them.** There is no lazy rendering.

**Format:** `textContent`, shortcut **concatenated with no separator**, submenus suffixed `►`, accelerators as `(Q)`.
Examples: `OpenCtrl+O` · `Find and replaceCtrl+H` · `Paragraph styles►` · `Apply 'Heading 1'Ctrl+Alt+1` · `Approvals(F2)`

### Consequences

| Finding | Consequence |
|---|---|
| **~200 menu items always in DOM, most hidden** | **`isVisible()` filter is mandatory.** #1 resolver risk. |
| Heavy duplicates: `Image►`×2, `Table►`×3, `Delete`×2, `Rename`×2, `Copy link`×2, Accessibility block ×2 | Visibility filter resolves most. `nth` for the rest. |
| Menu shortcuts concatenated | **Prefix match, not regex.** |
| Toolbar vs menu use different formats | Two separate match functions. |
| `More` overflow exists | Lock viewport to 1440×900. |
| Classes minified (`gb_Je`, `gb_Xe`) | Never author against CSS classes. |
| **Menus dismiss on blur** | B: never `.focus()` during a step. A: `pointerEvents:'none'` on spotlight. |

### The hard boundary — canvas

**The document body is canvas-rendered.** No DOM element exists for a paragraph, word, or cursor position.

- ✅ Highlightable: menu bar, toolbar, sidebars, dialogs, outline pane, share modal
- ❌ Not highlightable: anything inside the document text

**Design rule: lessons live in the chrome, never in the page.**

For steps needing the body, **instruct and verify on a DOM side-effect**:

> "Put your cursor anywhere in the title line — then watch the Styles box in the toolbar."

The highlight lands on the Styles dropdown (DOM). Verification reads that dropdown's text, which reflects the current paragraph's style. A real signal about a canvas-only action — and how a human tutor would phrase it anyway.

### Confirmed paths

- `Format → Paragraph styles► → Heading 1► → Apply 'Heading 1'` — **four levels.** Prefer the 2-click toolbar Styles dropdown for taught steps; reserve the menu path for `solo`, where hunting is the point.
- `File → Version history►`
- `Insert → Table of contents`

---

## 8. The resolver & the paint layer

> §8.0–8.3, 8.5, 8.6 are **[A]**. §8.4 is **[D]**. They share no code.

### 8.0 Visibility filter — write this first · [A]

```js
export function isVisible(el) {
  if (!el || el.offsetParent === null) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
```

**Apply before every match, at every tier.** An invisible element is never a valid target — it means the user hasn't opened the right menu yet, which is exactly the state a `guided` step should be waiting on.

### 8.1 Two match strategies · [A]

```js
// TOOLBAR — aria-label, parenthesised shortcut: "Bold (⌘B)"
export function toolbarMatch(el, name) {
  const label = el.getAttribute('aria-label')
    ?.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return label === name;
}

// MENU — textContent, concatenated shortcut: "Find and replaceCtrl+H"
// Prefix match also handles "Paragraph styles►" and "Approvals(F2)"
export function menuMatch(el, name) {
  const t = el.textContent.trim();
  return t === name || t.startsWith(name);
}
```

Prefix matching is deliberate: robust against shortcut format, platform, submenu arrows and accelerators, without a fragile regex.

### 8.2 Resolution ladder · [A]

Every tier filters through `isVisible()` **first**.

| Tier | Query | Match |
|---|---|---|
| 1 | `#docs-toolbar-wrapper [aria-label]` | `toolbarMatch` |
| 2 | `[role="menuitem"]` | `menuMatch` |
| 3 | `[aria-label]` (dialogs, sidebars, share modal) | `toolbarMatch` |
| 4 | apply `nth` to whatever the above returned | — |
| 5 | fail → return `false`, panel falls back to text-only hint | — |

`scope` in the target skips to the relevant tier. **Never tier on CSS class names.**

### 8.3 Retry loop · [A]

```js
export async function resolve(target, timeout = RESOLVE_TIMEOUT_MS) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const el = tryResolve(target);
    if (el) return el;
    await new Promise(r => requestAnimationFrame(r));
  }
  return null;
}
```

Menu items pre-exist, so this is **not** the critical path it was once thought to be. Still needed for dialogs, sidebars, the share modal, and the gap between clicking a menu and its items becoming visible.

### 8.4 Spotlight · [D]

```js
const r = el.getBoundingClientRect();
Object.assign(spot.style, {
  position: 'fixed',
  top:    `${r.top  - SPOT_PADDING}px`,
  left:   `${r.left - SPOT_PADDING}px`,
  width:  `${r.width  + SPOT_PADDING * 2}px`,
  height: `${r.height + SPOT_PADDING * 2}px`,
  borderRadius: `${SPOT_RADIUS}px`,
  boxShadow: `0 0 0 9999px ${SCRIM}`,   // dims everything else
  outline: `2px solid ${ACCENT}`,
  pointerEvents: 'none',                 // ← MUST
  zIndex: String(OVERLAY_Z),
  transition: `all ${TRANSITION_MS}ms ease`,
});
```

**`pointerEvents: 'none'` is non-negotiable.** Two reasons: if the overlay eats the click the user can't complete the step, and any pointer event on the overlay would blur-dismiss the Docs menu you're highlighting.

**Mount in a shadow DOM host** on `document.body` — Docs' global CSS will otherwise wreck your styling.

**D takes an `Element` or a raw rect.** Normalize on entry (`box.getBoundingClientRect?.() ?? box`) so the whole layer is testable with literal coordinates before A's resolver exists.

Reposition with a `requestAnimationFrame` loop while a step is active. Cheaper to write than wiring scroll + resize + mutation observers. Call `__RESOLVE.findSync(target)` each frame to notice the target disappearing (menu closed) — that is the only call D makes into A's layer. Call `el.scrollIntoView({ block: 'center' })` before highlighting.

### 8.5 Click detection — capture phase · [A]

Docs calls `stopPropagation`. Bubble-phase listeners will miss clicks.

```js
document.addEventListener('click', handler, true);  // ← true = capture
```

### 8.6 Verification · [A]

Prefer outcome over click. This is what gives **alternate correct paths** for free — if the user hits `Ctrl+Alt+1` instead of navigating the menu, the outcome is identical and the step passes. Accept it and say so.

```js
// kind: 'label'  — read current style from the toolbar Styles button
document.querySelector('#docs-toolbar-wrapper [aria-label="Styles"]')
  ?.textContent.includes('Heading 1')
```

> **A: verify the exact Styles readout in hour 1.** The button may nest the style name in a child element. If `textContent` is unreliable, fall back to `{ kind: 'visible', name: "Apply 'Heading 1'" }` checking the menu's checked state, or `{ kind: 'none' }`.

---

## 9. The lessons

### 9.1 `styles-toc.json` — HERO · [C]

Seven steps. Real concept underneath. **Build this first; it carries the demo.**

```json
{
  "id": "styles-toc",
  "app": "google-docs",
  "goal": "Add an automatic table of contents",
  "preamble": "A table of contents in Docs isn't something you write — it's something Docs builds for you, from your headings. So the real task is teaching Docs which lines are headings. That's what styles are for.",
  "generalization": "You never touched the table of contents itself — it built itself from your headings. That's the whole point of styles: they describe what text *is*, not what it looks like. It's also why the outline pane on the left already works now, and why exporting to PDF will keep your structure.",
  "steps": [
    {
      "id": "s1",
      "mode": "demo",
      "intent": "This box in the toolbar always shows the style of whatever line your cursor is on. Right now it says 'Normal text'. Watch it as I move around.",
      "target": { "scope": "toolbar", "name": "Styles" },
      "action": "click",
      "verify": { "kind": "none" },
      "hints": ["It's in the toolbar, left of the font name.", "Top-left area of the toolbar."]
    },
    {
      "id": "s2",
      "mode": "guided",
      "intent": "Click anywhere on the document's title line. You won't see anything change in the document — watch the Styles box instead.",
      "target": null,
      "action": "click",
      "verify": { "kind": "none" },
      "hints": ["The very first line of the document.", "Top of the page, the big line of text."]
    },
    {
      "id": "s3",
      "mode": "guided",
      "intent": "Now open the Styles dropdown. This is where you tell Docs what kind of line this is.",
      "target": { "scope": "toolbar", "name": "Styles" },
      "action": "click",
      "verify": { "kind": "visible", "name": "Apply 'Heading 1'", "scope": "menu" },
      "hints": ["The box showing 'Normal text'.", "Toolbar, just right of the undo/redo arrows."],
      "wrongHints": {
        "Font": "That's the typeface — it changes how text looks. We want to change what the text *is*.",
        "Font size": "Size is cosmetic. Styles carry meaning, which is what a table of contents reads."
      }
    },
    {
      "id": "s4",
      "mode": "guided",
      "intent": "Choose Heading 1. You're telling Docs 'this line is a top-level section'.",
      "target": { "scope": "menu", "name": "Apply 'Heading 1'" },
      "action": "click",
      "verify": { "kind": "label", "selector": "#docs-toolbar-wrapper [aria-label=\"Styles\"]", "match": "Heading 1" },
      "hints": ["Look for the largest heading option.", "Below 'Title' and 'Subtitle' in the list."],
      "wrongHints": {
        "Apply 'Title'": "Title works visually, but Docs treats it as the document name — it won't appear as a section in the contents."
      }
    },
    {
      "id": "s5",
      "mode": "guided",
      "intent": "Same thing for a section heading — put your cursor on one of the section lines and make it Heading 2. Heading 2 nests underneath Heading 1, which is how the contents gets its indentation.",
      "target": { "scope": "menu", "name": "Apply 'Heading 2'" },
      "action": "click",
      "verify": { "kind": "label", "selector": "#docs-toolbar-wrapper [aria-label=\"Styles\"]", "match": "Heading 2" },
      "hints": ["Open the Styles box again, one step down from Heading 1.", "Directly below 'Heading 1' in the dropdown."]
    },
    {
      "id": "s6",
      "mode": "solo",
      "intent": "Your turn, no highlight this time. Your headings are set — now insert the table of contents itself. Have a look through the menus.",
      "target": { "scope": "menu", "name": "Table of contents" },
      "action": "click",
      "verify": { "kind": "visible", "name": "Table of contents", "scope": "menu" },
      "hints": ["You're adding something new to the document — which menu handles that?", "It's in the Insert menu, near the bottom."]
    }
  ]
}
```

> **C: confirm `Insert → Table of contents` in the console before finalising.** It did not appear in the ~200-item dump (the Insert list ended at `Page elements►`) — it may be nested under a submenu. If so, split s6 into two steps.

### 9.2 `version-history.json` — BACKUP HERO · [C]

Four steps, entirely menu-driven, **zero canvas dependency**. Safest lesson in the build. If Lesson 1 stalls at Checkpoint 2, this becomes the demo.

`File → Version history► → See version history` → name the current version → done.

**Preamble:** every keystroke you've ever made in this document is already saved. You're not turning on backups — you're learning to read a timeline that already exists.

**Generalization:** naming a version is just bookmarking a point on a timeline Docs was recording anyway. Same reason you never have to press save.

### 9.3 Cut: sharing permissions

Share button → link access → commenter vs. editor. **Not built in v1.**

---

## 10. The Steel pipeline

### Stage 1 — Session with a body

Steel session, viewport `1440×900`, injected **saved profile** (cookies + localStorage from a Google account logged in by hand ahead of time). Browser wakes up past the login wall.

**This is why auth isn't a problem.** Log in once, ever.

### Stage 2 — Exploration loop

Over CDP: **read** the accessibility tree (not screenshots — cheaper, faster, more reliable) → **decide** (LLM picks one action) → **act** → **observe**. Repeat to goal.

**Hard cap at `MAX_AGENT_ACTIONS = 15`**, then fail and re-run. A lost agent stays lost; letting it wander burns minutes producing nothing.

### Stage 3 — Pruning

~40 actions in, most of it garbage. Replay backwards from the success state; keep only load-bearing actions.

**If you ship the raw trace, your teacher walks users through the agent's mistakes.** You'd be teaching confusion. The pruned path is the lesson.

### Stage 4 — Semantic emission

Record **what the thing was**, never where. Bare names, `nth` when needed. Write narration here with the full trace as context — that's what lets it explain *why* rather than just naming the button.

### Stage 5 — Verification replay

Fresh session, clean state, **replay using only the emitted descriptors** — not the original trace, the actual JSON you're about to ship.

- Completes → valid, ship
- Fails → descriptors too fragile, discard and re-run

Highest-value thing Steel does, and impossible without a cloud browser. You can't test a lesson against a user's real account. Here you can test it a hundred times against throwaway ones.

### Timing

~5–8s per agent step → **2–4 minutes per lesson**. Parallelises flatly. This is **build time, not user time** — the user hits a file that already exists.

### The self-healing story (pitch material)

App ships a redesign → lessons fail verification → re-run overnight → regenerate. **No human re-authors anything.** WalkMe's entire cost structure is humans re-authoring tours forever. This makes it a cron job.

---

## 11. 10-hour schedule

### H0:00–0:30 · Kickoff (all four, no code)

1. **Confirm the visibility filter (2 min).** Open a Doc, click Format, run — on a 5s `setTimeout`, since clicking into DevTools blur-dismisses the menu:
   ```js
   setTimeout(() => console.log(
     [...document.querySelectorAll('[role="menuitem"]')]
       .filter(e => e.offsetParent !== null)
       .map(e => e.textContent.trim())
   ), 5000);
   ```
   **~15 items (Format only), not ~200** → proceed.
2. Read §5 and §6 aloud. Everyone agrees. **Frozen.**
3. Agree the `content.js` import line (§4). Whoever opens the repo first writes `constants.js` from §3 — **never edited again.**
4. Write **1440×900** on the wall.
5. D creates the demo doc: a title + 3–4 section headings as plain text, ready to be styled. Share edit access with all.

### H0:30–3:30 · Solo build, zero dependencies

Nobody talks to anybody. Everyone has what they need.

### H3:30–4:00 · **CHECKPOINT 1** (mandatory, all four, one laptop)

1. **A and D write `teach.js` together** — copy the reference implementation from §6, ~40 lines, one sitting.
2. B deletes the `__TEACH` stub, imports the real `teach.js`.
3. Run **step s1 only**, end to end, on C's `styles-toc.json`.
4. Fix what breaks.

It will be ugly. Fine. **Bugs here cost minutes; the same bugs at hour 8 cost the project.**

This is the first and only moment the four layers touch. Everything before it was independent by design.

### H4:00–6:30 · Solo build round 2

### H6:30–7:00 · **CHECKPOINT 2**

**`styles-toc` must run start to finish, no console errors.**
If it doesn't → cut lesson 2, cut Steel live generation, everyone onto lesson 1.

### H7:00 · **FEATURE FREEZE — HARD STOP**

No new features. Whatever works, works.

### H7:00–9:00 · Polish & rehearse

- Smooth transitions — they carry ~80% of perceived quality
- **Record the backup video first**, while the build is known-good
- Run the demo three times, start to finish
- D presents to A/B/C playing skeptical judges

### H9:00–10:00 · Buffer

It will get used.

---

## 12. Per-person task lists

Roughly equal implementation weight. **Nobody is blocked by anybody before Checkpoint 1.**

| | Owns | Approx. lines | Tests against |
|---|---|---|---|
| **A** | `resolve/` | ~250 | live Docs page in console — no UI needed |
| **B** | `panel/`, `manifest.json`, `content.js` | ~400 | `__TEACH` stub — no overlay needed |
| **C** | `pipeline/`, `lessons/` | ~400 | Steel sessions + hand-written JSON |
| **D** | `paint/`, `docs/` | ~250 + demo | hardcoded rects — no resolver needed |

---

### A — DOM intelligence · owns `extension/src/resolve/`

*Finds elements and judges outcomes. Draws nothing. Never imports from `paint/`.*

**Develop in the DevTools console on a live Doc.** No extension, no reload cycle, no dependency on anyone.

- [ ] `visible.js` — `isVisible()`. **First thing you write. Everything depends on it.**
- [ ] `match.js` — `toolbarMatch()`, `menuMatch()` (§8.1)
- [ ] `resolver.js` — `tryResolve()` ladder, every tier through `isVisible()` (§8.2)
- [ ] `resolver.js` — `find()` with rAF retry loop (§8.3); `findSync()` for D's reposition loop
- [ ] `click.js` — `waitForClick()`, capture-phase listener (§8.5)
- [ ] `click.js` — wrong-click identification: given the clicked element, return its best-guess label so B can look it up in `wrongHints`
- [ ] `verify.js` — all four `Verify` kinds (§8.6)
- [ ] `index.js` — export `window.__RESOLVE` exactly per Contract 2
- [ ] **Report to C in hour 1:** does the Styles button's `textContent` reliably contain the current style name? If not, C changes the verify hooks in the lesson JSON.

**Self-test:**
```js
__RESOLVE.find({scope:'toolbar', name:'Bold'})            // → element
__RESOLVE.find({scope:'menu', name:'Paragraph styles'})   // Format CLOSED → MUST be null
__RESOLVE.find({scope:'menu', name:'Paragraph styles'})   // Format OPEN   → element
```
**If call 2 returns an element instead of `null`, your visibility filter is broken and every lesson will silently target invisible items.**

---

### B — UI & orchestration · owns `extension/src/panel/`, `manifest.json`, `content.js`

*Drives the lesson. Never touches the DOM of the host page directly — always through `__TEACH`.*

**Write the `__TEACH` stub (§6) first. Do not wait for A or D.**

- [ ] Manifest v3, content script on `TARGET_URL`
- [ ] `content.js` import order per §4 — agreed hour 0, frozen
- [ ] Side panel injected into the page (**not** a browser popup — popups close)
- [ ] `panel.css` — panel chrome, cards, typography
- [ ] Lesson loader — reads bundled JSON from `extension/lessons/`
- [ ] Preamble card
- [ ] `machine.js` — narrate → branch on `mode` → `verify` → advance
  - `demo` → `__TEACH.demo(target)`
  - `guided` → `highlight()` then `waitForClick()`
  - `solo` → `setCursorVisible(false)`, `waitForClick()` with **no** highlight
  - `target: null` → instruct only, then `verify`
- [ ] `hints.js` — `IDLE_HINT_MS` timer → tier 1 conceptual → tier 2 spatial → tier 3 `highlight()`
- [ ] Wrong-click messaging — use `wrongHints[name]` when present, generic fallback otherwise
- [ ] Generalization card
- [ ] "Just do it for me" → runs remaining steps via `demo()`
- [ ] Step progress indicator
- [ ] **Focus discipline audit — your responsibility.** Never `.focus()` any panel element while a step is active. No autofocused input. Docs menus dismiss on blur.

---

### C — Authoring · owns `pipeline/`, `extension/lessons/`

*Depends on nobody. Outputs files.*

**H0:30–2:00 — hand-write both lesson JSONs first.** They are the executable spec for your own emitter,
and they mean the product exists whether or not the pipeline ever runs. §9.1 has `styles-toc.json` in full — start from it.

- [ ] `lessons/styles-toc.json` — hero lesson
- [ ] `lessons/version-history.json` — backup hero
- [ ] **Verify `Insert → Table of contents` in the console.** It wasn't in the ~200-item dump (Insert ended at `Page elements►`) — may be nested. Split step s6 if so.
- [ ] Get exact labels from the console yourself. **Don't guess them.**
- [ ] `config.js` — mirror §3 constants
- [ ] `session.js` — Steel session, viewport 1440×900, saved Google profile
- [ ] `explore.js` — a11y-tree read over CDP, loop, `MAX_AGENT_ACTIONS` cap
- [ ] `prune.js` — backward replay, keep load-bearing actions
- [ ] `emit.js` — descriptors: bare names, no shortcuts, no `►`, `nth` when needed. **Must match `lessons/` format exactly.**
- [ ] `verify.js` — fresh-session replay of the emitted JSON
- [ ] `fallback-demo.js` — Steel session viewer with the overlay injected via `addInitScript`

**If exploration is unreliable by H3:30, stop and go all-in on the fallback demo. That call is yours alone.**

---

### D — Visual layer & demo · owns `extension/src/paint/`, `docs/`

*Draws on the page. Knows nothing about Docs, menus, or lessons. Never imports from `resolve/`.*

**Develop with hardcoded rects.** You need no resolver, no lessons, no panel — just a Doc page and a
literal `{top,left,width,height}`. This is the most demo-visible code in the repo.

- [ ] `host.js` — shadow DOM host on `document.body`, mount/unmount. **Docs' global CSS will wreck unshadowed styles.**
- [ ] `spotlight.js` — scrim + outline per §8.4. `pointerEvents:'none'` is **non-negotiable**
- [ ] `spotlight.js` — rAF reposition loop while active; call `__RESOLVE.findSync()` each frame to detect the target disappearing
- [ ] `spotlight.js` — `scrollIntoView({block:'center'})` before first paint
- [ ] `cursor.js` — ghost cursor element, eased tween over `CURSOR_TWEEN_MS`
- [ ] `cursor.js` — `clickCursor()` ripple + depress animation
- [ ] `cursor.js` — `setCursorVisible()` for `solo` steps
- [ ] `feedback.js` — `flashCorrect()` green pulse, `flashWrong()` red pulse + fade
- [ ] `index.js` — export `window.__PAINT` exactly per Contract 3
- [ ] Demo doc: title + 3–4 section headings as plain text, ready to style. Share edit access with all.
- [ ] `docs/findings.md` — record console query results as they come in
- [ ] Play naive user against the real build from H4; file bugs
- [ ] `docs/demo-script.md`
- [ ] Record the backup video at H7, while the build is known-good
- [ ] Own rehearsals — you made it look good, you present it

**Self-test, hour 1, before anything else exists:**
```js
__PAINT.init();
__PAINT.spotlight({top:120, left:300, width:180, height:32});   // scrim + outline appear
__PAINT.moveCursor({top:400, left:500, width:60, height:24});   // cursor glides
__PAINT.flashCorrect();
```
**Then scroll the page.** If the spotlight doesn't track, your rAF loop is wrong — fix it before anything else. This is the bug most likely to look fine in testing and break on stage.

---

## 13. Git workflow

```
main                    ← only merged at checkpoints
├── resolve   [A]  extension/src/resolve/
├── panel     [B]  extension/src/panel/, manifest.json, content.js
├── pipeline  [C]  pipeline/, extension/lessons/
└── paint     [D]  extension/src/paint/, docs/
```

`extension/src/teach.js` is written once, jointly, at Checkpoint 1 — on `main`, with A and D in the
same room. It is the only file two people touch, and it is touched exactly once.

**Rules:**

1. **Nobody edits another person's directory.** Ever. If you need a change there, message them.
2. Merge to `main` only at Checkpoint 1 and Checkpoint 2. Not continuously.
3. Commit on your own branch as often as you like.
4. **After H7:00 freeze — bugfix commits only.** No new files.
5. If you hit a merge conflict outside your own directory, **you have broken rule 1.** Revert, don't resolve.

Four people in one content script at hour 8 produces a conflict you cannot debug in time. This structure makes that impossible rather than merely discouraged.

---

## 14. Demo script

Run in a **normal Chrome window at 1440×900** on a real Google Doc. No localhost app, no dashboard, no "here's our backend."

1. **Open the prepared doc.** Ask: *"how do I add a table of contents?"*
2. **Preamble card lands.** Read it out — it's the pitch in miniature.
3. **Lesson runs.** At the first `guided` step: **let two full seconds of silence run** with the highlight sitting there, waiting, before clicking.
   > **This pause is the entire product.** Don't rush past it. If a judge instinctively reaches for their own trackpad, you've won.
4. **Deliberately click the Font box at step s3** — shows the wrong-click correction.
5. **Step s6 is `solo`** — no highlight. Presenter hunts for Insert → Table of contents unaided.
6. **End on the generalization line.** Read it aloud.
7. **Then Steel, once:** *"Everything so far was pre-authored. Here's what happens with something we've never seen."* Fire a **deliberately shallow 2–3 step task (~40 seconds)**, narrating over the session viewer.

### Live-demo timing warning

A full lesson takes 2–4 minutes to generate. That kills a 5-minute demo. Either keep the live task trivially shallow, **or** kick the live run off at the *start* and return to it at the end as a callback.

### Answers to expect

| Question | Answer |
|---|---|
| "Why not just automate it?" | Agents handle tasks where only the output matters. This handles tasks where the capability is the point — and tasks you're not allowed to delegate. Nobody should let an AI submit their tax return. |
| "Isn't this just WalkMe?" | WalkMe tours are hand-authored, per app, per flow, by humans. We generate them. That's the whole difference. |
| "What happens when the UI changes?" | Re-run the pipeline; verification catches what broke; regenerate. It's a cron job, not a re-authoring project. |
| "Docs is shallow — what's lesson ten?" | Own it. Docs is the breadth proof. Shallow apps prove reach, deep apps prove retention, the engine doesn't care which it's teaching. |

---

## 15. Risks

| Risk | Mitigation | Owner |
|---|---|---|
| Resolver matches a hidden menu item from an unopened menu | `isVisible()` filter (§8.0). **Highest-likelihood failure.** | A |
| Menu text match fails on concatenated shortcut | `startsWith` prefix match, never regex (§8.1) | A |
| Panel focus blur-dismisses the menu being highlighted | No `.focus()` during a step; `pointerEvents:'none'` | B, D |
| Spotlight doesn't track on scroll | rAF loop, tested by scrolling in hour 1 | D |
| `teach.js` becomes a dumping ground for logic | It is glue only. Logic belongs in `resolve/` or `paint/`. | A, D |
| Toolbar collapsed on demo machine → elements missing | Viewport locked 1440×900, verified before rehearsal | all |
| Toolbar shortcut format differs Mac ↔ Windows | Normalize in resolver, never in lesson file | A |
| `Insert → Table of contents` nested deeper than assumed | C verifies in hour 1; split s6 if needed | C |
| Styles button `textContent` doesn't expose current style | A reports in hour 1; fall back to `verify.kind: 'none'` | A |
| Docs global CSS wrecks the overlay | Shadow DOM host | D |
| Steel exploration unreliable | C's H3:30 call → all-in on fallback demo | C |
| Live demo too slow | Shallow task, or start-early-callback | D |
| Conference wifi | Everything cached offline + recorded backup video | D |
| Merge conflict at hour 8 | Directory ownership (§13) | all |
| Google ships a UI change mid-hackathon | aria-labels far more stable than classes; re-run console queries | A |

---

## 16. Cut list

Drop **top-first** when behind:

1. Steel live generation → demo pre-cached lessons only
2. `version-history.json` → one lesson is a fine demo
3. Wrong-click handling → just don't click wrong on stage
4. Hint tier 2 (spatial) → keep conceptual and exact
5. Ghost cursor → the spotlight alone still works

### Never cut

- **The spotlight**
- **The agent waiting for the user**
- **The `solo` step**

Those three *are* the product. Everything else is decoration.

---

## 17. Addendum — overnight batch generation · open items for [C]

> Added by **B** after building the extension side. Nothing here changes §5 or §6 — the contracts
> are still frozen. These are the gaps between §10, which describes generating **one** lesson, and
> the thing we actually want: **feed in a list of questions at night, wake up to a library.**

§10's five stages are right and don't need changing. What's missing is the batch layer around them.

### 17.1 `lessons/index.json` — settled, B's side is done

**A Chrome extension cannot list a directory.** Fifty generated lessons dropped into
`extension/lessons/` are invisible to the panel unless something enumerates them.

So the emitter must also write **`extension/lessons/index.json`**. Any of these shapes is accepted:

```json
["styles-toc", "version-history"]
{ "lessons": ["styles-toc", "version-history"] }
[{ "id": "styles-toc" }, { "id": "version-history" }]
```

The panel reads it, and falls back to the two hand-written lessons if it's absent — so nothing
breaks before the batch runner exists. **Only write an id into the index once its verification
replay has passed.** The index is the contract for "this lesson is safe to teach."

### 17.2 The batch runner doesn't exist

`pipeline/package.json` declares `"author": "node author.js"` and **`author.js` was never created**
— B's error when scaffolding. §12's checklist for C has no batch item either.

Needed: a list of questions in, lessons + index out. §10 says the work "parallelises flatly", which
is the whole reason overnight is viable, but nothing implements it and no concurrency is specified.
Twenty lessons at once is four minutes; twenty in sequence is well over an hour.

### 17.3 Unattended failure handling

§10's "fails → discard and re-run" assumes a human watching one run. Overnight you need:

- a retry limit per question, so one impossible question doesn't eat the night
- a written report of which questions produced lessons and which didn't
- **never leave a partial file in `lessons/`.** B's validator rejects malformed lessons loudly, and
  `loadAll` skips a bad one rather than taking the library down — but not writing it is better

### 17.4 Narration quality doesn't survive scale

Stage 4 generates the `preamble` and `generalization`, and those carry the product's voice —
*"a table of contents isn't something you write, it's built from your headings."* Nobody will
proofread twenty of them at 3am.

**Keep `styles-toc` hand-written for the demo.** Generated lessons prove breadth; the hero lesson
carries the pitch and shouldn't be rolled fresh the night before.

### 17.5 The authoring document's state matters

`styles-toc` only works against a document that has a title and section headings **as plain text,
ready to be styled**. A lesson generated against an empty throwaway doc can reference content the
demo doc doesn't have. Nothing in §10 mentions the state of the document being explored, and this
is the failure that works in the pipeline and dies on stage.

### 17.6 Worth considering: store the question that produced the lesson

Matching runs over the lesson's own prose — goal, preamble, intents, hints. It works, but the
originating question is the single best piece of matching text there is, and it's currently thrown
away. An optional additive field (`questions: string[]`) would cost nothing and would need the
team's agreement, since §5 is frozen.

---

## 18. Status handoff — [B]'s layer

> Written by **B** at the end of a working session, for whoever picks this up next. Facts here were
> verified from the repo at the time of writing; anything about **A**, **C** or **D**'s progress is
> a snapshot and should be re-checked with `git log` before being relied on.

### 18.1 Where things stood

**B — `panel/`, `content.js`, `manifest.json`: complete and merged to `main`.** Every item on §12's
checklist is built, plus a UI redesign and voice output that came later. It runs end to end in
Chrome against the `teach.js` stub: chat bar, lesson matching, preamble, all four step modes, hint
escalation, wrong-click correction, generalization, both escape hatches.

**A — `resolve/`:** has landed `visible.js` (the `isVisible()` filter). Their implementation is
better than §8.0's: the plan specifies `offsetParent === null`, which wrongly rejects **fixed-position**
elements, and Docs menus and dialogs are commonly fixed. They use `checkVisibility()` with a
shadow-and-slot-aware fallback. `resolver.js`, `click.js` and `verify.js` were still stubs.

**C — `pipeline/`, `lessons/`:** both lessons exist. `version-history.json` is **B's draft, never
validated against a live Doc** — see `docs/findings.md`. The pipeline files were still stubs.

**D — `paint/`:** still stubs at last check, so nothing draws yet.

**`teach.js` is still B's stub** — it answers `'correct'` 1.5s after every step. Checkpoint 1 hasn't
happened.

### 18.2 Decisions taken after the plan was written

Don't undo these without reading the reasoning — each one cost a bug to find.

| Decision | Why |
|---|---|
| `content.js` is a classic script that dynamically imports `src/main.js` | Chrome rejected `"type": "module"` content scripts. **The frozen §4 import order now lives in `src/main.js`**, verbatim. |
| The UI floats; it never reflows the page | Narrowing Docs drops it under 1440px, collapsing toolbar buttons into `More`, and lessons then target elements that don't exist. Presents as a resolver bug. |
| B's host matches `OVERLAY_Z` and relies on DOM order | `OVERLAY_Z` is INT_MAX so B can't outrank D's scrim, and a window that moves can't have a hole cut for it. **Depends on D mounting their host in `init()`, not lazily.** |
| Drag ignores pointerdown on buttons | `setPointerCapture` retargets the following `click` to the capturing element, which silently swallowed every control in the window header. |
| A failed `verify` advances after two retries | A broken verify hook must not trap a user on a step they've already done correctly. §15 already sanctions `verify.kind: 'none'` as the fallback. |
| Matching indexes the lesson prose, not a keyword list | Hand-written keywords only ever catch phrasings the author thought of. C's prose describes each task in a user's own words and arrives free with every generated lesson. |
| Lessons are discovered via `lessons/index.json` | A Chrome extension can't list a directory. See §17.1. |

### 18.3 Outstanding, and owned by other people

1. **[A]** `waitForClick` must ignore clicks whose `composedPath()` includes `#browser-teacher-root`,
   or B's own controls register as wrong answers. One line — see `CHECKPOINT-1.md`.
2. **[A + C]** A's wrong-click labels must match C's `wrongHints` keys exactly. A mismatch silently
   degrades to a generic correction and nothing reports it.
3. **[D]** Mount the paint host in `init()` at load — see the z-index row above.
4. **[C]** Write `lessons/index.json`, and only add an id once its verification replay passes.
5. **[C]** `Insert → Table of contents` is still unconfirmed and blocks `styles-toc` step s6.

### 18.4 What was and wasn't actually verified

**Verified in Node**, against the real lesson JSON: the runner across six scenarios including wrong
clicks, resolver failure and verify failure; lesson validation against eight kinds of malformed
input; the `__TEACH` contract guard; question matching across twenty phrasings (18 correct — the two
failures are "add a table" / "insert a table", which in Docs means Insert → Table, a feature with no
lesson).

**Verified in Chrome by the human:** panel mounts, lessons run, drag, resize, voice toggle, glass.

**Never run by anyone:** the error card, and the extension under any browser lacking
`backdrop-filter` or speech APIs (fallbacks exist but are untested).

> **The Node harnesses live in a session scratch directory and are gone.** They were worth having —
> they caught an unbounded retry loop that OOM'd, two dead synonym paths, and a typo matcher that
> couldn't see transpositions. Rebuilding them is a few dozen lines: fake `window.__TEACH`, fake the
> `ui` facade, drive `runLesson` against the real JSON.

### 18.5 Testing the awkward paths

DevTools console, context switched from `top` to **Browser Teacher** (extension code runs in an
isolated world, so these are invisible from the page context):

```js
__BT_DEV.hints()         // hold a step open — tiers at 8s / 16s / 24s
__BT_DEV.wrong('Font')   // force a wrong click; two args exercises the generic fallback
__BT_DEV.noResolve()     // highlight() fails — the "menu isn't open yet" path
__BT_DEV.verifyFail()    // verify() never passes
__BT_DEV.run('styles-toc', 3)   // jump to a step, for rehearsal
__BT_DEV.off()
```

Hints only fire from **step 3** of `styles-toc` onward: step 1 demonstrates and step 2 has no target,
so neither waits on a click. And while the stub answers after 1.5s, no hint can ever reach 8s without
`__BT_DEV.hints()` — that stops being true the moment `teach.js` is real.
