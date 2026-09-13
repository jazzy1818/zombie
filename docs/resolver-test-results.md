# Part A resolver checks

Run: 2026-09-13T04:03:22.390Z

Phase 1 browser (resolve modules only): 153.0.8010.37

Phase 2 browser (real unpacked extension): not launched

Result: **19/19 checks passed**.

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
- PASS: [direct] richer aria-label outcomes verify while stateful readouts remain invalid action targets
- PASS: [direct] Insert menu: the opener click is reported as wrong, then Table of contents counts although it hid on mouseup
- PASS: [direct] disabled File remains visible as an outcome but action resolution waits until enabled
- PASS: [direct] eligible and nested candidate pools apply nth after filtering and collapsing
- PASS: [direct] C option/listbox roles and Updated badges resolve without matching container text
- PASS: [direct] a real press alone does not finish a click wait and cancellation discards its gesture
- PASS: [direct] an ambiguous name cannot become correct through a broad event-path fallback
- PASS: [direct] verify: none is true, malformed rules are false, nth:null is rejected

Notes:
- Unused nth must be omitted by lesson authors; an explicit nth:null is rejected rather than silently selecting another control.
- Phase 2 skipped: set CHROME_PATH to Chromium or Chrome for Testing to load the unpacked extension.

This is a local fixture, not a signed-in Google Doc. It checks that the resolver, click judgement and verification behave as specified for Docs-shaped markup; it does not certify the live Docs DOM.

Run: `node docs/resolver-tests.cjs` with Playwright on NODE_PATH and `CHROME_PATH` naming Chromium or Chrome for Testing for phase 2.
