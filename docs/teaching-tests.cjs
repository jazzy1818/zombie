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
<button disabled id="eligible-native-disabled">Eligible example</button>
<button aria-disabled="true" id="eligible-aria-disabled">Eligible example</button>
<button id="eligible1">Eligible example</button><button id="eligible2">Eligible example</button>
<span id="rich-label" aria-label="Styles list. Heading 1 selected.">Icon only</span>
<span id="hidden-label" aria-label="Styles list. Heading 2 selected." hidden>Icon only</span>
<div data-browser-teacher="ui"><button>UI example</button></div>
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
    'These checks import the actual semantic adapter in a real browser and use ordinary DOM controls. Explicitly named A handoff checks inject small findSync doubles to validate Element precedence and disabled-element rejection; they do not claim to test A’s unfinished resolver. The separate loaded-extension suite tests the real manifest, content script, panel and teaching interaction.', '',
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
  await page.evaluate(async () => { window.adapter = await import('/extension/src/teaching/resolution.js'); });
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
})().catch(error => {
  results.push({ name: 'Test runner completed', passed: false, error: error.stack || error.message });
  console.error(error);
}).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await report();
  if (results.some(result => !result.passed) || errors.length) process.exitCode = 1;
});
