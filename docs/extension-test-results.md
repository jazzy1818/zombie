# Loaded extension integration results

Run: 2026-09-13T00:04:30.441Z

Browser: 151.0.7922.34

Unpacked extension: hncmnkedojgcjjcnfnepjoleekjeahjg

Result: **32/32 checks passed**.

The browser loaded the unchanged extension directory through the manifest content script, then its real module graph in the extension isolated world. Tests use the actual panel, teaching adapter, resolver/fallback and paint implementations. No lesson-success, click, resolver or browser API mocks are installed.

- PASS: Manifest bootstrap loads real contracts in the extension isolated world
- PASS: Guided lesson waits for a real correct click and clears every effect
- PASS: Synthetic page clicks do not advance the lesson
- PASS: A fast correct click during cursor animation is captured before the next step
- PASS: Wrong website clicks give correction while panel interactions are ignored
- PASS: Ghost starts at the actual cursor for the first guided step
- PASS: Nested second step scrolls progressively and starts from the latest real pointer
- PASS: Downpage target scrolls smoothly and reaches the actual button
- PASS: Manually scrolling away retains the full grey effect and restores target tracking
- PASS: Reduced motion positions downpage guidance without a long cursor tween
- PASS: Same-page menu chain requires opener then newly revealed item
- PASS: Native modal guidance requires two real clicks with readable panel above scrim
- PASS: Panel remains above normal guidance and accepts Stop while a modal is open
- PASS: Native modal inside an open shadow root keeps guidance and Stop accessible
- PASS: Stop aborts unresolved targets and prevents delayed effects
- PASS: Close aborts smooth scrolling without a delayed cursor or step
- PASS: Correct click clears immediately during verification and Stop cancels verification
- PASS: Restart cancels stale resolution without closing or replacing the new step
- PASS: Hidden duplicates are excluded and open shadow-root controls resolve
- PASS: Native button text and associated input labels resolve without aria-label
- PASS: Disabled native and ARIA duplicates cannot shadow an enabled website action
- PASS: Native disabled target waits for document readiness before highlighting or moving the ghost
- PASS: ARIA-disabled target waits for document readiness before highlighting or moving the ghost
- PASS: A replaced Styles button verifies the richer inner aria-label after the user selects a heading
- PASS: Existing textContent label outcomes still verify after a real user action
- PASS: Ambiguous targets do not silently select the first matching control
- PASS: Explicit nth disambiguates visible matches
- PASS: Same-document hash links can continue a chain
- PASS: SPA path navigation cancels the run and clears pending next steps
- PASS: Real redirect starts the next document with no continuing lesson or effects
- PASS: Demo mode remains visual and requires the user to activate the website
- PASS: Solo mode accepts a real action without revealing guidance

Uncaught page or extension console errors: 0.

Scope: ordinary DOM controls on a local HTTP fixture, including native modal dialogs, open shadow roots, nested scrolling and same-origin navigation. This does not certify every website, cross-origin iframe, canvas application, browser version or live Google Docs lesson.

Screenshots and the disposable browser profile are saved under ignored `docs/.paint-artifacts/`.

Run with `node docs/extension-tests.cjs` after making Playwright available. Set `CHROME_PATH` to a Chromium or Chrome for Testing executable that supports unpacked extensions. Normal branded Chrome builds may ignore extension-loading flags.

Validation note: An earlier full run passed 31/32 checks; the existing shadow-root native-modal cursor-alignment check timed out once. With its assertions unchanged, that check passed alone, with the preceding modal-Stop case, and in this final complete 32/32 run. The cause of the first failure was not established. Failure diagnostics now record target geometry, cursor visibility/transform, resolver output and pointer state to aid a future reproduction. All new disabled-control and richer-label regressions passed both full runs.
