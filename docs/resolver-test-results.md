# Part A resolver checks

Run: 2026-09-13T01:21:47.033Z

Phase 1 browser (resolve modules only): 141.0.7390.122

Phase 2 browser (real unpacked extension): 141.0.7390.122

Result: **16/17 checks passed**.

Phase 1 imports `extension/src/resolve/index.js` into `docs/resolver-fixture.html` and drives `__RESOLVE` with real browser input. Phase 2 loads the unchanged `extension/` directory and runs `docs/resolver-practice.json` through the real panel, teaching bridge and paint. The fixture follows the validated Google Docs label formats from PLAN.md §7, and its menu rows activate on mouseup and hide before `click` fires, as Closure menus do.

- PASS: [direct] window.__RESOLVE exposes exactly Contract 2
- PASS: [direct] find resolves toolbar controls by bare name; a parenthesised shortcut is stripped
- PASS: [direct] nested Font size duplicates collapse to the outer control
- PASS: [direct] rows of a closed menu never resolve, and visible-verify times out false
- PASS: [direct] find keeps retrying for the resolve window before giving up
- PASS: [direct] waitForClick: a click on the nested input counts for the outer Font size control
- PASS: [direct] waitForClick: wrong toolbar clicks report the bare accessible name (matches wrongHints keys)
- PASS: [direct] waitForClick ignores clicks inside the panel host and keeps waiting
- PASS: [direct] open Styles menu: Apply 'Heading 1' resolves to the live Heading 1► row; a partial word does not
- PASS: [direct] waitForClick: a wrong row reports the lesson-facing Apply name
- PASS: [direct] waitForClick: the Heading 1 row counts as correct although it hid on mouseup; hero label verify passes
- PASS: [direct] Insert menu: the opener click is reported as wrong, then Table of contents counts although it hid on mouseup
- PASS: [direct] a disabled menubar item still resolves (visibility only); the adapter filters disabled on top
- PASS: [direct] verify: none is true, malformed rules are false, nth:null is rejected
- PASS: [extension] the extension resolves fixture targets through A (an alias only A understands)
- PASS: [extension] the practice lesson completes end to end with real clicks (fixture default: menus activate on click)
- FAIL: [extension] BRIDGE (teaching/controller.js): a Docs-style row that hides on mouseup still counts as the correct click — lesson did not advance after a correct mouseup-activated click; fixture: {"menuHidden":true,"styleCaption":"Heading 1","panel":"Your turnChoose Heading 1. The live row reads 'Heading 1►' while the lesson names it Apply 'Heading 1', exactly like the hero lesson's step s4.Choose the first numbered heading level."}

Notes:
- A's label verify reads textContent only: against the richer readout aria-label "Styles list. Heading 1 selected." it returns false. The teaching adapter also accepts aria-label (C's request); A's verify.js does not yet.
- A's findSync returns aria-disabled controls (File during load). teaching/resolution.js drops them before highlighting, so this only matters if A's resolver is ever used without the adapter.
- A target carrying nth: null (what a JSON emitter writes for "no nth") resolves to null. Decide with C whether emit.js must omit the key or resolver.js should treat null like undefined.

This is a local fixture, not a signed-in Google Doc. It checks that the resolver, click judgement and verification behave as specified for Docs-shaped markup; it does not certify the live Docs DOM.

Run: `node docs/resolver-tests.cjs` with Playwright on NODE_PATH and `CHROME_PATH` naming Chromium or Chrome for Testing for phase 2.
