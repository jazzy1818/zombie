// Run with Playwright on NODE_PATH: node docs/extension-tests.cjs
// CHROME_PATH must name Chromium/Chrome for Testing with unpacked-extension support.
// The actual extension is loaded from its manifest in a separate persistent profile.
// CDP enters the isolated world for diagnostics and fixture lesson data. Library
// discovery/search tests start through the actual chat bar and packaged index.
// No resolver, teach, paint, page click or browser API is mocked.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, '.paint-artifacts');
const extensionPath = path.join(root, 'extension');
const testFilter = process.env.EXTENSION_TEST_FILTER ? new RegExp(process.env.EXTENSION_TEST_FILTER) : null;
const results = [];
const runtimeErrors = [];
let context;
let browserVersion = 'not launched';
let extensionId;
const server = http.createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/docs/extension-fixture-route') pathname = '/docs/extension-fixture.html';
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'text/plain';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body);
  } catch { response.writeHead(404).end('Not found'); }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function report() {
  const passed = results.filter(result => result.passed).length;
  const lines = [
    '# Loaded extension integration results', '',
    `Run: ${new Date().toISOString()}`, '',
    `Browser: ${browserVersion}`, '',
    `Unpacked extension: ${extensionId || 'not detected'}`, '',
    `Result: **${passed}/${results.length} checks passed**.`, '',
    ...(testFilter ? [`Selected checks: \`${process.env.EXTENSION_TEST_FILTER}\`.`, ''] : []),
    'The browser loaded the extension directory through the manifest content script, then its real module graph in the extension isolated world. Tests use the actual panel, teaching adapter, resolver/fallback and paint implementations. The publication check additionally loads a temporary copy of the same production files with one locally replayed fixture lesson added by the real publisher. No lesson-success, click, resolver or browser API mocks are installed.', '',
    ...results.map(result => `- ${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error.replace(/\n/g, ' ')}` : ''}`), '',
    `Uncaught page or extension console errors: ${runtimeErrors.length}.`,
    ...runtimeErrors.map(error => `- ${error.replace(/\n/g, ' ')}`), '',
    'Scope: ordinary DOM controls on a local HTTP fixture, including native modal dialogs, open shadow roots, nested scrolling and same-origin navigation. This does not certify every website, cross-origin iframe, canvas application, browser version or live Google Docs lesson.', '',
    'Screenshots and the disposable browser profile are saved under ignored `docs/.paint-artifacts/`.', '',
    'Run with `node docs/extension-tests.cjs` after making Playwright available. Set `CHROME_PATH` to a Chromium or Chrome for Testing executable that supports unpacked extensions. Normal branded Chrome builds may ignore extension-loading flags.', '',
  ];
  await fs.writeFile(path.join(__dirname, 'extension-test-results.md'), lines.join('\n'));
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/docs/extension-fixture.html`;
  const profile = await fs.mkdtemp(path.join(artifacts, 'extension-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1440, height: 900 },
  });
  browserVersion = context.browser()?.version() || 'Chromium persistent context';
  // This suite owns the panel; docs/generate-tests.cjs owns the authoring
  // bridge, against a stub. A real bridge left running on the developer's
  // machine would otherwise answer these questions with a live model call —
  // slow, billed, and a different answer every run.
  for (const host of ['localhost', '127.0.0.1']) {
    await context.route(`**://${host}:7777/**`, route => route.abort());
  }
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => runtimeErrors.push(`Page: ${error.message}`));
  const cdp = await context.newCDPSession(page);
  const contexts = new Map();
  let world;
  cdp.on('Runtime.executionContextCreated', ({ context: created }) => contexts.set(created.id, created));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => { contexts.clear(); world = undefined; });
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type !== 'error') return;
    const description = event.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ');
    runtimeErrors.push(`${contexts.get(event.executionContextId)?.name || 'Console'}: ${description}`);
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
          const idValue = await evaluate(`typeof __BT_DEV !== 'undefined' && typeof __BT_DEV.runLesson === 'function' && typeof __TEACH?.highlight === 'function' && chrome.runtime.id`, id);
          if (idValue) { world = id; extensionId = idValue; return; }
        } catch { /* A navigating or initializing context may disappear. */ }
      }
      await pause(70);
    }
    throw new Error(`Real manifest extension did not become ready; execution contexts: ${JSON.stringify([...contexts.values()].map(value => ({ name: value.name, origin: value.origin, type: value.auxData?.type })))}`);
  }
  async function reset() {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    world = undefined;
    await page.goto(url);
    await ready();
    await page.locator('#browser-teacher-root .bt-bar').waitFor();
  }
  async function test(name, run) {
    if (testFilter && !testFilter.test(name)) return;
    const previousErrors = runtimeErrors.length;
    try {
      await reset();
      await run();
      assert.equal(runtimeErrors.length, previousErrors, `Unexpected console/page errors: ${runtimeErrors.slice(previousErrors).join('; ')}`);
      results.push({ name, passed: true }); console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
      const diagnostic = await page.evaluate(() => {
        const root = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot;
        const shapes = {};
        for (const name of ['spot', 'scrim', 'cursor']) {
          const element = root?.querySelector(`.${name}`);
          if (element) {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            shapes[name] = { hidden: element.hidden, display: style.display, visibility: style.visibility, transform: style.transform,
              rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
          }
        }
        const targetRects = {};
        for (const element of document.querySelector('#shadow-host')?.shadowRoot.querySelectorAll('button, dialog') || []) {
          const rect = element.getBoundingClientRect();
          targetRects[element.id] = { connected: element.isConnected, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
            display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility, disabled: element.matches(':disabled'), ariaDisabled: element.getAttribute('aria-disabled') };
        }
        return { url: location.href, now: performance.now(), scrollY, shapes, targetRects, clicks: window.fixture?.clicks,
          panel: document.querySelector('#browser-teacher-root')?.shadowRoot.querySelector('.bt-body')?.textContent };
      }).catch(() => null);
      if (diagnostic && /Native modal inside/.test(name)) {
        diagnostic.extension = await evaluate(`(async () => {
          const resolution = await import(chrome.runtime.getURL('src/teaching/resolution.js'));
          const geometry = await import(chrome.runtime.getURL('src/paint/geometry.js'));
          const pointer = await import(chrome.runtime.getURL('src/paint/pointer.js'));
          const element = resolution.findTarget({ name: 'Confirm shadow modal', scope: 'dialog' }, () => __RESOLVE);
          const cursor = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot.querySelector('.cursor');
          const before = cursor && { hidden: cursor.hidden, transform: cursor.style.transform };
          const result = { resolvedId: element?.id, rect: element && geometry.readRect(element), pointer: pointer.getPointerPosition(), before };
          __TEACH.setCursorVisible(true);
          result.afterVisible = cursor && { hidden: cursor.hidden, transform: cursor.style.transform };
          return result;
        })()`).catch(error => ({ error: error.message }));
      }
      await fs.writeFile(path.join(artifacts, `extension-failure-${results.length}.json`), JSON.stringify(diagnostic, null, 2));
      await page.screenshot({ path: path.join(artifacts, `extension-failure-${results.length}.png`) }).catch(() => {});
    }
  }
  const target = (name, scope) => ({ name, ...(scope ? { scope } : {}) });
  const step = (name, options = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'), mode: 'guided', intent: `Click ${name}.`, target: target(name), action: 'click', verify: { kind: 'none' }, hints: ['Use the named control.', `Find ${name}.`], ...options });
  function lesson(steps) {
    return { id: 'extension-integration', app: 'universal', goal: 'Practice real website controls', preamble: 'Use the real website controls when prompted.', generalization: 'You completed the website actions yourself.', steps };
  }
  async function begin(steps, { preamble = true } = {}) {
    const value = lesson(steps);
    await evaluate(`(() => { window.__integrationRun = __BT_DEV.runLesson(${JSON.stringify(value)}); return true; })()`);
    if (preamble) await page.locator('#browser-teacher-root').getByRole('button', { name: 'Show me', exact: true }).click();
  }
  async function aligned(selector) {
    await page.waitForFunction(selector => {
      const element = document.querySelector(selector) || document.querySelector('#shadow-host')?.shadowRoot.querySelector(selector);
      const spot = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot.querySelector('.spot');
      if (!element || !spot || spot.hidden) return false;
      const a = element.getBoundingClientRect(), b = spot.getBoundingClientRect();
      return Math.abs(a.left - 4 - b.left) < 2 && Math.abs(a.top - 4 - b.top) < 2;
    }, selector);
  }
  async function cursorAligned(selector) {
    await page.waitForFunction(selector => {
      const element = document.querySelector(selector) || document.querySelector('#shadow-host')?.shadowRoot.querySelector(selector);
      const cursor = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot.querySelector('.cursor');
      if (!element || !cursor || cursor.hidden) return false;
      const r = element.getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(cursor).transform);
      return Math.abs(matrix.m41 - r.left - r.width / 2) < 2 && Math.abs(matrix.m42 - r.top - r.height / 2) < 2;
    }, selector);
  }
  async function cleared() {
    await page.waitForFunction(() => {
      const paint = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot;
      return !paint || ['.spot', '.scrim', '.cursor', '.feedback', '.ripple'].every(selector => paint.querySelector(selector).hidden);
    }, null, { timeout: 1200 });
  }
  const count = id => page.evaluate(id => fixture.clicks[id] || 0, id);
  const progress = () => page.locator('#browser-teacher-root .bt-progress').textContent();
  const panelButton = name => page.locator('#browser-teacher-root').getByRole('button', { name, exact: true });
  async function stopped() {
    await page.locator('#browser-teacher-root .bt-window.is-open').waitFor({ state: 'hidden', timeout: 1500 });
    await cleared();
  }
  async function completed() {
    await page.locator('#browser-teacher-root .bt-card-generalization').waitFor();
    await cleared();
  }
  async function sampleFrames() {
    await page.evaluate(() => {
      window.integrationSamples = [];
      window.integrationSampling = true;
      function sample() {
        const cursor = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot.querySelector('.cursor');
        const matrix = cursor ? new DOMMatrix(getComputedStyle(cursor).transform) : null;
        integrationSamples.push({ time: performance.now(), scroll: scrollY, nested: document.querySelector('#scrollbox').scrollTop,
          visible: !!cursor && !cursor.hidden, x: matrix?.m41, y: matrix?.m42 });
        if (integrationSampling) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
  }
  async function samples() { return page.evaluate(() => { integrationSampling = false; return integrationSamples; }); }
  async function panelPaintedAboveScrim() {
    // Browser compositor paint ordering observes pixels' stacking without
    // changing pointer-events, injecting styles, or replacing production APIs.
    const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [], includePaintOrder: true });
    const orders = { panel: [], paint: [] };
    for (const doc of snapshot.documents) {
      for (let i = 0; i < doc.layout.nodeIndex.length; i++) {
        const node = doc.layout.nodeIndex[i];
        const attrs = doc.nodes.attributes[node] || [];
        const attributes = {};
        for (let a = 0; a < attrs.length; a += 2) attributes[snapshot.strings[attrs[a]]] = snapshot.strings[attrs[a + 1]];
        const classes = (attributes.class || '').split(' ');
        if (classes.includes('bt-card-body')) orders.panel.push(doc.layout.paintOrders[i]);
        if (classes.includes('spot') || classes.includes('scrim')) orders.paint.push(doc.layout.paintOrders[i]);
      }
    }
    assert.ok(orders.panel.length && orders.paint.length, `Expected actual panel/scrim in paint snapshot: ${JSON.stringify(orders)}`);
    assert.ok(Math.min(...orders.panel) > Math.max(...orders.paint), `Panel must be painted above scrim: ${JSON.stringify(orders)}`);
  }

  await test('Manifest bootstrap loads real contracts in the extension isolated world', async () => {
    assert.equal(await page.evaluate(() => typeof window.__TEACH), 'undefined');
    assert.deepEqual(await evaluate('Object.keys(__TEACH).sort()'), ['highlight', 'clear', 'moveCursor', 'demo', 'waitForClick', 'verify', 'flashCorrect', 'setCursorVisible'].sort());
    assert.deepEqual(await evaluate('Object.keys(__PAINT).sort()'), ['init', 'spotlight', 'clear', 'moveCursor', 'clickCursor', 'flashCorrect', 'flashWrong', 'setCursorVisible'].sort());
    assert.equal(await page.locator('[data-browser-teacher-paint]').count(), 1);
    assert.ok(extensionId);
  });
  await test('Packaged lesson index discovers and validates every published lesson', async () => {
    const data = JSON.parse(await fs.readFile(path.join(extensionPath, 'lessons', 'index.json'), 'utf8'));
    const entries = Array.isArray(data) ? data : data.lessons;
    assert.ok(Array.isArray(entries) && entries.length, 'The shipped library needs a nonempty index');
    const ids = entries.map(entry => typeof entry === 'string' ? entry : entry.id);
    assert.equal(new Set(ids).size, ids.length, 'The published index must not contain duplicate ids');
    assert.deepEqual(await evaluate('__BT_DEV.lessons()'), ids, 'Discovery must read the packaged index');
    const loaded = await evaluate(`import(chrome.runtime.getURL('src/panel/lessons.js')).then(module => module.loadAll()).then(lessons => lessons.map(lesson => lesson.id))`);
    assert.deepEqual(loaded, ids, 'Every indexed file must load and pass the real panel validator');
    assert.ok(ids.includes('styles-toc') && ids.includes('version-history'));
  });
  await test('Typed question launches the packaged Styles lesson and waits for the real first click', async () => {
    const shipped = JSON.parse(await fs.readFile(path.join(extensionPath, 'lessons', 'styles-toc.json'), 'utf8'));
    await page.locator('#browser-teacher-root .bt-bar-input').fill('How do I add an automatic table of contents?');
    await panelButton('Teach me').click();
    await page.locator('#browser-teacher-root .bt-card-preamble').waitFor();
    assert.equal(await page.locator('#browser-teacher-root .bt-card-title').textContent(), shipped.goal);
    assert.equal(await page.locator('#browser-teacher-root .bt-card-body').textContent(), shipped.preamble);
    await panelButton('Show me').click();
    await cursorAligned('#styles-open');
    assert.equal(await progress(), `1 / ${shipped.steps.length}`);
    assert.equal(await count('styles-open'), 0);
    await page.locator('#styles-open').click();
    await panelButton('Got it').waitFor();
    assert.equal(await progress(), `2 / ${shipped.steps.length}`);
    assert.equal(await count('styles-open'), 1);
    await panelButton('Stop').click();
    await stopped();
  });
  await test('Typed version-history question selects the actual bundled preamble', async () => {
    const shipped = JSON.parse(await fs.readFile(path.join(extensionPath, 'lessons', 'version-history.json'), 'utf8'));
    await page.locator('#browser-teacher-root .bt-bar-input').fill('How can I find and name a version of my document?');
    await panelButton('Teach me').click();
    await page.locator('#browser-teacher-root .bt-card-preamble').waitFor();
    assert.equal(await page.locator('#browser-teacher-root .bt-card-title').textContent(), shipped.goal);
    assert.equal(await page.locator('#browser-teacher-root .bt-card-body').textContent(), shipped.preamble);
    await panelButton('Not now').click();
    await stopped();
  });
  await test('An unknown typed question is refused honestly, and a near miss offers only the related lesson', async () => {
    const shipped = await evaluate(`import(chrome.runtime.getURL('src/panel/lessons.js')).then(module => module.loadAll()).then(lessons => lessons.map(({ id, goal, preamble }) => ({ id, goal, preamble })))`);
    await page.locator('#browser-teacher-root .bt-bar-input').fill('zxqv nebular flibbertigibbet');
    await panelButton('Teach me').click();
    await page.locator('#browser-teacher-root .bt-card-picker').waitFor();
    // Published lessons only. A reachable authoring bridge adds a "work it out
    // for me" button here, and whether one is running must not change this.
    const choices = page.locator('#browser-teacher-root .bt-actions .bt-btn-lesson');
    assert.deepEqual(await choices.allTextContents(), [], 'nonsense must not be answered with unrelated lessons');
    assert.match(await page.locator('#browser-teacher-root .bt-card-title').textContent(), /don't know that one/);
    // Nothing to click on that card, so the question box must come back.
    await page.locator('#browser-teacher-root .bt-bar-input:not([disabled])').waitFor();

    await page.locator('#browser-teacher-root .bt-bar-input').fill('make my document have chapters');
    await panelButton('Teach me').click();
    await page.locator('#browser-teacher-root .bt-card-picker').waitFor();
    const labels = await choices.allTextContents();
    assert.ok(labels.length >= 1 && labels.length <= 3, `expected at most three related lessons, got ${JSON.stringify(labels)}`);
    assert.ok(labels.every(label => shipped.some(lesson => lesson.goal === label)));
    // The contents lesson must be on offer. Which related lesson ranks first is
    // a property of the library, not of the panel: a lesson about changing a
    // heading is just as much about "chapters" and may legitimately outrank it.
    const selected = shipped.find(lesson => lesson.id === 'styles-toc');
    assert.ok(labels.includes(selected.goal), `the contents lesson must be offered, got ${JSON.stringify(labels)}`);
    await choices.filter({ hasText: selected.goal }).first().click();
    await page.locator('#browser-teacher-root .bt-card-preamble').waitFor();
    assert.equal(await page.locator('#browser-teacher-root .bt-card-body').textContent(), selected.preamble);
    await panelButton('Not now').click();
    await stopped();
  });
  await test('A measured fixture replay publishes into a copied extension and launches through its question box', async () => {
    const candidate = {
      id: 'published-paint-practice', app: 'universal', goal: 'Publish the sample article',
      preamble: 'Practice publishing the sample article with the real website button.',
      generalization: 'You activated the sample publishing control yourself.',
      steps: [step('Publish', { target: target('Publish', 'toolbar') })],
    };
    // Collect success from a real trusted browser replay before creating proof.
    // This validates the local publication protocol, not cloud exploration.
    await evaluate(`(() => { window.__integrationRun = __BT_DEV.runLesson(${JSON.stringify(candidate)}); return true; })()`);
    await panelButton('Show me').click();
    await cursorAligned('#publish');
    assert.equal(await count('publish'), 0);
    await page.locator('#publish').click();
    await completed();
    assert.equal(await count('publish'), 1);
    assert.equal(await page.evaluate(() => fixture.trusted.every(click => click.trusted)), true);
    await panelButton('Done').click();
    assert.equal((await evaluate('__integrationRun')).status, 'completed');

    const { publishLesson, verificationEvidence } = await import(pathToFileURL(path.join(root, 'pipeline', 'publish.js')).href);
    const evidence = verificationEvidence(candidate, { ok: true, local: true, steps: [{ id: candidate.steps[0].id, status: 'ok' }] });
    const copiedExtension = await fs.mkdtemp(path.join(artifacts, 'published-extension-'));
    await fs.cp(extensionPath, copiedExtension, { recursive: true });
    const published = await publishLesson(candidate, evidence, { lessonsDir: path.join(copiedExtension, 'lessons') });
    assert.ok(published.ids.includes(candidate.id));
    const copiedProfile = await fs.mkdtemp(path.join(artifacts, 'published-profile-'));
    const publishedContext = await chromium.launchPersistentContext(copiedProfile, {
      headless: true, channel: 'chromium',
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: [`--disable-extensions-except=${copiedExtension}`, `--load-extension=${copiedExtension}`],
      viewport: { width: 1440, height: 900 },
    });
    const publishedPage = publishedContext.pages()[0] || await publishedContext.newPage();
    publishedPage.setDefaultTimeout(12000);
    publishedPage.on('pageerror', error => runtimeErrors.push(`Published fixture: ${error.message}`));
    try {
      const publishedCDP = await publishedContext.newCDPSession(publishedPage);
      publishedCDP.on('Runtime.consoleAPICalled', event => {
        if (event.type === 'error') runtimeErrors.push(`Published extension: ${event.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ')}`);
      });
      await publishedCDP.send('Runtime.enable');
      await publishedPage.goto(url);
      const panel = publishedPage.locator('#browser-teacher-root');
      await panel.locator('.bt-bar-input').fill('How do I publish the sample article?');
      await panel.getByRole('button', { name: 'Teach me', exact: true }).click();
      await panel.locator('.bt-card-preamble').waitFor();
      assert.equal(await panel.locator('.bt-card-title').textContent(), candidate.goal);
      assert.equal(await panel.locator('.bt-card-body').textContent(), candidate.preamble);
      await panel.getByRole('button', { name: 'Show me', exact: true }).click();
      await publishedPage.waitForFunction(() => {
        const cursor = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot.querySelector('.cursor');
        return cursor && !cursor.hidden;
      });
      assert.equal(await publishedPage.evaluate(() => fixture.clicks.publish || 0), 0);
      await publishedPage.locator('#publish').click();
      await panel.locator('.bt-card-generalization').waitFor();
      assert.equal(await publishedPage.evaluate(() => fixture.clicks.publish), 1);
      assert.equal(await publishedPage.evaluate(() => fixture.trusted.every(click => click.trusted)), true);
      await publishedPage.waitForFunction(() => {
        const paint = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot;
        return !paint || ['.spot', '.scrim', '.cursor', '.feedback', '.ripple'].every(selector => paint.querySelector(selector).hidden);
      });
      await panel.getByRole('button', { name: 'Done', exact: true }).click();
      await panel.locator('.bt-window.is-open').waitFor({ state: 'hidden' });
    } catch (error) {
      await publishedPage.screenshot({ path: path.join(artifacts, 'publication-failure.png') }).catch(() => {});
      throw error;
    } finally {
      await publishedContext.close();
    }
  });
  await test('Guided lesson waits for a real correct click and clears every effect', async () => {
    await begin([step('Publish', { target: target('Publish', 'toolbar') })]);
    await cursorAligned('#publish');
    await page.waitForTimeout(1800);
    assert.equal(await count('publish'), 0);
    assert.equal(await progress(), '1 / 1');
    assert.equal(await page.locator('#browser-teacher-root .bt-card-generalization').count(), 0);
    await page.locator('#publish').click();
    await completed();
    assert.equal(await count('publish'), 1);
    assert.equal(await page.evaluate(() => fixture.trusted.every(click => click.trusted)), true);
  });
  await test('Synthetic page clicks do not advance the lesson', async () => {
    await begin([step('Publish')]); await cursorAligned('#publish');
    await page.evaluate(() => document.querySelector('#publish').click());
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#browser-teacher-root .bt-card-generalization').count(), 0);
    await aligned('#publish');
    await page.locator('#publish').click(); await completed();
  });
  await test('A fast correct click during cursor animation is captured before the next step', async () => {
    await begin([step('Publish'), step('Preview')]);
    await page.locator('#publish').click();
    await cursorAligned('#preview');
    assert.equal(await count('publish'), 1);
    assert.equal(await count('preview'), 0);
    assert.equal(await progress(), '2 / 2');
    await page.locator('#preview').click(); await completed();
  });
  await test('Wrong website clicks give correction while panel interactions are ignored', async () => {
    await begin([step('Publish', { wrongHints: { Preview: 'Preview does not publish the document.' } })]);
    await cursorAligned('#publish');
    await page.locator('#browser-teacher-root .bt-card-body').click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#browser-teacher-root .bt-note-wrong').count(), 0);
    await page.locator('#preview').click();
    await page.locator('#browser-teacher-root .bt-note-wrong').waitFor();
    assert.match(await page.locator('#browser-teacher-root .bt-note-wrong').textContent(), /Preview does not publish/);
    assert.equal(await count('publish'), 0);
    await page.locator('#publish').click(); await completed();
  });
  await test('Ghost starts at the actual cursor for the first guided step', async () => {
    await begin([step('Publish')], { preamble: false });
    const box = await panelButton('Show me').boundingBox();
    const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(origin.x, origin.y);
    await sampleFrames(); await page.mouse.click(origin.x, origin.y); await cursorAligned('#publish');
    const visible = (await samples()).filter(sample => sample.visible);
    assert.ok(visible.length >= 3);
    assert.ok(Math.hypot(visible[0].x - origin.x, visible[0].y - origin.y) < 90, `Ghost origin differs from pointer: ${JSON.stringify({ origin, first: visible[0] })}`);
    assert.ok(new Set(visible.map(sample => Math.round(sample.x))).size >= 3, 'Ghost must animate across multiple frames');
  });
  await test('Nested second step scrolls progressively and starts from the latest real pointer', async () => {
    await begin([step('Publish'), step('Confirm nested')]); await cursorAligned('#publish');
    await sampleFrames();
    await page.locator('#publish').click();
    await page.mouse.move(160, 120);
    await cursorAligned('#nested');
    const recorded = await samples();
    const max = Math.max(...recorded.map(sample => sample.nested));
    assert.ok(max > 100);
    assert.ok(new Set(recorded.filter(sample => sample.nested > 1 && sample.nested < max - 1).map(sample => Math.round(sample.nested))).size >= 2, 'Nested scrolling must progress across frames');
    const afterScroll = recorded.filter(sample => sample.visible && sample.nested > max - 2);
    assert.ok(afterScroll.length >= 3);
    assert.ok(Math.hypot(afterScroll[0].x - 160, afterScroll[0].y - 120) < 90, `Later ghost did not start at latest pointer: ${JSON.stringify(afterScroll[0])}`);
    await page.locator('#nested').click(); await completed();
  });
  await test('Downpage target scrolls smoothly and reaches the actual button', async () => {
    await sampleFrames(); await begin([step('Confirm at bottom')]); await cursorAligned('#bottom');
    const recorded = await samples();
    const max = Math.max(...recorded.map(sample => sample.scroll));
    assert.ok(max > 1000);
    assert.ok(new Set(recorded.filter(sample => sample.scroll > 1 && sample.scroll < max - 1).map(sample => Math.round(sample.scroll))).size >= 3, 'Page must visibly scroll, not jump');
    await page.locator('#bottom').click(); await completed();
  });
  await test('Manually scrolling away retains the full grey effect and restores target tracking', async () => {
    await begin([step('Publish')]); await cursorAligned('#publish');
    await page.mouse.move(750, 200); await page.mouse.wheel(0, 1100);
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-browser-teacher-paint]').shadowRoot;
      return root.querySelector('.spot').hidden && !root.querySelector('.scrim').hidden && root.querySelector('.cursor').hidden;
    });
    await page.mouse.wheel(0, -3000); await aligned('#publish'); await cursorAligned('#publish');
    await page.locator('#publish').click(); await completed();
  });
  await test('Reduced motion positions downpage guidance without a long cursor tween', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const started = Date.now();
    await begin([step('Confirm at bottom')]); await cursorAligned('#bottom');
    assert.ok(Date.now() - started < 1400, 'Reduced motion should settle without normal smooth scroll plus cursor animation');
    await page.locator('#bottom').click(); await completed();
  });
  await test('Same-page menu chain requires opener then newly revealed item', async () => {
    await begin([step('Options', { verify: { kind: 'visible', name: 'Schedule publication', scope: 'menu' } }), step('Schedule publication', { target: target('Schedule publication', 'menu') })]);
    await cursorAligned('#menu-open');
    assert.equal(await page.locator('#menu').isVisible(), false);
    await page.waitForTimeout(350); assert.equal(await count('menu-open'), 0);
    await page.locator('#menu-open').click(); await cursorAligned('#schedule');
    assert.equal(await progress(), '2 / 2'); assert.equal(await count('schedule'), 0);
    await page.locator('#schedule').click(); await completed();
    assert.equal(await count('menu-open'), 1); assert.equal(await count('schedule'), 1);
  });
  await test('Native modal guidance requires two real clicks with readable panel above scrim', async () => {
    await begin([step('Open confirmation', { verify: { kind: 'visible', name: 'Confirm in modal', scope: 'dialog' } }), step('Confirm in modal', { target: target('Confirm in modal', 'dialog') })]);
    await cursorAligned('#modal-open');
    assert.equal(await page.locator('#dialog').isVisible(), false);
    await page.locator('#modal-open').click(); await cursorAligned('#modal-confirm');
    assert.equal(await count('modal-confirm'), 0);
    await panelPaintedAboveScrim();
    await page.screenshot({ path: path.join(artifacts, 'extension-modal-guidance.png') });
    await page.locator('#modal-confirm').click(); await completed();
    assert.equal(await page.locator('#dialog').isVisible(), false);
  });
  await test('Panel remains above normal guidance and accepts Stop while a modal is open', async () => {
    await begin([step('Open confirmation'), step('Confirm in modal')]);
    await cursorAligned('#modal-open'); await panelPaintedAboveScrim();
    await page.locator('#modal-open').click(); await cursorAligned('#modal-confirm');
    await panelButton('Stop').click(); await stopped();
    assert.equal(await count('modal-confirm'), 0);
    assert.equal(await page.locator('#dialog').isVisible(), true, 'Stopping guidance should not perform the website action');
  });
  await test('Native modal inside an open shadow root keeps guidance and Stop accessible', async () => {
    await begin([step('Open shadow modal'), step('Confirm shadow modal', { target: target('Confirm shadow modal', 'dialog') })]);
    await cursorAligned('#shadow-modal-open');
    await page.locator('#shadow-host').getByRole('button', { name: 'Open shadow modal', exact: true }).click();
    await cursorAligned('#shadow-modal-confirm'); await panelPaintedAboveScrim();
    await panelButton('Stop').click(); await stopped();
    assert.equal(await count('shadow-modal-confirm'), 0);
    assert.equal(await page.locator('#shadow-host #shadow-dialog').isVisible(), true);
  });
  await test('Stop aborts unresolved targets and prevents delayed effects', async () => {
    await begin([step('Absent action')]);
    await panelButton('Stop').click(); await stopped();
    await page.waitForTimeout(2300); await cleared();
    assert.equal(await page.locator('#browser-teacher-root .bt-window.is-open').count(), 0);
  });
  await test('Close aborts smooth scrolling without a delayed cursor or step', async () => {
    await begin([step('Confirm at bottom'), step('Publish')]);
    await page.waitForFunction(() => scrollY > 10);
    await page.locator('#browser-teacher-root .bt-close').click(); await stopped();
    await page.waitForTimeout(100);
    const position = await page.evaluate(() => scrollY);
    await page.waitForTimeout(850);
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - position) < 2, 'Cancelled scroll must stay stopped');
    await cleared(); assert.equal(await count('bottom'), 0);
  });
  await test('Correct click clears immediately during verification and Stop cancels verification', async () => {
    await page.evaluate(() => { fixture.verifyDelay = -1; });
    await begin([step('Start verification', { verify: { kind: 'label', selector: '#verify-state', match: 'Verified' } }), step('Publish')]);
    await cursorAligned('#verify'); await page.locator('#verify').click(); await cleared();
    assert.equal(await page.locator('#verify-state').textContent(), 'Waiting');
    await panelButton('Stop').click(); await stopped();
    await page.waitForTimeout(3200); await cleared(); assert.equal(await count('publish'), 0);
    assert.equal(await page.locator('#browser-teacher-root .bt-window.is-open').count(), 0);
  });
  await test('Restart cancels stale resolution without closing or replacing the new step', async () => {
    await begin([step('Absent action'), step('Preview')]);
    await begin([step('Publish')]); await cursorAligned('#publish');
    await page.waitForTimeout(2300); await aligned('#publish');
    assert.equal(await progress(), '1 / 1');
    assert.match(await page.locator('#browser-teacher-root .bt-card-body').textContent(), /Publish/);
    await page.locator('#publish').click(); await completed(); assert.equal(await count('preview'), 0);
  });
  await test('Hidden duplicates are excluded and open shadow-root controls resolve', async () => {
    await begin([step('Unique action'), step('Shadow action')]);
    await cursorAligned('#unique'); await page.locator('#unique').click(); await cursorAligned('#shadow-action');
    await page.locator('#shadow-host').getByRole('button', { name: 'Shadow action' }).click(); await completed();
    assert.equal(await count('duplicate-hidden'), 0); assert.equal(await count('shadow-action'), 1);
  });
  await test('Native button text and associated input labels resolve without aria-label', async () => {
    await begin([step('Native text action'), step('Display name')]);
    await cursorAligned('#native-action'); await page.locator('#native-action').click();
    await cursorAligned('#name-input'); await page.locator('label[for="name-input"]').click();
    await completed();
    assert.equal(await count('native-action'), 1);
    assert.equal(await page.locator('#name-input').evaluate(element => element === document.activeElement), true);
  });
  await test('Disabled native and ARIA duplicates cannot shadow an enabled website action', async () => {
    await begin([step('Ready duplicate', { target: target('Ready duplicate', 'toolbar') })]);
    await cursorAligned('#ready-duplicate');
    await page.locator('#ready-duplicate').click(); await completed();
    assert.equal(await count('ready-duplicate'), 1);
    assert.equal(await count('ready-duplicate-native'), 0);
    assert.equal(await count('ready-duplicate-aria'), 0);
  });
  for (const kind of ['native', 'aria']) {
    await test(`${kind === 'native' ? 'Native disabled' : 'ARIA-disabled'} target waits for document readiness before highlighting or moving the ghost`, async () => {
      const loader = kind === 'native' ? 'Load native document' : 'Load ARIA document';
      const action = kind === 'native' ? 'Native document action' : 'ARIA document action';
      await begin([step(loader), step(action, { target: target(action, 'toolbar') })]);
      await cursorAligned(`#load-${kind}`); await sampleFrames();
      await page.locator(`#load-${kind}`).click();
      assert.equal(await page.locator(`#${kind}-ready`).isDisabled(), true);
      await cleared(); await page.waitForTimeout(220); await cleared();
      assert.equal(await page.evaluate(kind => fixture.readyTimes[kind].enabled, kind), null);
      assert.equal(await count(`${kind}-ready`), 0);
      await cursorAligned(`#${kind}-ready`);
      const recorded = await samples();
      const times = await page.evaluate(kind => fixture.readyTimes[kind], kind);
      assert.ok(times.enabled > times.created + 800, 'The fixture must expose a genuinely disabled loading interval');
      assert.ok(times.enabled < times.created + 2000, 'Readiness must happen within the existing resolver retry window');
      assert.equal(recorded.some(sample => sample.visible && sample.time > times.created + 10 && sample.time < times.enabled), false, 'The ghost must remain hidden until the target is enabled');
      assert.ok(recorded.some(sample => sample.visible && sample.time >= times.enabled), 'The real ghost must arrive after readiness');
      await page.locator(`#${kind}-ready`).click(); await completed();
      assert.equal(await count(`${kind}-ready`), 1);
      assert.equal(await page.evaluate(() => fixture.trusted.every(click => click.trusted)), true);
    });
  }
  await test('A replaced Styles button verifies the richer inner aria-label after the user selects a heading', async () => {
    await begin([
      step('Styles', { target: target('Styles', 'toolbar'), verify: { kind: 'visible', name: 'Apply Heading 1', scope: 'menu' } }),
      step('Apply Heading 1', { target: target('Apply Heading 1', 'menu'), verify: { kind: 'label', selector: '#style-toolbar [aria-label^="Styles list."]', match: 'Heading 1' } }),
    ]);
    await cursorAligned('#styles-open');
    assert.equal(await page.locator('#styles-menu').isVisible(), false);
    await page.locator('#styles-open').click(); await cursorAligned('#heading-one');
    assert.equal(await page.locator('#styles-open').count(), 0, 'Opening the menu must replace the original outer control');
    assert.equal(await page.locator('#style-readout').getAttribute('aria-label'), 'Styles list. Normal text selected.');
    assert.equal(await page.locator('#style-readout').textContent(), '◈', 'The outcome must not be available through textContent');
    assert.equal(await count('heading-one'), 0);
    await page.locator('#heading-one').click(); await completed();
    assert.equal(await page.locator('#style-readout').getAttribute('aria-label'), 'Styles list. Heading 1 selected.');
    assert.equal(await page.locator('#style-readout').textContent(), '◈');
    assert.equal(await count('styles-open'), 1); assert.equal(await count('heading-one'), 1);
  });
  // The bug this guards: the dropdown opens on mousedown, so by click time the
  // control the step named no longer carries that name, and the only labelled
  // element left states the current value. Classifying that as a different
  // control reported a wrong click for a correct one and stranded the learner
  // on a step they had just done, with the highlight still up.
  await test('A dropdown that opens on mousedown still counts as a correct click', async () => {
    await begin([
      step('Zoom', { target: target('Zoom', 'toolbar'), verify: { kind: 'visible', name: '150%', scope: 'menu' } }),
      step('150%', { target: target('150%', 'menu'), verify: { kind: 'label', selector: '#zoom-slot [aria-label^="Zoom list."]', match: '150%' } }),
    ]);
    await cursorAligned('#zoom-open');
    assert.equal(await page.locator('#zoom-menu').isVisible(), false);
    await page.locator('#zoom-open').click();
    // The name is gone and the readout is all that is left — and it advanced anyway.
    assert.equal(await page.locator('#zoom-open').getAttribute('aria-label'), null);
    await cursorAligned('#zoom-150');
    assert.equal(await progress(), '2 / 2', 'a correct click must advance, not report a wrong control');
    await page.locator('#zoom-150').click(); await completed();
    assert.equal(await count('zoom-open'), 1); assert.equal(await count('zoom-150'), 1);
  });

  async function fontChoices({ grouped = true, hideOnMouseup = false } = {}) {
    await page.evaluate(({ grouped, hideOnMouseup }) => {
      const list = document.createElement('div');
      list.id = 'choice-list';
      if (grouped) {
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', 'Font list. Arial selected.');
      }
      list.style.cssText = 'width:320px;padding:28px;margin:20px;background:white;';
      list.innerHTML = '<div role="option" id="choice-arial">Arial</div>'
        + '<div role="option" id="choice-georgia"><span>Georgia</span></div>'
        + '<div role="option" id="choice-disabled" aria-disabled="true">Unavailable font</div>'
        + '<input id="choice-search" aria-label="Search fonts">'
        + '<button id="choice-more">More fonts</button>';
      list.addEventListener(hideOnMouseup ? 'mouseup' : 'click', event => {
        const option = event.target.closest('[role="option"]');
        if (!option || option.getAttribute('aria-disabled') === 'true') return;
        window.chosenFont = option.textContent;
        if (hideOnMouseup) list.hidden = true;
      });
      document.body.prepend(list);
    }, { grouped, hideOnMouseup });
  }

  await test('Free-choice font steps ignore blank space, disabled options and list tools', async () => {
    await fontChoices();
    await begin([step('Arial', { target: { scope: 'menu', name: 'Arial', any: true } })]);
    await cursorAligned('#choice-list');
    await page.locator('#choice-list').click({ position: { x: 8, y: 8 } });
    const disabled = await page.locator('#choice-disabled').boundingBox();
    await page.mouse.click(disabled.x + disabled.width / 2, disabled.y + disabled.height / 2);
    await page.locator('#choice-search').click();
    await page.locator('#choice-more').click();
    assert.equal(await page.locator('#browser-teacher-root .bt-card-generalization').count(), 0);
    assert.equal(await progress(), '1 / 1');
    await page.locator('#choice-georgia span').click();
    await completed();
    assert.equal(await page.evaluate(() => chosenFont), 'Georgia');
  });

  for (const grouped of [true, false]) {
    await test(`Free-choice ${grouped ? 'list' : 'sibling'} options stay correct when mouseup hides the popup`, async () => {
      await fontChoices({ grouped, hideOnMouseup: true });
      await begin([step('Arial', { target: { scope: 'menu', name: 'Arial', any: true } })]);
      await cursorAligned(grouped ? '#choice-list' : '#choice-arial');
      await page.locator('#choice-georgia span').click();
      await completed();
      assert.equal(await page.locator('#choice-list').isVisible(), false);
      assert.equal(await page.evaluate(() => chosenFont), 'Georgia');
    });
  }

  await test('A free choice needs no row roles: plain rows in a menu the page removes on mousedown', async () => {
    await page.evaluate(() => {
      const menu = document.createElement('div');
      menu.id = 'plain-menu';
      menu.setAttribute('role', 'menu');
      menu.style.cssText = 'width:320px;padding:28px;margin:20px;background:white;';
      menu.innerHTML = '<div id="plain-baskerville">Baskerville</div><div id="plain-cambria"><span>Cambria</span></div>';
      menu.addEventListener('mousedown', event => {
        const row = event.target.closest('#plain-menu > div');
        if (!row) return;
        window.chosenPlain = row.textContent;
        menu.remove();   // gone before mouseup, let alone the click
      });
      document.body.prepend(menu);
    });
    await begin([step('Baskerville', { target: { scope: 'menu', name: 'Baskerville', any: true } })]);
    await cursorAligned('#plain-menu');
    await page.locator('#plain-cambria span').click();
    await completed();
    assert.equal(await page.evaluate(() => chosenPlain), 'Cambria');
  });

  await test('A font step without free choice still requires its named value', async () => {
    await fontChoices();
    await begin([step('Arial', { target: { scope: 'menu', name: 'Arial' } })]);
    await cursorAligned('#choice-arial');
    await page.locator('#choice-georgia').click();
    assert.equal(await page.locator('#browser-teacher-root .bt-card-generalization').count(), 0);
    await page.locator('#choice-arial').click();
    await completed();
  });

  async function docsFontChoices() {
    // Observed in live Docs: checkbox menu rows, Recent + alphabetical Arial,
    // and the toolbar's selected-value readout outside the popup.
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.innerHTML = '<div role="toolbar"><div id="docs-font-test-open" role="listbox" aria-label="Font">'
        + '<span id="docs-font-test-readout" role="option" aria-label="Font list. Arial selected.">Arial</span></div></div>'
        + '<div id="docs-font-test-menu" role="menu" hidden style="width:320px;padding:24px;background:white">'
        + '<div role="menuitem" id="docs-font-more">More fonts</div>'
        + '<div role="menuitem" aria-disabled="true">RECENT</div>'
        + '<div role="menuitemcheckbox" id="docs-font-recent">Arial</div>'
        + '<div><div role="menuitemcheckbox" id="docs-font-alpha">Arial</div>'
        + '<div role="menuitemcheckbox" id="docs-font-georgia"><span>Georgia</span></div>'
        + '<div role="menuitemcheckbox" aria-disabled="true">Unavailable font</div></div></div>';
      document.body.prepend(fixture);
      const menu = document.querySelector('#docs-font-test-menu');
      document.querySelector('#docs-font-test-open').addEventListener('mousedown', () => { menu.hidden = false; });
      menu.addEventListener('mouseup', event => {
        const choice = event.target.closest('[role="menuitemcheckbox"]');
        if (!choice || choice.getAttribute('aria-disabled') === 'true') return;
        document.querySelector('#docs-font-test-readout').setAttribute('aria-label', `Font list. ${choice.textContent} selected.`);
        menu.hidden = true;
      });
    });
  }

  await test('Docs font free choice completes with duplicate Arial checkbox rows and mouseup dismissal', async () => {
    await docsFontChoices();
    await begin([
      step('Font', { target: { scope: 'toolbar', name: 'Font' }, verify: { kind: 'visible', scope: 'menu', name: 'Arial' } }),
      step('Arial', { target: { scope: 'menu', name: 'Arial', any: true } }),
    ]);
    await cursorAligned('#docs-font-test-open');
    await page.locator('#docs-font-test-open').click();
    await cursorAligned('#docs-font-test-menu');
    assert.equal(await progress(), '2 / 2');
    await page.locator('#docs-font-more').click();
    assert.equal(await page.locator('#browser-teacher-root .bt-card-generalization').count(), 0);
    await page.locator('#docs-font-georgia span').click();
    await completed();
    assert.equal(await page.locator('#docs-font-test-readout').getAttribute('aria-label'), 'Font list. Georgia selected.');
  });

  await test('Free-choice duplicate names may share a menu but cannot span different menus', async () => {
    await docsFontChoices();
    await page.locator('#docs-font-test-open').click();
    assert.equal(await evaluate(`__RESOLVE.findSync({ scope: 'menu', name: 'Arial' })?.id || null`), null);
    assert.equal(await evaluate(`__RESOLVE.findSync({ scope: 'menu', name: 'Arial', any: true })?.id`), 'docs-font-recent');
    await page.evaluate(() => {
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<div role="menuitemcheckbox">Arial</div>';
      document.body.prepend(menu);
    });
    assert.equal(await evaluate(`__RESOLVE.findSync({ scope: 'menu', name: 'Arial', any: true })?.id || null`), null);
    assert.equal(await evaluate(`import(chrome.runtime.getURL('src/teaching/resolution.js')).then(m => m.findTarget({ scope: 'menu', name: 'Arial', any: true }, () => __RESOLVE)?.id || null)`), null);
  });

  await test('Existing textContent label outcomes still verify after a real user action', async () => {
    await begin([step('Start verification', { verify: { kind: 'label', selector: '#verify-state', match: 'Verified' } })]);
    await cursorAligned('#verify');
    assert.equal(await page.locator('#verify-state').textContent(), 'Idle');
    assert.equal(await count('verify'), 0);
    await page.locator('#verify').click(); await completed();
    assert.equal(await page.locator('#verify-state').textContent(), 'Verified');
    assert.equal(await page.locator('#verify-state').getAttribute('aria-label'), null);
  });
  await test('Ambiguous targets do not silently select the first matching control', async () => {
    await begin([step('Ambiguous action')]);
    await page.waitForTimeout(2300); await cleared();
    assert.equal(await count('ambiguous-one'), 0); assert.equal(await count('ambiguous-two'), 0);
    await page.locator('#ambiguous-one').click(); await page.waitForTimeout(250);
    assert.equal(await page.locator('#browser-teacher-root .bt-card-generalization').count(), 0);
    await panelButton('Stop').click(); await stopped();
  });
  await test('Explicit nth disambiguates visible matches', async () => {
    await begin([step('Ambiguous action', { target: { name: 'Ambiguous action', nth: 1 } })]);
    await cursorAligned('#ambiguous-two'); await page.locator('#ambiguous-two').click(); await completed();
    assert.equal(await count('ambiguous-one'), 0); assert.equal(await count('ambiguous-two'), 1);
  });
  await test('Same-document hash links can continue a chain', async () => {
    await begin([step('Jump within page'), step('Publish')]); await cursorAligned('#hash');
    await page.locator('#hash').click(); await cursorAligned('#publish');
    assert.equal(new URL(page.url()).hash, '#same-page');
    await page.locator('#publish').click(); await completed();
  });
  await test('SPA path navigation cancels the run and clears pending next steps', async () => {
    await begin([step('Open another route'), step('Publish')]); await cursorAligned('#spa');
    await page.locator('#spa').click(); await stopped();
    assert.match(new URL(page.url()).pathname, /extension-fixture-route$/);
    await page.waitForTimeout(850); await cleared(); assert.equal(await count('publish'), 0);
  });
  await test('Real redirect starts the next document with no continuing lesson or effects', async () => {
    await begin([step('Open next page'), step('Publish')]); await cursorAligned('#redirect');
    await Promise.all([page.waitForURL('**?destination=1'), page.locator('#redirect').click()]);
    await ready(); await page.locator('#browser-teacher-root .bt-bar').waitFor(); await stopped();
    await page.waitForTimeout(850); await cleared();
    assert.equal(await count('publish'), 0);
    assert.equal(await page.locator('#browser-teacher-root .bt-card-step').count(), 0);
  });
  await test('Demo mode remains visual and requires the user to activate the website', async () => {
    await begin([step('Publish', { mode: 'demo' })]); await cursorAligned('#publish');
    await page.waitForTimeout(1700); assert.equal(await count('publish'), 0);
    await page.locator('#publish').click(); await completed();
  });
  await test('Solo mode accepts a real action without revealing guidance', async () => {
    await begin([step('Publish', { mode: 'solo' })]); await page.waitForTimeout(120); await cleared();
    await page.locator('#publish').click(); await completed();
  });

  assert.equal(runtimeErrors.length, 0, 'No unexpected page or extension console errors');
})().catch(error => {
  console.error(error);
  results.push({ name: 'Integration runner completed', passed: false, error: error.message });
}).finally(async () => {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await report();
  const passed = results.filter(result => result.passed).length;
  console.log(`${passed}/${results.length} loaded extension checks passed`);
  if (results.some(result => !result.passed)) process.exitCode = 1;
});
