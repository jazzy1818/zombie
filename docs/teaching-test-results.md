# Teaching adapter checks

Run: 2026-09-12T23:23:42.028Z

Browser: 151.0.7922.34

Result: **12/12 checks passed**.

These checks import the actual semantic adapter in a real browser and use ordinary DOM controls. The A handoff check alone injects a small findSync double to validate Element precedence; it does not claim to test A’s unfinished resolver. The separate loaded-extension suite tests the real manifest, content script, panel and teaching interaction.

- PASS: A menu container cannot impersonate its only named child
- PASS: A shortcut suffix is allowed without confusing Export with Export as
- PASS: aria-labelledby supplies the name of an icon control
- PASS: A native checkbox resolves through its associated label
- PASS: The associated native label counts as activation of its control
- PASS: A disabled control cannot count as a correct activation
- PASS: Teacher UI cannot resolve as the website target
- PASS: Ambiguous visible matches require explicit disambiguation
- PASS: An explicit nth chooses the requested visible match
- PASS: A handoff contract double: supplied actual Element takes precedence
- PASS: An absent DOM outcome fails instead of returning stub success
- PASS: Label verification reads the real DOM outcome

Uncaught page errors: 0.

Run: `node docs/teaching-tests.cjs` with Playwright available (for the bundled runtime, set NODE_PATH to its node_modules directory). The default uses installed Chrome; set CHROME_PATH for another Chromium executable. No preview server needs to be running.
