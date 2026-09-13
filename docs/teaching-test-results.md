# Teaching adapter checks

Run: 2026-09-13T04:01:45.769Z

Browser: 153.0.8010.37

Result: **40/40 checks passed**.

These checks import the actual semantic adapter and completed A resolver in a real browser. Explicitly named handoff-double checks isolate Element precedence and rejection; checks labelled "real A" use A’s production resolver. The loaded-extension suites separately test the manifest, panel and teaching interaction.

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
- PASS: Real A applies nth after disabled filtering before the adapter accepts its Element
- PASS: Real A and fallback collapse nested same-name controls before nth
- PASS: Unlabelled listboxes cannot impersonate either a sole option or aggregated options
- PASS: Real A and fallback accept C option-role descriptors in menu scope
- PASS: Known promo badges match authored menu names in both resolvers
- PASS: Stateful selected readouts are not action targets in real A or fallback
- PASS: Stateful readouts remain available for visible outcome verification
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
- PASS: A state readout is recognised whatever the value reads
- PASS: An ordinary control is not mistaken for a state readout
- PASS: A state readout cannot be resolved as an action target
- PASS: Verification may still read a readout that actions cannot target
- PASS: The readout does not widen target resolution or create ambiguity
- PASS: A gesture tracker refuses synthetic input

Uncaught page errors: 0.

Run: `node docs/teaching-tests.cjs` with Playwright available (for the bundled runtime, set NODE_PATH to its node_modules directory). The default uses installed Chrome; set CHROME_PATH for another Chromium executable. No preview server needs to be running.
