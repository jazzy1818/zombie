// Run: node docs/teaching-tests.cjs with Playwright on NODE_PATH.
// Optional CHROME_PATH points to Chromium/Chrome for Testing; otherwise uses Chrome.
// Actual browser DOM + adapter modules. Explicitly labelled A handoff doubles
// check the boundary only; loaded-extension behavior lives in extension-tests.cjs.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const results = [];
const errors = [];
let browser;
let browserVersion = 'not launched';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Teaching adapter checks</title></head><body>
<div role="menu"><button role="menuitem" id="menu-child">Only menu child</button></div>
<button id="shortcut" aria-label="Export (Ctrl+E)">Export</button><button id="prefix">Export as</button>
<span id="labelled-by">Labelled example</span><button id="labelled" aria-labelledby="labelled-by">Icon</button>
<label for="check">Email updates</label><input id="check" type="checkbox">
<button disabled id="disabled">Disabled example</button>
<button aria-disabled="true" id="aria-disabled">ARIA disabled example</button>
<fieldset disabled><button id="fieldset-disabled">Fieldset disabled example</button></fieldset>
<fieldset disabled><legend><button id="legend-enabled">Legend enabled example</button></legend><button>Disabled outside legend</button></fieldset>
<div aria-disabled="true"><button id="ancestor-disabled">Ancestor disabled example</button></div>
<button disabled id="eligible-native-disabled" aria-label="Eligible example">Eligible example</button>
<button aria-disabled="true" id="eligible-aria-disabled" aria-label="Eligible example">Eligible example</button>
<button id="eligible1" aria-label="Eligible example">Eligible example</button><button id="eligible2" aria-label="Eligible example">Eligible example</button>
<div id="nested-zoom" role="combobox" aria-label="Zoom"><input aria-label="Zoom" value="100%" readonly></div>
<div role="listbox"><button role="option" id="single-option">Single option</button></div>
<div role="listbox"><button role="option" id="first-list-option">First option</button><button role="option">Second option</button></div>
<div role="listbox" aria-label="Zoom choices"><button role="option" id="option-150" aria-label="150%">150%</button></div>
<div role="menuitem" id="badge-menuitem">Page elementsUpdated►</div>
<span id="rich-label" aria-label="Styles list. Heading 1 selected.">Icon only</span>
<span id="hidden-label" aria-label="Styles list. Heading 2 selected." hidden>Icon only</span>
<div data-browser-teacher="ui"><button>UI example</button><span id="ui-readout" aria-label="Zoom list. 100% selected.">Icon only</span></div>
<button id="dupe1">Dupe example</button><button id="dupe2">Dupe example</button>
</body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture); return; }
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});

