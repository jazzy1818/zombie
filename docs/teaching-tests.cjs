// Run: node docs/teaching-tests.cjs with Playwright on NODE_PATH.
// Optional CHROME_PATH points to Chromium/Chrome for Testing; otherwise uses Chrome.
// Actual browser DOM + adapter modules. One explicitly labelled A handoff double
// checks the boundary only; loaded-extension behavior lives in extension-tests.cjs.
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
    'These checks import the actual semantic adapter in a real browser and use ordinary DOM controls. The A handoff check alone injects a small findSync double to validate Element precedence; it does not claim to test A’s unfinished resolver. The separate loaded-extension suite tests the real manifest, content script, panel and teaching interaction.', '',
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
  await test('Teacher UI cannot resolve as the website target', () => adapter.findTarget({ name: 'UI example' }), null);
  await test('Ambiguous visible matches require explicit disambiguation', () => adapter.findTarget({ name: 'Dupe example' }), null);
  await test('An explicit nth chooses the requested visible match', () => adapter.findTarget({ name: 'Dupe example', nth: 1 })?.id, 'dupe2');
  await test('A handoff contract double: supplied actual Element takes precedence', () => adapter.findTarget({ name: 'A supplied' }, () => ({ findSync: () => document.querySelector('#prefix') }))?.id, 'prefix');
  await test('An absent DOM outcome fails instead of returning stub success', () => adapter.verifyOutcome({ kind: 'dom', selector: '#does-not-exist' }, { signal: new AbortController().signal, timeout: 0 }), false);
  await test('Label verification reads the real DOM outcome', () => adapter.verifyOutcome({ kind: 'label', selector: '#labelled-by', match: 'example' }, { signal: new AbortController().signal, timeout: 0 }), true);
})().catch(error => {
  results.push({ name: 'Test runner completed', passed: false, error: error.stack || error.message });
  console.error(error);
}).finally(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await report();
  if (results.some(result => !result.passed) || errors.length) process.exitCode = 1;
});
