// Part A checks against docs/resolver-fixture.html, a Google Docs-shaped page.
//
// Phase 1 imports extension/src/resolve/index.js straight into the page (no
// extension) and drives __RESOLVE with real browser input.
// Phase 2 loads the real unpacked extension and runs docs/resolver-practice.json
// through the actual panel, teaching bridge and paint, so A's resolver is used
// exactly the way a lesson uses it. Nothing is mocked in either phase.
//
// Run from the repo root with Playwright on NODE_PATH:
//   NODE_PATH=<node_modules containing playwright> \
//   CHROME_PATH="<Chromium or Chrome for Testing executable>" \
//   node docs/resolver-tests.cjs
// Phase 1 falls back to installed Google Chrome when CHROME_PATH is unset.
// Phase 2 needs Chromium or Chrome for Testing: branded Chrome 137+ ignores
// --load-extension, so it is skipped (not failed) without a usable CHROME_PATH.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, '.paint-artifacts');
const extensionPath = path.join(root, 'extension');
const chromePath = process.env.CHROME_PATH;
const results = [];
const notes = [];
const versions = {};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'text/plain';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404).end('Not found'); }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function test(phase, name, run) {
  const label = `[${phase}] ${name}`;
  try {
    await run();
    results.push({ name: label, passed: true });
    console.log(`PASS ${label}`);
  } catch (error) {
    results.push({ name: label, passed: false, error: error.message });
    console.error(`FAIL ${label}: ${error.message}`);
  }
}
function note(text) { notes.push(text); console.log(`NOTE ${text}`); }