async function report() {
  const passed = results.filter(result => result.passed).length;
  await fs.writeFile(path.join(__dirname, 'teaching-test-results.md'), [
    '# Teaching adapter checks', '', `Run: ${new Date().toISOString()}`, '',
    `Browser: ${browserVersion}`, '', `Result: **${passed}/${results.length} checks passed**.`, '',
    'These checks import the actual semantic adapter and completed A resolver in a real browser. Explicitly named handoff-double checks isolate Element precedence and rejection; checks labelled "real A" use A’s production resolver. The loaded-extension suites separately test the manifest, panel and teaching interaction.', '',
    ...results.map(result => `- ${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error.replace(/\n/g, ' ')}` : ''}`), '',
    `Uncaught page errors: ${errors.length}.`, ...errors.map(error => `- ${error}`), '',
    'Run: `node docs/teaching-tests.cjs` with Playwright available (for the bundled runtime, set NODE_PATH to its node_modules directory). The default uses installed Chrome; set CHROME_PATH for another Chromium executable. No preview server needs to be running.', '',
  ].join('\n'));
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  browserVersion = browser.version();
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    window.adapter = await import('/extension/src/teaching/resolution.js');
    window.eligibility = await import('/extension/src/resolve/eligibility.js');
    window.gesture = await import('/extension/src/resolve/gesture.js');
    window.actualResolver = await import('/extension/src/resolve/resolver.js');
  });
  async function test(name, expression, expected) {
    try {
      assert.deepEqual(await page.evaluate(expression), expected);
      results.push({ name, passed: true }); console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  await test('A menu container cannot impersonate its only named child', () => adapter.findTarget({ name: 'Only menu child', scope: 'menu' })?.id, 'menu-child');
  await test('A shortcut suffix is allowed without confusing Export with Export as', () => adapter.findTarget({ name: 'Export' })?.id, 'shortcut');
  await test('aria-labelledby supplies the name of an icon control', () => adapter.findTarget({ name: 'Labelled example' })?.id, 'labelled');
  await test('A native checkbox resolves through its associated label', () => adapter.findTarget({ name: 'Email updates' })?.id, 'check');
  await test('The associated native label counts as activation of its control', () => adapter.pathActivates([document.querySelector('label')], document.querySelector('#check')), true);
  await test('A disabled control cannot count as a correct activation', () => adapter.pathActivates([document.querySelector('#disabled')], document.querySelector('#disabled')), false);
  await test('Native disabled controls are excluded during semantic resolution', () => adapter.findTarget({ name: 'Disabled example' }), null);
  await test('ARIA-disabled controls are excluded during semantic resolution', () => adapter.findTarget({ name: 'ARIA disabled example' }), null);
  await test('Native fieldset-disabled controls are excluded during semantic resolution', () => adapter.findTarget({ name: 'Fieldset disabled example' }), null);
  await test('The native first-legend exemption remains usable inside a disabled fieldset', () => adapter.findTarget({ name: 'Legend enabled example' })?.id, 'legend-enabled');
  await test('A control inside an ARIA-disabled ancestor cannot become an actionable target', () => adapter.findTarget({ name: 'Ancestor disabled example' }), null);
  await test('A direct disabled Element is not an actionable target', () => adapter.findTarget(document.querySelector('#disabled')), null);
  await test('An explicit nth counts eligible controls after both disabled variants are removed', () => [0, 1, 2].map(nth => adapter.findTarget({ name: 'Eligible example', nth })?.id || null), ['eligible1', 'eligible2', null]);
  await test('Two eligible controls remain ambiguous even when disabled duplicates exist', () => adapter.findTarget({ name: 'Eligible example' }), null);
  await test('Real A applies nth after disabled filtering before the adapter accepts its Element', () => adapter.findTarget({ name: 'Eligible example', nth: 1 }, () => actualResolver)?.id, 'eligible2');
  await test('Real A and fallback collapse nested same-name controls before nth', () => [undefined, 0, 1].map(nth => ({
    A: adapter.findTarget({ name: 'Zoom', ...(nth === undefined ? {} : { nth }) }, () => actualResolver)?.id || null,
    fallback: adapter.findTarget({ name: 'Zoom', ...(nth === undefined ? {} : { nth }) })?.id || null,
  })), [{ A: 'nested-zoom', fallback: 'nested-zoom' }, { A: 'nested-zoom', fallback: 'nested-zoom' }, { A: null, fallback: null }]);
  await test('Unlabelled listboxes cannot impersonate either a sole option or aggregated options', () => ['Single option', 'First option'].map(name => [
    adapter.findTarget({ scope: 'menu', name })?.id,
    adapter.findTarget({ scope: 'menu', name }, () => actualResolver)?.id,
  ]), [['single-option', 'single-option'], ['first-list-option', 'first-list-option']]);
  await test('Real A and fallback accept C option-role descriptors in menu scope', () => [
    adapter.findTarget({ scope: 'menu', role: 'option', name: '150%' })?.id,
    adapter.findTarget({ scope: 'menu', role: 'option', name: '150%' }, () => actualResolver)?.id,
  ], ['option-150', 'option-150']);
  await test('Known promo badges match authored menu names in both resolvers', () => [
    adapter.findTarget({ scope: 'menu', name: 'Page elements' })?.id,
    adapter.findTarget({ scope: 'menu', name: 'Page elements' }, () => actualResolver)?.id,
  ], ['badge-menuitem', 'badge-menuitem']);
  await test('Stateful selected readouts are not action targets in real A or fallback', () => [
    adapter.findTarget({ name: 'Styles list. Heading 1 selected.' }),
    adapter.findTarget({ name: 'Styles list. Heading 1 selected.' }, () => actualResolver),
  ], [null, null]);
  await test('Stateful readouts remain available for visible outcome verification', () => adapter.verifyOutcome({ kind: 'visible', name: 'Styles list. Heading 1 selected.' }, { signal: new AbortController().signal, resolver: () => actualResolver, timeout: 0 }), true);
  await test('Teacher UI cannot resolve as the website target', () => adapter.findTarget({ name: 'UI example' }), null);
  await test('Ambiguous visible matches require explicit disambiguation', () => adapter.findTarget({ name: 'Dupe example' }), null);
  await test('An explicit nth chooses the requested visible match', () => adapter.findTarget({ name: 'Dupe example', nth: 1 })?.id, 'dupe2');
  await test('A handoff contract double: supplied actual Element takes precedence', () => adapter.findTarget({ name: 'A supplied' }, () => ({ findSync: () => document.querySelector('#prefix') }))?.id, 'prefix');
  await test('A handoff contract double: disabled Element is rejected before fallback resolution', () => adapter.findTarget({ name: 'Export' }, () => ({ findSync: () => document.querySelector('#disabled') }))?.id, 'shortcut');
  await test('A handoff contract double: ARIA-disabled Element cannot become the target', () => adapter.findTarget({ name: 'No eligible fallback' }, () => ({ findSync: () => document.querySelector('#aria-disabled') })), null);
  await test('An absent DOM outcome fails instead of returning stub success', () => adapter.verifyOutcome({ kind: 'dom', selector: '#does-not-exist' }, { signal: new AbortController().signal, timeout: 0 }), false);
  await test('Label verification reads the real DOM outcome', () => adapter.verifyOutcome({ kind: 'label', selector: '#labelled-by', match: 'example' }, { signal: new AbortController().signal, timeout: 0 }), true);
  await test('Label verification reads a richer aria-label without changing Verify schema', () => adapter.verifyOutcome({ kind: 'label', selector: '#rich-label', match: 'Heading 1' }, { signal: new AbortController().signal, timeout: 0 }), true);
  await test('Label verification fails when neither text nor aria-label contains the outcome', () => adapter.verifyOutcome({ kind: 'label', selector: '#rich-label', match: 'Heading 2' }, { signal: new AbortController().signal, timeout: 0 }), false);
  await test('Label verification does not accept a hidden richer label', () => adapter.verifyOutcome({ kind: 'label', selector: '#hidden-label', match: 'Heading 2' }, { signal: new AbortController().signal, timeout: 0 }), false);
  await test('Visible verification remains about visibility when the rendered control is disabled', () => adapter.verifyOutcome({ kind: 'visible', name: 'Disabled example' }, { signal: new AbortController().signal, timeout: 0 }), true);
  await test('DOM and text outcomes remain readable on a rendered disabled control', async () => Promise.all([
    adapter.verifyOutcome({ kind: 'dom', selector: '#disabled' }, { signal: new AbortController().signal, timeout: 0 }),
    adapter.verifyOutcome({ kind: 'label', selector: '#disabled', match: 'Disabled example' }, { signal: new AbortController().signal, timeout: 0 }),
  ]), [true, true]);

  // A dropdown whose inner list states the current value. Authored steps must
  // never target one — the name changes with the value — but verification still
  // has to be able to read it. See pipeline/findings-c.md.
  await test('A state readout is recognised whatever the value reads', () => [
    eligibility.isStateReadout(document.querySelector('#rich-label')),
    eligibility.isStateReadout(document.querySelector('#ui-readout')),
  ], [true, true]);
  await test('An ordinary control is not mistaken for a state readout', () => [
    eligibility.isStateReadout(document.querySelector('#labelled')),
    eligibility.isStateReadout(document.querySelector('#shortcut')),
    eligibility.isStateReadout(null),
  ], [false, false, false]);
  await test('A state readout cannot be resolved as an action target', () => adapter.findTarget(document.querySelector('#rich-label')), null);
  await test('Verification may still read a readout that actions cannot target', () => adapter.findTarget(document.querySelector('#rich-label'), undefined, { allowReadouts: true })?.id, 'rich-label');
  // The regression the readout rules must not cause: they stay out of the
  // candidate set, so a target that was unambiguous before does not become
  // ambiguous now.
  await test('The readout does not widen target resolution or create ambiguity', () => adapter.findTarget({ name: 'Styles' }), null);

  // A page cannot complete a step on the learner's behalf. Synthetic input is
  // refused outright, which is also why the tracker's remembering behaviour is
  // exercised with real browser input in extension-tests.cjs instead of here.
  await test('A gesture tracker refuses synthetic input', () => {
    const button = document.querySelector('#shortcut');
    const tracker = gesture.createGestureTracker({ name: 'Export' }, () => button);
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0 }));
    const click = new PointerEvent('click', { bubbles: true, composed: true, button: 0 });
    button.dispatchEvent(click);
    const seen = tracker.read(click);
    tracker.dispose();
    return seen;
  }, null);
})().catch(error => {
  results.push({ name: 'Test runner completed', passed: false, error: error.stack || error.message });
  console.error(error);
}).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await report();
  if (results.some(result => !result.passed) || errors.length) process.exitCode = 1;
});
