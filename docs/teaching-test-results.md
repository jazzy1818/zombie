# Teaching adapter checks

Run: 2026-09-12T23:57:58.409Z

Browser: 151.0.7922.34

Result: **27/27 checks passed**.

These checks import the actual semantic adapter in a real browser and use ordinary DOM controls. Explicitly named A handoff checks inject small findSync doubles to validate Element precedence and disabled-element rejection; they do not claim to test A’s unfinished resolver. The separate loaded-extension suite tests the real manifest, content script, panel and teaching interaction.

- PASS: A menu container cannot impersonate its only named child
- PASS: A shortcut suffix is allowed without confusing Export with Export as
- PASS: aria-labelledby supplies the name of an icon control
- PASS: A native checkbox resolves through its associated label
- PASS: The associated native label counts as activation of its control
- PASS: A disabled control cannot count as a correct activation
- PASS: Native disabled controls are excluded during semantic resolution
- PASS: ARIA-disabled controls are excluded during semantic resolution
- PASS: Native fieldset-disabled controls are excluded during semantic resolution
- PASS: The native first-legend exemption remains usable inside a disabled fieldset
- PASS: A control inside an ARIA-disabled ancestor cannot become an actionable target
- PASS: A direct disabled Element is not an actionable target
- PASS: An explicit nth counts eligible controls after both disabled variants are removed
- PASS: Two eligible controls remain ambiguous even when disabled duplicates exist
- PASS: Teacher UI cannot resolve as the website target
- PASS: Ambiguous visible matches require explicit disambiguation
- PASS: An explicit nth chooses the requested visible match
- PASS: A handoff contract double: supplied actual Element takes precedence
- PASS: A handoff contract double: disabled Element is rejected before fallback resolution
- PASS: A handoff contract double: ARIA-disabled Element cannot become the target
- PASS: An absent DOM outcome fails instead of returning stub success
- PASS: Label verification reads the real DOM outcome
- PASS: Label verification reads a richer aria-label without changing Verify schema
- PASS: Label verification fails when neither text nor aria-label contains the outcome
- PASS: Label verification does not accept a hidden richer label
- PASS: Visible verification remains about visibility when the rendered control is disabled
- PASS: DOM and text outcomes remain readable on a rendered disabled control

Uncaught page errors: 0.

Run: `node docs/teaching-tests.cjs` with Playwright available (for the bundled runtime, set NODE_PATH to its node_modules directory). The default uses installed Chrome; set CHROME_PATH for another Chromium executable. No preview server needs to be running.