async function report() {
  const passed = results.filter(result => result.passed).length;
  await fs.writeFile(path.join(__dirname, 'resolver-test-results.md'), [
    '# Part A resolver checks', '',
    `Run: ${new Date().toISOString()}`, '',
    `Phase 1 browser (resolve modules only): ${versions.direct || 'not launched'}`, '',
    `Phase 2 browser (real unpacked extension): ${versions.extension || 'not launched'}`, '',
    `Result: **${passed}/${results.length} checks passed**.`, '',
    'Phase 1 imports `extension/src/resolve/index.js` into `docs/resolver-fixture.html` and drives `__RESOLVE` with real browser input. Phase 2 loads the unchanged `extension/` directory and runs `docs/resolver-practice.json` through the real panel, teaching bridge and paint. The fixture follows the validated Google Docs label formats from PLAN.md §7, and its menu rows activate on mouseup and hide before `click` fires, as Closure menus do.', '',
    ...results.map(result => `- ${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error.replace(/\n/g, ' ')}` : ''}`), '',
    ...(notes.length ? ['Notes:', ...notes.map(text => `- ${text}`), ''] : []),
    'This is a local fixture, not a signed-in Google Doc. It checks that the resolver, click judgement and verification behave as specified for Docs-shaped markup; it does not certify the live Docs DOM.', '',
    'Run: `node docs/resolver-tests.cjs` with Playwright on NODE_PATH and `CHROME_PATH` naming Chromium or Chrome for Testing for phase 2.', '',
  ].join('\n'));
}

// ------------------------------------------------------------ phase 1: direct
async function phaseDirect(base) {
  const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }) });
  versions.direct = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const P = 'direct';
  try {
    // Phase 1 always uses the Google Docs (mouseup) menu behaviour.
    await page.goto(`${base}/docs/resolver-fixture.html?activate=mouseup`);
    await page.addScriptTag({ type: 'module', content: "import '/extension/src/resolve/index.js';" });
    await page.waitForFunction(() => Boolean(window.__RESOLVE));
    const ev = expression => page.evaluate(expression);

    await test(P, 'window.__RESOLVE exposes exactly Contract 2', async () => {
      assert.deepEqual(await ev('Object.keys(__RESOLVE).sort()'), ['find', 'findSync', 'verify', 'waitForClick']);
    });

    await test(P, 'find resolves toolbar controls by bare name; a parenthesised shortcut is stripped', async () => {
      const ids = await ev(`Promise.all([
        __RESOLVE.find({ scope: 'toolbar', name: 'Styles' }),
        __RESOLVE.find({ scope: 'toolbar', name: 'Bold' }),
        __RESOLVE.find({ name: 'Bold' }),
      ]).then(list => list.map(el => el?.id))`);
      assert.deepEqual(ids, ['resolver-styles', 'resolver-bold', 'resolver-bold']);
    });

    await test(P, 'nested Font size duplicates collapse to the outer control', async () => {
      const found = await ev(`(() => { const el = __RESOLVE.findSync({ scope: 'toolbar', name: 'Font size' }); return [el?.id, el?.tagName]; })()`);
      assert.deepEqual(found, ['resolver-font-size', 'DIV']);
    });

    await test(P, 'rows of a closed menu never resolve, and visible-verify times out false', async () => {
      const closed = await ev(`[
        __RESOLVE.findSync({ scope: 'menu', name: "Apply 'Heading 1'" }),
        __RESOLVE.findSync({ scope: 'menu', name: 'Heading 1' }),
        __RESOLVE.findSync({ scope: 'menu', name: 'Table of contents' }),
        __RESOLVE.findSync({ name: 'Table of contents' }),
      ]`);
      assert.deepEqual(closed, [null, null, null, null]);
      const [ok, elapsed] = await ev(`(async () => { const t = performance.now(); const ok = await __RESOLVE.verify({ kind: 'visible', scope: 'menu', name: "Apply 'Heading 1'" }); return [ok, performance.now() - t]; })()`);
      assert.equal(ok, false);
      assert.ok(elapsed >= 2900 && elapsed < 6000, `verify should poll for VERIFY_TIMEOUT_MS, took ${Math.round(elapsed)}ms`);
    });

    await test(P, 'find keeps retrying for the resolve window before giving up', async () => {
      const [el, elapsed] = await ev(`(async () => { const t = performance.now(); const el = await __RESOLVE.find({ scope: 'menu', name: 'Heading 1' }); return [el, performance.now() - t]; })()`);
      assert.equal(el, null);
      assert.ok(elapsed >= 1900 && elapsed < 5000, `find should poll for RESOLVE_TIMEOUT_MS, took ${Math.round(elapsed)}ms`);
    });

    await test(P, 'waitForClick: a click on the nested input counts for the outer Font size control', async () => {
      const wait = ev(`__RESOLVE.waitForClick({ scope: 'toolbar', name: 'Font size' })`);
      await page.locator('#resolver-font-size input').click();
      assert.equal(await wait, 'correct');
      assert.equal(await page.locator('#resolver-font-size-state').textContent(), 'Font size selected');
      assert.equal(await ev(`__RESOLVE.verify({ kind: 'label', selector: '#resolver-font-size-state', match: 'Font size selected' })`), true);
    });

    await test(P, 'waitForClick: wrong toolbar clicks report the bare accessible name (matches wrongHints keys)', async () => {
      let wait = ev(`__RESOLVE.waitForClick({ scope: 'toolbar', name: 'Styles' })`);
      await page.locator('#resolver-bold').click();
      assert.deepEqual(await wait, { wrong: 'Bold' });
      wait = ev(`__RESOLVE.waitForClick({ scope: 'toolbar', name: 'Styles' })`);
      await page.locator('#resolver-font').click();
      assert.deepEqual(await wait, { wrong: 'Font' });
    });

    await test(P, 'waitForClick ignores clicks inside the panel host and keeps waiting', async () => {
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'browser-teacher-root';
        host.innerHTML = '<button id="fake-panel-button" style="position:fixed;bottom:20px;right:20px">Got it</button>';
        document.documentElement.appendChild(host);
      });
      await page.evaluate(() => { window.__clickResult = undefined; __RESOLVE.waitForClick({ scope: 'toolbar', name: 'Styles' }).then(r => { window.__clickResult = r; }); });
      await page.locator('#fake-panel-button').click();
      await pause(150);
      assert.equal(await ev('window.__clickResult'), undefined, 'panel click must not settle the wait');
      await page.locator('#resolver-styles').click();
      await page.waitForFunction(() => window.__clickResult !== undefined);
      assert.equal(await ev('window.__clickResult'), 'correct');
      await page.evaluate(() => document.getElementById('browser-teacher-root').remove());
      assert.equal(await page.locator('#resolver-styles-menu').isHidden(), false, 'Styles menu should now be open');
    });

    await test(P, "open Styles menu: Apply 'Heading 1' resolves to the live Heading 1► row; a partial word does not", async () => {
      const found = await ev(`[
        __RESOLVE.findSync({ scope: 'menu', name: "Apply 'Heading 1'" })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'Heading 1' })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'Heading' }),
        __RESOLVE.findSync({ scope: 'menu', name: "Apply 'Title'" })?.id,
      ]`);
      assert.deepEqual(found, ['resolver-heading-one', 'resolver-heading-one', null, 'resolver-title']);
      assert.equal(await ev(`__RESOLVE.verify({ kind: 'visible', scope: 'menu', name: "Apply 'Heading 1'" })`), true);
    });

    await test(P, 'waitForClick: a wrong row reports the lesson-facing Apply name', async () => {
      const wait = ev(`__RESOLVE.waitForClick({ scope: 'menu', name: "Apply 'Heading 1'" })`);
      await page.locator('#resolver-title').click();
      assert.deepEqual(await wait, { wrong: "Apply 'Title'" });
      // Title was applied and the menu closed (Closure behaviour); reopen it.
      await page.locator('#resolver-styles').click();
      await page.locator('#resolver-styles-menu').waitFor({ state: 'visible' });
    });

    await test(P, 'waitForClick: the Heading 1 row counts as correct although it hid on mouseup; hero label verify passes', async () => {
      const wait = ev(`__RESOLVE.waitForClick({ scope: 'menu', name: "Apply 'Heading 1'" })`);
      await page.locator('#resolver-heading-one').click();
      assert.equal(await wait, 'correct');
      assert.equal(await page.locator('#resolver-styles-menu').isHidden(), true, 'row must have closed the menu on mouseup');
      assert.equal(await ev(`__RESOLVE.verify({ kind: 'label', selector: '#docs-toolbar-wrapper [aria-label="Styles"]', match: 'Heading 1' })`), true);
    });

    await test(P, 'richer aria-label outcomes verify while stateful readouts remain invalid action targets', async () => {
      assert.equal(await ev(`__RESOLVE.verify({ kind: 'label', selector: '#resolver-styles-readout', match: 'Heading 1' })`), true);
      assert.equal(await ev(`__RESOLVE.findSync({ name: 'Styles list. Heading 1 selected.', scope: 'toolbar' })`), null);
      assert.equal(await ev(`__RESOLVE.verify({ kind: 'visible', name: 'Styles list. Heading 1 selected.', scope: 'toolbar' })`), true);
    });

    await test(P, 'Insert menu: the opener click is reported as wrong, then Table of contents counts although it hid on mouseup', async () => {
      let wait = ev(`__RESOLVE.waitForClick({ scope: 'menu', name: 'Table of contents' })`);
      await page.locator('#resolver-insert').click();
      assert.deepEqual(await wait, { wrong: 'Insert' });
      const open = await ev(`[
        __RESOLVE.findSync({ scope: 'menu', name: 'Table' })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'Table of contents' })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'Footnote' })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'Image' })?.id,
      ]`);
      assert.deepEqual(open, ['resolver-table', 'resolver-toc', 'resolver-footnote', 'resolver-image']);
      wait = ev(`__RESOLVE.waitForClick({ scope: 'menu', name: 'Table of contents' })`);
      await page.locator('#resolver-toc').click();
      assert.equal(await wait, 'correct');
      assert.equal(await page.locator('#resolver-insert-menu').isHidden(), true);
      assert.equal(await ev(`__RESOLVE.verify({ kind: 'dom', selector: '#resolver-toc-block' })`), true);
    });

    await test(P, 'disabled File remains visible as an outcome but action resolution waits until enabled', async () => {
      await page.reload();
      await page.addScriptTag({ type: 'module', content: "import '/extension/src/resolve/index.js';" });
      await page.waitForFunction(() => Boolean(window.__RESOLVE));
      assert.equal(await ev(`__RESOLVE.findSync({ scope: 'menu', name: 'File' })`), null);
      assert.equal(await ev(`__RESOLVE.verify({ kind: 'visible', scope: 'menu', name: 'File' })`), true);
      assert.deepEqual(await ev(`__RESOLVE.find({ scope: 'menu', name: 'File' }).then(el => [el?.id, el?.getAttribute('aria-disabled')])`), ['resolver-file', 'false']);
    });

    await test(P, 'eligible and nested candidate pools apply nth after filtering and collapsing', async () => {
      assert.deepEqual(await ev(`[0, 1, 2].map(nth => __RESOLVE.findSync({ scope: 'toolbar', name: 'Eligible action', nth })?.id || null)`), ['pool-first', 'pool-second', null]);
      assert.deepEqual(await ev(`[0, 1].map(nth => __RESOLVE.findSync({ scope: 'toolbar', name: 'Zoom', nth })?.id || null)`), ['pool-zoom', null]);
    });

    await test(P, 'C option/listbox roles and Updated badges resolve without matching container text', async () => {
      assert.deepEqual(await ev(`[
        __RESOLVE.findSync({ scope: 'menu', role: 'option', name: '150%' })?.id,
        __RESOLVE.findSync({ scope: 'menu', role: 'listbox', name: 'Scale choices' })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'Solo option' })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'First option' })?.id,
        __RESOLVE.findSync({ scope: 'menu', name: 'Page elements' })?.id,
        __RESOLVE.findSync({ scope: 'menu', role: 'button', name: '150%' }),
      ]`), ['scale-150', 'scale-options', 'solo-option', 'first-option', 'page-elements', null]);
    });

    await test(P, 'a real press alone does not finish a click wait and cancellation discards its gesture', async () => {
      await page.evaluate(() => {
        window.pressResult = null;
        window.pressAbort = new AbortController();
        __RESOLVE.waitForClick({ scope: 'toolbar', name: 'Bold' }, { signal: pressAbort.signal })
          .then(result => { pressResult = result; }, error => { pressResult = error.name; });
      });
      const box = await page.locator('#resolver-bold').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await pause(100);
      assert.equal(await ev('pressResult'), null);
      await ev('pressAbort.abort(); true'); await page.mouse.up();
      assert.equal(await ev('pressResult'), 'AbortError');
      const next = ev(`__RESOLVE.waitForClick({ scope: 'toolbar', name: 'Styles' })`);
      await page.locator('#resolver-font').click();
      assert.deepEqual(await next, { wrong: 'Font' });
    });

    await test(P, 'an ambiguous name cannot become correct through a broad event-path fallback', async () => {
      const wait = ev(`__RESOLVE.waitForClick({ scope: 'toolbar', name: 'Eligible action' })`);
      await page.locator('#pool-first').click();
      assert.deepEqual(await wait, { wrong: 'Eligible action' });
    });

    await test(P, 'verify: none is true, malformed rules are false, nth:null is rejected', async () => {
      const values = await ev(`Promise.all([
        __RESOLVE.verify({ kind: 'none' }),
        __RESOLVE.verify(null),
        __RESOLVE.verify({ kind: 'bogus' }),
        __RESOLVE.verify({ kind: 'label', selector: '#resolver-style-state' }),
      ])`);
      assert.deepEqual(values, [true, false, false, false]);
      assert.equal(await ev(`__RESOLVE.findSync({ scope: 'toolbar', name: 'Styles', nth: null })`), null);
      note('Unused nth must be omitted by lesson authors; an explicit nth:null is rejected rather than silently selecting another control.');
    });

    assert.deepEqual(pageErrors, [], `phase 1 page errors: ${pageErrors.join('; ')}`);
  } finally {
    await browser.close();
  }
}

// --------------------------------------------------- phase 2: loaded extension
async function phaseExtension(base) {
  if (!chromePath) { note('Phase 2 skipped: set CHROME_PATH to Chromium or Chrome for Testing to load the unpacked extension.'); return; }
  await fs.mkdir(artifacts, { recursive: true });
  const profile = await fs.mkdtemp(path.join(artifacts, 'resolver-profile-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, channel: 'chromium', executablePath: chromePath,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      viewport: { width: 1440, height: 900 },
    });
  } catch (error) {
    note(`Phase 2 skipped: could not launch ${chromePath}: ${error.message.split('\n')[0]}`);
    return;
  }
  versions.extension = context.browser()?.version() || 'persistent context';
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(`Page: ${error.message}`));
  const cdp = await context.newCDPSession(page);
  const contexts = new Map();
  let world;
  cdp.on('Runtime.executionContextCreated', ({ context: created }) => contexts.set(created.id, created));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => { contexts.clear(); world = undefined; });
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type !== 'error') return;
    runtimeErrors.push(`${contexts.get(event.executionContextId)?.name || 'Console'}: ${event.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ')}`);
  });
  await cdp.send('Runtime.enable');

  async function evaluate(expression, contextId = world) {
    assert.ok(contextId, 'Extension isolated execution context must exist');
    const result = await cdp.send('Runtime.evaluate', { contextId, expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function ready() {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      for (const [id, candidate] of contexts) {
        if (candidate.auxData?.isDefault) continue;
        try {
          const ok = await evaluate(`typeof __BT_DEV !== 'undefined' && typeof __BT_DEV.runLesson === 'function' && typeof __TEACH?.highlight === 'function' && typeof __RESOLVE?.findSync === 'function' && chrome.runtime.id`, id);
          if (ok) { world = id; return; }
        } catch { /* context may be initialising */ }
      }
      await pause(70);
    }
    throw new Error('The unpacked extension did not become ready on the fixture page');
  }
  async function open(query = '') {
    world = undefined;
    await page.goto(`${base}/docs/resolver-fixture.html${query}`);
    await ready();
    await page.locator('#browser-teacher-root .bt-bar').waitFor();
  }
  const panel = () => page.locator('#browser-teacher-root');
  const progress = () => panel().locator('.bt-progress').textContent();
  async function aligned(selector) {
    await page.waitForFunction(selector => {
      const element = document.querySelector(selector);
      const spot = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot.querySelector('.spot');
      if (!element || !spot || spot.hidden) return false;
      const a = element.getBoundingClientRect(), b = spot.getBoundingClientRect();
      return Math.abs(a.left - 4 - b.left) < 2 && Math.abs(a.top - 4 - b.top) < 2;
    }, selector);
  }
  async function spotHidden() {
    await page.waitForFunction(() => {
      const spot = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot.querySelector('.spot');
      return !spot || spot.hidden;
    });
  }
  async function begin(lesson) {
    await evaluate(`(() => { window.__practiceRun = __BT_DEV.runLesson(${JSON.stringify(lesson)}); return true; })()`);
    await panel().getByRole('button', { name: 'Show me', exact: true }).click();
  }
  const completed = () => panel().locator('.bt-card-generalization').waitFor();
  const wrongNote = () => panel().locator('.bt-note-wrong');
  const P = 'extension';
  const practice = JSON.parse(await fs.readFile(path.join(__dirname, 'resolver-practice.json'), 'utf8'));

  try {
    await test(P, 'the extension resolves fixture targets through A (an alias only A understands)', async () => {
      await open();
      await page.locator('#resolver-styles').click();
      const ids = await evaluate(`(() => {
        return [
          __RESOLVE.findSync({ scope: 'toolbar', name: 'Font size' })?.id,
          __RESOLVE.findSync({ scope: 'menu', name: "Apply 'Heading 1'" })?.id,
        ];
      })()`);
      assert.deepEqual(ids, ['resolver-font-size', 'resolver-heading-one']);
      // The adapter's own fallback cannot map Apply 'Heading 1' to "Heading 1►",
      // so highlight() succeeding here proves the bridge used A's resolver.
      assert.equal(await evaluate(`__TEACH.highlight({ scope: 'menu', name: "Apply 'Heading 1'" })`), true);
      await aligned('#resolver-heading-one');
      await evaluate('__TEACH.clear(); true');
    });

    await test(P, 'the practice lesson completes end to end with real clicks (fixture default: menus activate on click)', async () => {
      await open();
      await begin(practice);
      await aligned('#resolver-font-size');
      assert.equal(await progress(), '1 / 4');
      await page.locator('#resolver-font-size input').click();
      await page.waitForFunction(() => document.querySelector('#browser-teacher-root').shadowRoot.querySelector('.bt-progress')?.textContent === '2 / 4');
      await aligned('#resolver-styles');
      await page.locator('#resolver-font').click();
      await wrongNote().waitFor();
      assert.match(await wrongNote().textContent(), /typeface/);
      await page.locator('#resolver-styles').click();
      await page.waitForFunction(() => document.querySelector('#browser-teacher-root').shadowRoot.querySelector('.bt-progress')?.textContent === '3 / 4');
      await aligned('#resolver-heading-one');
      await page.locator('#resolver-heading-one').click();
      await page.waitForFunction(() => document.querySelector('#browser-teacher-root').shadowRoot.querySelector('.bt-progress')?.textContent === '4 / 4');
      await spotHidden();
      assert.equal(await page.locator('#resolver-styles').textContent(), 'Heading 1');
      await page.locator('#resolver-insert').click();
      await wrongNote().waitFor();
      assert.match(await wrongNote().textContent(), /right menu/);
      await page.locator('#resolver-toc').click();
      await completed();
      assert.equal(await page.locator('#resolver-toc-block').isHidden(), false);
      assert.equal(await page.evaluate(() => fixture.trusted.every(click => click.trusted)), true);
    });

    await test(P, 'the bridge completes a hidden-on-mouseup row only after its real click, including explicit nth', async () => {
      await open('?activate=mouseup');
      const steps = practice.steps.slice(1, 3).map(step => ({ ...step, target: { ...step.target, nth: 0 } }));
      await begin({ ...practice, steps });
      await aligned('#resolver-styles');
      await page.locator('#resolver-styles').click();
      await page.waitForFunction(() => document.querySelector('#browser-teacher-root').shadowRoot.querySelector('.bt-progress')?.textContent === '2 / 2');
      await aligned('#resolver-heading-one');
      const box = await page.locator('#resolver-heading-one').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await pause(100);
      assert.equal(await progress(), '2 / 2');
      assert.equal(await page.locator('#resolver-styles-menu').isHidden(), false);
      assert.equal(await page.locator('#resolver-styles').textContent(), 'Normal text');
      await page.mouse.up();
      try {
        await completed();
      } catch (error) {
        const state = await page.evaluate(() => ({
          menuHidden: document.querySelector('#resolver-styles-menu').hidden,
          styleCaption: document.querySelector('#resolver-styles').textContent,
          panel: document.querySelector('#browser-teacher-root').shadowRoot.querySelector('.bt-body')?.textContent?.trim(),
        }));
        throw new Error(`lesson did not advance after a correct mouseup-activated click; fixture: ${JSON.stringify(state)}`);
      }
    });

    await test(P, 'hidden wrong rows preserve authored Apply-name corrections before the next real click', async () => {
      await open('?activate=mouseup');
      await begin({ ...practice, steps: practice.steps.slice(1, 3) });
      await aligned('#resolver-styles'); await page.locator('#resolver-styles').click();
      await aligned('#resolver-heading-one'); await page.locator('#resolver-title').click();
      await wrongNote().waitFor();
      assert.match(await wrongNote().textContent(), /Title is a different structural role/);
      assert.equal(await page.locator('#resolver-styles-menu').isHidden(), true);
      await page.locator('#resolver-styles').click();
      await page.locator('#resolver-heading-one').click(); await completed();
    });

    await test(P, 'current bare-name lessons retain their Title correction on legacy radio menu rows', async () => {
      await open('?activate=mouseup');
      const steps = practice.steps.slice(1, 3).map(step => ({ ...step, target: { ...step.target } }));
      steps[1].target = { scope: 'menu', name: 'Heading 1', role: 'menuitemradio' };
      steps[1].wrongHints = { Title: 'Use a heading level, not the document title.' };
      await begin({ ...practice, steps });
      await aligned('#resolver-styles'); await page.locator('#resolver-styles').click();
      await aligned('#resolver-heading-one'); await page.locator('#resolver-title').click();
      await wrongNote().waitFor();
      assert.match(await wrongNote().textContent(), /Use a heading level/);
      await page.locator('#resolver-styles').click();
      await page.locator('#resolver-heading-one').click(); await completed();
    });

    await test(P, 'C option-role lesson runs through A, the real bridge and an aria-label outcome', async () => {
      await open();
      await begin({ ...practice, steps: [{
        id: 'choose-scale', mode: 'guided', intent: 'Choose 150%.', action: 'click',
        target: { scope: 'menu', role: 'option', name: '150%' },
        verify: { kind: 'label', selector: '#scale-readout', match: '150% selected.' },
        hints: ['Choose the named scale.'],
      }] });
      await aligned('#scale-150');
      assert.equal(await page.locator('#scale-readout').getAttribute('aria-label'), 'Zoom list. 100% selected.');
      await page.locator('#scale-150').click(); await completed();
      assert.equal(await page.locator('#scale-readout').getAttribute('aria-label'), 'Zoom list. 150% selected.');
    });

    assert.deepEqual(runtimeErrors, [], `phase 2 runtime errors: ${runtimeErrors.join('; ')}`);
  } catch (error) {
    results.push({ name: '[extension] runtime errors', passed: false, error: error.message });
    console.error(`FAIL [extension] ${error.message}`);
  } finally {
    await page.screenshot({ path: path.join(artifacts, 'resolver-final.png'), fullPage: true }).catch(() => {});
    await context.close();
  }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await phaseDirect(base);
    await phaseExtension(base);
  } finally {
    server.close();
    await report();
    const passed = results.filter(result => result.passed).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    if (passed !== results.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
