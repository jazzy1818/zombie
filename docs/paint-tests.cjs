// Run: node docs/paint-tests.cjs (Playwright installed or available via NODE_PATH).
// Optional CHROME_PATH and PAINT_ARTIFACT_DIR override browser/output locations.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const artifacts = process.env.PAINT_ARTIFACT_DIR || path.join(__dirname, '.paint-artifacts');
const results = [];
const errors = [];
let browser;
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain';
    response.writeHead(200, { 'Content-Type': type }); response.end(body);
  } catch { response.writeHead(404).end('Not found'); }
});

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/docs/paint-harness.html`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.pendingPaintFrames = new Set();
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => {
      const id = request(time => { window.pendingPaintFrames.delete(id); callback(time); });
      window.pendingPaintFrames.add(id); return id;
    };
    window.cancelAnimationFrame = id => { window.pendingPaintFrames.delete(id); cancel(id); };
  });
  async function reset() {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    await page.waitForFunction(() => window.paintReady);
  }
  async function test(name, run) {
    await reset();
    try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  async function aligned(selector) {
    await page.waitForFunction(selector => {
      const spot = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.spot');
      const a = document.querySelector(selector).getBoundingClientRect();
      const b = spot.getBoundingClientRect();
      return !spot.hidden && Math.abs(a.left - 4 - b.left) < 1 && Math.abs(a.top - 4 - b.top) < 1;
    }, selector, { timeout: 2500 });
  }
  const hidden = () => page.evaluate(() => document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.spot').hidden);
  async function cursorAligned(selector) {
    await page.waitForFunction(selector => {
      const cursor = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.cursor');
      const rect = document.querySelector(selector).getBoundingClientRect();
      const transform = new DOMMatrix(getComputedStyle(cursor).transform);
      return !cursor.hidden && Math.abs(transform.m41 - (rect.left + rect.width / 2)) < 1
        && Math.abs(transform.m42 - (rect.top + rect.height / 2)) < 1;
    }, selector, { timeout: 3000 });
  }
  async function assertCleared() {
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-browser-teacher-paint]')?.shadowRoot;
      return (!root || ['.spot', '.scrim', '.cursor', '.ripple', '.feedback'].every(selector => root.querySelector(selector).hidden))
        && window.pendingPaintFrames.size === 0;
    }, null, { timeout: 1000 });
  }
  async function recordGuidanceTargets() {
    await page.evaluate(() => {
      window.guidanceTargets = [];
      const spotlight = __PAINT.spotlight;
      __PAINT.spotlight = async box => { window.guidanceTargets.push(box.id); await spotlight(box); };
    });
  }
  async function assertOffscreenDim() {
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-browser-teacher-paint]').shadowRoot;
      return root.querySelector('.spot').hidden && !root.querySelector('.scrim').hidden;
    });
    const surface = await page.evaluate(() => {
      const scrim = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.scrim');
      const rect = scrim.getBoundingClientRect();
      const style = getComputedStyle(scrim);
      return {
        fullViewport: rect.left <= 0 && rect.top <= 0 && rect.right >= innerWidth && rect.bottom >= innerHeight,
        background: style.backgroundColor, opacity: Number(style.opacity), pointerEvents: style.pointerEvents,
      };
    });
    assert.equal(surface.fullViewport, true, 'Offscreen guidance must dim the entire viewport');
    assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(surface.background, 'transparent');
    assert.ok(surface.opacity > 0);
    assert.equal(surface.pointerEvents, 'none');
  }
  async function assertSmoothScroll(selector, containerSelector = null) {
    const result = await page.evaluate(async ({ selector, containerSelector }) => {
      const container = containerSelector ? document.querySelector(containerSelector) : null;
      const position = () => container ? container.scrollTop : window.scrollY;
      const initial = position();
      const samples = [initial];
      let frame;
      let stopped = false;
      const sample = () => { samples.push(position()); if (!stopped) frame = requestAnimationFrame(sample); };
      frame = requestAnimationFrame(sample);
      let deadline;
      try {
        await Promise.race([
          __PAINT.spotlight(document.querySelector(selector)),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Spotlight did not settle after scrolling')), 3000); }),
        ]);
        const atResolve = position();
        await new Promise(resolve => setTimeout(resolve, 100));
        return { initial, samples, atResolve, afterResolve: position() };
      } finally {
        stopped = true; cancelAnimationFrame(frame); clearTimeout(deadline);
      }
    }, { selector, containerSelector });
    assert.ok(result.atResolve > result.initial + 20, 'The fixture must actually scroll');
    const intermediates = new Set(result.samples.filter(value => value > result.initial + 1 && value < result.atResolve - 1).map(Math.round));
    assert.ok(intermediates.size >= 2, `Expected progressive scrolling, observed ${JSON.stringify(result.samples)}`);
    assert.ok(Math.abs(result.atResolve - result.afterResolve) < 1, 'Spotlight must await the final scroll position');
    await aligned(selector);
  }

  await test('Contract 3, idempotent init and resolver independence', async () => {
    const result = await page.evaluate(async () => {
      Object.defineProperty(window, '__RESOLVE', { get() { throw new Error('Paint accessed resolver'); } });
      const initReturn = __PAINT.init(); __PAINT.init();
      await __PAINT.spotlight(document.querySelector('#target'));
      return { keys: Object.keys(__PAINT).sort(), count: document.querySelectorAll('[data-browser-teacher-paint]').length, voidInit: initReturn === undefined };
    });
    assert.deepEqual(result.keys, ['init', 'spotlight', 'clear', 'moveCursor', 'clickCursor', 'flashCorrect', 'flashWrong', 'setCursorVisible'].sort());
    assert.equal(result.count, 1); assert.equal(result.voidInit, true); await aligned('#target');
  });
  await test('Real click-through, no focus stealing and no synthetic cursor click', async () => {
    await page.locator('#focus-target').focus();
    await page.evaluate(async () => {
      await __PAINT.spotlight(document.querySelector('#target'));
      await __PAINT.moveCursor(document.querySelector('#target'));
      await __PAINT.clickCursor();
    });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'focus-target');
    assert.equal(await page.evaluate(() => publishClicks), 0);
    const rect = await page.locator('#target').boundingBox();
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert.equal(await page.evaluate(() => publishClicks), 1);
  });
  await test('Snapshot rectangles do not follow document scroll or caller mutation', async () => {
    await page.evaluate(async () => {
      const box = { top: 110, left: 220, width: 140, height: 40 };
      await __PAINT.spotlight(box); box.top = 600; window.scrollTo(0, 300);
    });
    await page.waitForTimeout(70);
    const rect = await page.evaluate(() => {
      const r = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.spot').getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    });
    assert.deepEqual(rect, { top: 106, left: 216, width: 148, height: 48 });
  });
  await test('Scroll tracking, layout shifts and responsive viewport', async () => {
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#target')));
    await page.evaluate(() => window.scrollTo(0, 150)); await aligned('#target');
    await page.evaluate(() => document.querySelector('header').style.paddingBottom = '70px'); await aligned('#target');
    await page.setViewportSize({ width: 820, height: 700 }); await aligned('#target');
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await test('Nested scrolling clips and restores the visible highlight', async () => {
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#nested-target')));
    await aligned('#nested-target');
    await page.evaluate(() => { const s = document.querySelector('#scrollbox'); const t = document.querySelector('#nested-target'); s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top + 12; });
    await page.waitForTimeout(70);
    assert.equal(await page.evaluate(() => {
      const spot = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.spot').getBoundingClientRect();
      return Math.abs(spot.top - (document.querySelector('#scrollbox').getBoundingClientRect().top + 1 - 4)) < 1;
    }), true);
    await page.evaluate(() => { document.querySelector('#scrollbox').scrollTop = 0; });
    await assertOffscreenDim();
    await page.evaluate(() => { document.querySelector('#scrollbox').scrollTop = 190; }); await aligned('#nested-target');
  });
  await test('Scrolling a highlighted target outside the viewport preserves dimming and click-through', async () => {
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#target')));
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await assertOffscreenDim();
    await page.evaluate(() => {
      window.offscreenClicks = 0;
      document.querySelector('#offscreen-target').addEventListener('click', () => window.offscreenClicks++);
    });
    await page.locator('#offscreen-target').click();
    assert.equal(await page.evaluate(() => window.offscreenClicks), 1);
    await assertOffscreenDim();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await aligned('#target');
    await page.evaluate(() => __PAINT.clear());
    assert.equal(await page.evaluate(() => document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.scrim').hidden), true);
    assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
  });
  await test('Offscreen dimming clears when the target becomes hidden or disconnected', async () => {
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#nested-target')));
    await page.evaluate(() => { document.querySelector('#scrollbox').scrollTop = 0; });
    await assertOffscreenDim();
    await page.evaluate(() => { document.querySelector('#nested-target').hidden = true; });
    await page.waitForFunction(() => document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.scrim').hidden);
    assert.equal(await hidden(), true);
    await page.evaluate(() => { document.querySelector('#nested-target').hidden = false; });
    await assertOffscreenDim();
    await page.evaluate(() => document.querySelector('#nested-target').remove());
    await page.waitForFunction(() => document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.scrim').hidden);
    assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
  });
  await test('Offscreen window guidance scrolls progressively and resolves at the destination', async () => {
    await assertSmoothScroll('#offscreen-target');
  });
  await test('Nested guidance scrolls progressively and resolves at the destination', async () => {
    await assertSmoothScroll('#nested-target', '#scrollbox');
  });
  await test('Nested harness guidance awaits scroll completion before moving the ghost cursor', async () => {
    await page.evaluate(() => {
      window.guidanceCalls = [];
      const spotlight = __PAINT.spotlight;
      const moveCursor = __PAINT.moveCursor;
      __PAINT.spotlight = async box => {
        window.guidanceCalls.push({ phase: 'spotlight-start', target: box.id });
        await spotlight(box);
        window.guidanceCalls.push({ phase: 'spotlight-complete', target: box.id });
      };
      __PAINT.moveCursor = async box => {
        const rect = box.getBoundingClientRect();
        const container = document.querySelector('#scrollbox').getBoundingClientRect();
        window.guidanceCalls.push({ phase: 'cursor-start', target: box.id,
          targetVisible: rect.top >= container.top && rect.bottom <= container.bottom && rect.top >= 0 && rect.bottom <= innerHeight });
        await moveCursor(box);
        window.guidanceCalls.push({ phase: 'cursor-complete', target: box.id });
      };
    });
    await page.locator('#show-scroll').click();
    await cursorAligned('#nested-target');
    await page.waitForFunction(() => window.guidanceCalls.some(call => call.phase === 'cursor-complete'));
    const calls = await page.evaluate(() => window.guidanceCalls);
    assert.deepEqual(calls.map(call => call.phase), ['spotlight-start', 'spotlight-complete', 'cursor-start', 'cursor-complete']);
    assert.ok(calls.every(call => call.target === 'nested-target'));
    assert.equal(calls[2].targetVisible, true);
    assert.equal(await page.evaluate(() => publishClicks), 0);
  });
  await test('Primary guidance ignores wrong clicks and clears all effects on the correct click', async () => {
    await page.locator('#show-guidance').click();
    await cursorAligned('#target');
    await page.locator('#wrong-target').click();
    await aligned('#target');
    assert.equal(await page.evaluate(() => publishClicks), 0);
    await page.locator('#target').click();
    assert.equal(await page.evaluate(() => publishClicks), 1, 'The real control must still receive the activation');
    await assertCleared();
  });
  await test('Nested guidance clears after the real target is clicked', async () => {
    await page.evaluate(() => {
      window.nestedClicks = 0;
      document.querySelector('#nested-target').addEventListener('click', () => window.nestedClicks++);
    });
    await page.locator('#show-scroll').click();
    await cursorAligned('#nested-target');
    assert.equal(await page.evaluate(() => window.nestedClicks), 0);
    await page.locator('#nested-target').click();
    assert.equal(await page.evaluate(() => window.nestedClicks), 1);
    await assertCleared();
  });
  await test('Modal guidance waits for the opener click, then the confirmation click', async () => {
    await recordGuidanceTargets();
    await page.evaluate(() => {
      window.modalActivation = [];
      for (const id of ['open-dialog', 'dialog-target']) {
        document.getElementById(id).addEventListener('click', event => window.modalActivation.push({ id, trusted: event.isTrusted }));
      }
    });
    await page.locator('#show-modal').click();
    await cursorAligned('#open-dialog');
    assert.equal(await page.locator('#dialog').evaluate(dialog => dialog.open), false, 'Starting guidance must not open the modal');
    assert.deepEqual(await page.evaluate(() => window.modalActivation), []);
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['open-dialog']);
    await page.locator('#open-dialog').click();
    await cursorAligned('#dialog-target');
    assert.equal(await page.locator('#dialog').evaluate(dialog => dialog.open), true);
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['open-dialog', 'dialog-target']);
    assert.deepEqual(await page.evaluate(() => window.modalActivation), [{ id: 'open-dialog', trusted: true }]);
    await page.locator('#dialog-target').click();
    assert.deepEqual(await page.evaluate(() => window.modalActivation), [
      { id: 'open-dialog', trusted: true }, { id: 'dialog-target', trusted: true },
    ]);
    await assertCleared();
  });
  await test('Same-page chain advances once per correct click and ignores wrong and double clicks', async () => {
    await recordGuidanceTargets();
    await page.locator('#show-chain').click();
    await cursorAligned('#wrong-target');
    await page.locator('#target').click();
    await aligned('#wrong-target');
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['wrong-target']);
    await page.locator('#wrong-target').dblclick();
    await cursorAligned('#menu-toggle');
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['wrong-target', 'menu-toggle']);
    assert.equal(await page.locator('#menu').evaluate(menu => menu.hidden), true);
    await page.locator('#menu-toggle').click();
    await cursorAligned('#menu-target');
    assert.equal(await page.locator('#menu').evaluate(menu => menu.hidden), false);
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['wrong-target', 'menu-toggle', 'menu-target']);
    await page.locator('#menu-target').click();
    await assertCleared();
    assert.equal(new URL(page.url()).search, '', 'The entire chain must stay on its original page');
  });
  await test('Restarting guidance prevents an earlier chain from advancing', async () => {
    await recordGuidanceTargets();
    await page.locator('#show-chain').click();
    await cursorAligned('#wrong-target');
    await page.locator('#wrong-target').click();
    await cursorAligned('#menu-toggle');
    await page.locator('#show-guidance').click();
    await cursorAligned('#target');
    await page.locator('#menu-toggle').click();
    await aligned('#target');
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['wrong-target', 'menu-toggle', 'target']);
    await page.locator('#target').click();
    await assertCleared();
  });
  await test('Clearing a chain removes its pending click listener and cannot resurrect the next step', async () => {
    await recordGuidanceTargets();
    await page.locator('#show-chain').click();
    await cursorAligned('#wrong-target');
    await page.locator('#clear-paint').click();
    await assertCleared();
    await page.locator('#wrong-target').click();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['wrong-target']);
    await assertCleared();
  });
  await test('Synchronous adapter or step-hook cancellation cannot repaint a stale guide', async () => {
    const result = await page.evaluate(async () => {
      const { createGuidance } = await import('../extension/src/paint/guidance.js');
      const outcomes = [];
      for (const trigger of ['activation', 'step']) {
        let calls = 0;
        let guide;
        guide = createGuidance({
          paint: { ...__PAINT, spotlight: async element => { calls++; await __PAINT.spotlight(element); } },
          resolve: () => document.querySelector('#target'),
          waitForActivation: ({ signal }) => {
            if (trigger === 'activation') { guide.cancel(); return Promise.resolve(); }
            return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
          },
          onStep: () => { if (trigger === 'step') guide.cancel(); },
        });
        const status = await guide.start([{ target: 'test' }]);
        outcomes.push({ calls, status });
        guide.destroy();
      }
      return outcomes;
    });
    assert.deepEqual(result, [{ calls: 0, status: 'cancelled' }, { calls: 0, status: 'cancelled' }]);
    await assertCleared();
  });
  await test('Clear cancels an active scroll, settles its promise and prevents stale harness continuation', async () => {
    await page.evaluate(() => {
      window.cancelledGuidance = { settled: false, cursorCalls: 0 };
      const spotlight = __PAINT.spotlight;
      const moveCursor = __PAINT.moveCursor;
      __PAINT.spotlight = async box => { await spotlight(box); window.cancelledGuidance.settled = true; };
      __PAINT.moveCursor = async box => { window.cancelledGuidance.cursorCalls++; await moveCursor(box); };
    });
    await page.locator('#show-scroll').click();
    await page.waitForFunction(() => document.querySelector('#scrollbox').scrollTop > 0 && !window.cancelledGuidance.settled);
    await page.locator('#clear-paint').click();
    await page.waitForFunction(() => window.cancelledGuidance.settled);
    const stoppedAt = await page.evaluate(() => document.querySelector('#scrollbox').scrollTop);
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => {
      const root = document.querySelector('[data-browser-teacher-paint]').shadowRoot;
      return { scrollTop: document.querySelector('#scrollbox').scrollTop, cursorCalls: window.cancelledGuidance.cursorCalls,
        spotHidden: root.querySelector('.spot').hidden, scrimHidden: root.querySelector('.scrim').hidden,
        cursorHidden: root.querySelector('.cursor').hidden, pending: pendingPaintFrames.size };
    });
    assert.ok(Math.abs(result.scrollTop - stoppedAt) < 1, 'Clear must stop the scroll at its current position');
    assert.equal(result.cursorCalls, 0, 'A cancelled harness request must not resume cursor guidance');
    assert.equal(result.spotHidden, true); assert.equal(result.scrimHidden, true);
    assert.equal(result.cursorHidden, true); assert.equal(result.pending, 0);
  });
  await test('Replacing an active offscreen scroll keeps only the latest spotlight', async () => {
    await page.evaluate(() => {
      window.firstScrollSettled = false;
      window.firstScroll = __PAINT.spotlight(document.querySelector('#offscreen-target')).then(() => { window.firstScrollSettled = true; });
    });
    await page.waitForFunction(() => window.scrollY > 0 && !window.firstScrollSettled);
    await page.evaluate(async () => {
      await __PAINT.spotlight(document.querySelector('#fixed-target'));
      await window.firstScroll;
    });
    const stoppedAt = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(200);
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - stoppedAt) < 1);
    await aligned('#fixed-target');
    await page.evaluate(() => __PAINT.clear());
    assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
  });
  await test('Hidden menus return, removed/replaced elements require a new handoff', async () => {
    await page.evaluate(async () => {
      document.querySelector('#menu').hidden = false;
      await __PAINT.spotlight(document.querySelector('#menu-target'));
      document.querySelector('#menu').hidden = true;
    });
    await page.waitForTimeout(50); assert.equal(await hidden(), true);
    await page.evaluate(() => document.querySelector('#menu').hidden = false); await aligned('#menu-target');
    await page.evaluate(() => { const old = document.querySelector('#menu-target'); old.replaceWith(old.cloneNode(true)); });
    await page.waitForTimeout(60); assert.equal(await hidden(), true);
    assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#menu-target'))); await aligned('#menu-target');
  });
  await test('Invisible ancestors, zero size, SVG and shadow-root elements', async () => {
    await page.evaluate(async () => {
      const target = document.querySelector('#target');
      await __PAINT.spotlight(target); target.parentElement.style.opacity = '0';
    });
    await page.waitForTimeout(50); assert.equal(await hidden(), true);
    await page.evaluate(() => document.querySelector('#target').parentElement.style.opacity = '1'); await aligned('#target');
    await page.evaluate(() => __PAINT.spotlight({ top: 10, left: 10, width: 0, height: 10 })); assert.equal(await hidden(), true);
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#svg-target'))); await aligned('#svg-target');
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#shadow-target-host').shadowRoot.querySelector('button')));
    assert.equal(await hidden(), false);
  });
  await test('Static controls inside fixed or absolute wrappers escape intermediate overflow clipping', async () => {
    const results = await page.evaluate(async () => {
      const { readRect } = await import('../extension/src/paint/geometry.js');
      const results = [];
      for (const position of ['fixed', 'absolute']) {
        const fixture = document.createElement('div');
        fixture.style.cssText = 'position:fixed;left:30px;top:30px;width:300px;height:160px;z-index:100;';
        const clip = document.createElement('div');
        clip.style.cssText = 'position:static;width:40px;height:40px;overflow:hidden;';
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `position:${position};left:130px;top:30px;width:90px;height:30px;`;
        const button = document.createElement('button');
        button.textContent = 'Escape';
        button.style.cssText = 'position:static;display:block;width:90px;height:30px;margin:0;padding:0;border:0;';
        wrapper.append(button); clip.append(wrapper); fixture.append(clip); document.body.append(fixture);
        try {
          const raw = button.getBoundingClientRect();
          const hit = document.elementFromPoint(raw.left + raw.width / 2, raw.top + raw.height / 2);
          results.push({ position, rect: readRect(button), hitTarget: hit === button || button.contains(hit),
            outsideClip: raw.left >= clip.getBoundingClientRect().right });
        } finally { fixture.remove(); }
      }
      return results;
    });
    for (const result of results) {
      assert.equal(result.outsideClip, true, `${result.position}: fixture must be outside its static overflow ancestor`);
      assert.equal(result.hitTarget, true, `${result.position}: the browser must actually render the escaped control`);
      assert.ok(result.rect && result.rect.width > 0 && result.rect.height > 0, `${result.position}: paint must preserve the visible control`);
    }
  });
  await test('Paint containment clips an absolute target even with visible overflow', async () => {
    const result = await page.evaluate(async () => {
      const { readRect } = await import('../extension/src/paint/geometry.js');
      const fixture = document.createElement('div');
      fixture.style.cssText = 'position:fixed;left:30px;top:30px;width:300px;height:160px;z-index:100;';
      const clip = document.createElement('div');
      clip.style.cssText = 'position:static;width:40px;height:40px;contain:paint;overflow:visible;';
      const button = document.createElement('button');
      button.textContent = 'Clipped';
      button.style.cssText = 'position:absolute;left:100px;top:0;width:90px;height:30px;margin:0;padding:0;border:0;';
      clip.append(button); fixture.append(clip); document.body.append(fixture);
      try {
        const raw = button.getBoundingClientRect();
        const hit = document.elementFromPoint(raw.left + raw.width / 2, raw.top + raw.height / 2);
        return { rect: readRect(button), hitTarget: hit === button || button.contains(hit),
          positiveSizeInViewport: raw.width > 0 && raw.height > 0 && raw.left >= 0 && raw.right < innerWidth && raw.top >= 0 && raw.bottom < innerHeight,
          outsideClip: raw.left >= clip.getBoundingClientRect().right };
      } finally { fixture.remove(); }
    });
    assert.equal(result.positiveSizeInViewport, true); assert.equal(result.outsideClip, true);
    assert.equal(result.hitTarget, false, 'Browser hit testing must confirm paint containment hides the target');
    assert.equal(result.rect, null);
  });
  await test('Will-change transform establishes clipping for a fixed descendant', async () => {
    const result = await page.evaluate(async () => {
      const { readRect } = await import('../extension/src/paint/geometry.js');
      const fixture = document.createElement('div');
      fixture.style.cssText = 'position:fixed;left:30px;top:30px;width:300px;height:160px;z-index:100;';
      const clip = document.createElement('div');
      clip.style.cssText = 'position:static;width:40px;height:40px;overflow:hidden;will-change:transform;';
      const button = document.createElement('button');
      button.textContent = 'Clipped';
      button.style.cssText = 'position:fixed;left:100px;top:0;width:90px;height:30px;margin:0;padding:0;border:0;';
      clip.append(button); fixture.append(clip); document.body.append(fixture);
      try {
        const raw = button.getBoundingClientRect();
        const hit = document.elementFromPoint(raw.left + raw.width / 2, raw.top + raw.height / 2);
        return { rect: readRect(button), hitTarget: hit === button || button.contains(hit),
          positiveSizeInViewport: raw.width > 0 && raw.height > 0 && raw.left >= 0 && raw.right < innerWidth && raw.top >= 0 && raw.bottom < innerHeight,
          outsideClip: raw.left >= clip.getBoundingClientRect().right };
      } finally { fixture.remove(); }
    });
    assert.equal(result.positiveSizeInViewport, true); assert.equal(result.outsideClip, true);
    assert.equal(result.hitTarget, false, 'Browser hit testing must confirm the fixed target is clipped');
    assert.equal(result.rect, null);
  });
  await test('Initial offscreen scroll and fixed-position targets', async () => {
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#offscreen-target'))); await aligned('#offscreen-target');
    assert.ok(await page.evaluate(() => window.scrollY > 400));
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#fixed-target'))); await aligned('#fixed-target');
    await page.evaluate(() => window.scrollTo(0, 0)); await aligned('#fixed-target');
  });
  await test('Latest spotlight wins and clear settles interrupted work', async () => {
    const result = await page.evaluate(async () => {
      await __PAINT.spotlight(document.querySelector('#target'));
      const first = __PAINT.spotlight(document.querySelector('#wrong-target'));
      const second = __PAINT.spotlight(document.querySelector('#fixed-target'));
      __PAINT.clear(); __PAINT.clear();
      await Promise.all([first, second]);
      return pendingPaintFrames.size;
    });
    assert.equal(result, 0); assert.equal(await hidden(), true);
  });
  await test('Cursor interruption and persistent solo visibility', async () => {
    await page.evaluate(async () => {
      const one = __PAINT.moveCursor(document.querySelector('#target'));
      const two = __PAINT.moveCursor(document.querySelector('#wrong-target'));
      __PAINT.setCursorVisible(false);
      await Promise.all([one, two]);
      await __PAINT.moveCursor(document.querySelector('#target'));
      await __PAINT.clickCursor();
    });
    assert.equal(await page.evaluate(() => document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.cursor').hidden), true);
    assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
    assert.equal(await page.evaluate(() => publishClicks), 0);
  });
  await test('A ghost with no observed pointer starts at its destination instead of an invented origin', async () => {
    const result = await page.evaluate(async () => {
      const target = document.querySelector('#target');
      const rect = target.getBoundingClientRect();
      const movement = __PAINT.moveCursor(target);
      const cursor = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.cursor');
      const transform = new DOMMatrix(getComputedStyle(cursor).transform);
      const origin = { x: transform.m41, y: transform.m42 };
      await movement;
      return { origin, destination: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
    });
    // Computed transform serialization rounds fractional CSS pixels.
    assert.ok(Math.abs(result.origin.x - result.destination.x) < 0.01);
    assert.ok(Math.abs(result.origin.y - result.destination.y) < 0.01);
    await cursorAligned('#target');
    await page.evaluate(() => __PAINT.clear());
    await assertCleared();
  });
  await test('Every ghost movement starts at the actual pointer, including after an earlier ghost movement', async () => {
    const startAt = async (pointer, selector) => {
      await page.mouse.move(pointer.x, pointer.y);
      return page.evaluate(selector => {
        window.cursorMovement = __PAINT.moveCursor(document.querySelector(selector));
        const cursor = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.cursor');
        const matrix = new DOMMatrix(getComputedStyle(cursor).transform);
        return { x: matrix.m41, y: matrix.m42 };
      }, selector);
    };
    const first = { x: 173, y: 137 };
    assert.deepEqual(await startAt(first, '#target'), first);
    await page.evaluate(() => window.cursorMovement);
    await cursorAligned('#target');
    const second = { x: 1091, y: 153 };
    assert.deepEqual(await startAt(second, '#wrong-target'), second, 'The previous ghost endpoint must not become the next origin');
    await page.evaluate(() => window.cursorMovement);
    await cursorAligned('#wrong-target');
    await page.evaluate(() => __PAINT.clear());
    await assertCleared();
  });
  await test('Trusted pointer coordinates survive host teardown and ignore synthetic pointer events', async () => {
    await page.mouse.move(263, 149);
    const result = await page.evaluate(async () => {
      const { unmountHost } = await import('../extension/src/paint/host.js');
      __PAINT.init(); unmountHost();
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 999, clientY: 777, bubbles: true, pointerType: 'mouse' }));
      const movement = __PAINT.moveCursor(document.querySelector('#target'));
      const cursor = document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.cursor');
      const matrix = new DOMMatrix(getComputedStyle(cursor).transform);
      const origin = { x: matrix.m41, y: matrix.m42 };
      await movement;
      return origin;
    });
    assert.deepEqual(result, { x: 263, y: 149 });
    await cursorAligned('#target');
  });
  await test('The resting ghost cursor follows its target, hides offscreen and stops after cleanup', async () => {
    await page.evaluate(async () => {
      const target = document.querySelector('#nested-target');
      await __PAINT.spotlight(target); await __PAINT.moveCursor(target);
    });
    await cursorAligned('#nested-target');
    await page.evaluate(() => { document.querySelector('#nested-target').style.marginLeft = '45px'; });
    await cursorAligned('#nested-target');
    await page.evaluate(() => { document.querySelector('#scrollbox').scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.cursor').hidden);
    await assertOffscreenDim();
    await page.evaluate(() => { document.querySelector('#scrollbox').scrollTop = 190; });
    await cursorAligned('#nested-target');
    await page.evaluate(() => { __PAINT.clear(); __PAINT.setCursorVisible(false); });
    assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
  });
  await test('Feedback resets and does not accumulate nodes', async () => {
    await page.evaluate(async () => {
      await __PAINT.spotlight(document.querySelector('#target'));
      __PAINT.flashCorrect(); __PAINT.flashWrong(document.querySelector('#wrong-target'));
    });
    assert.equal(await page.evaluate(() => document.querySelector('[data-browser-teacher-paint]').shadowRoot.querySelector('.spot').style.outlineColor), 'rgb(52, 168, 83)');
    await page.waitForTimeout(650);
    const result = await page.evaluate(() => {
      const root = document.querySelector('[data-browser-teacher-paint]').shadowRoot;
      return { color: root.querySelector('.spot').style.outlineColor, hidden: root.querySelector('.feedback').hidden, nodes: root.querySelectorAll('.feedback').length };
    });
    assert.deepEqual(result, { color: 'rgb(79, 156, 249)', hidden: true, nodes: 1 });
    await page.evaluate(() => __PAINT.clear()); assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
  });
  await test('Reduced motion and promise return types', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const result = await page.evaluate(async () => {
      const start = performance.now();
      const values = [await __PAINT.spotlight(document.querySelector('#target')), await __PAINT.moveCursor(document.querySelector('#target')), await __PAINT.clickCursor()];
      return { ms: performance.now() - start, voidResults: values.every(value => value === undefined) };
    });
    assert.ok(result.ms < 150); assert.equal(result.voidResults, true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await test('Reduced-motion offscreen guidance reaches its target without animated scrolling', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const result = await page.evaluate(async () => {
      const startedAt = performance.now();
      const values = [await __PAINT.spotlight(document.querySelector('#offscreen-target')),
        await __PAINT.moveCursor(document.querySelector('#offscreen-target'))];
      const resolvedAt = performance.now() - startedAt;
      const scrollYAtResolve = window.scrollY;
      await new Promise(resolve => setTimeout(resolve, 80));
      return { resolvedAt, scrollYAtResolve, scrollYAfter: window.scrollY, voidResults: values.every(value => value === undefined) };
    });
    assert.ok(result.resolvedAt < 150, `Reduced-motion guidance took ${result.resolvedAt}ms`);
    assert.ok(result.scrollYAtResolve > 400);
    assert.equal(result.scrollYAfter, result.scrollYAtResolve);
    assert.equal(result.voidResults, true);
    await aligned('#offscreen-target'); await cursorAligned('#offscreen-target');
    await page.evaluate(() => { __PAINT.clear(); __PAINT.setCursorVisible(false); });
    assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
  });
  await test('Validation and explicit foreign-frame boundary', async () => {
    const messages = await page.evaluate(async () => {
      const frame = document.createElement('iframe'); document.body.append(frame);
      const cases = [null, { top: NaN, left: 0, width: 10, height: 10 }, { top: 0, left: 0, width: -1, height: 10 }, frame.contentDocument.body];
      const messages = [];
      for (const box of cases) { try { await __PAINT.spotlight(box); } catch (error) { messages.push(error.message); } }
      return messages;
    });
    assert.equal(messages.length, 4); assert.match(messages[3], /this document/);
  });
  await test('Host teardown, pending promises and remount', async () => {
    const result = await page.evaluate(async () => {
      const { unmountHost } = await import('../extension/src/paint/host.js');
      await __PAINT.spotlight(document.querySelector('#target'));
      const movement = __PAINT.moveCursor(document.querySelector('#target'));
      __PAINT.flashWrong(document.querySelector('#wrong-target'));
      unmountHost(); await movement;
      const pending = pendingPaintFrames.size;
      __PAINT.init();
      await __PAINT.spotlight(document.querySelector('#target'));
      return { pending, hosts: document.querySelectorAll('[data-browser-teacher-paint]').length };
    });
    assert.deepEqual(result, { pending: 0, hosts: 1 }); await aligned('#target');
  });
  await test('Host removal by the page recovers on the next call', async () => {
    await page.evaluate(async () => {
      await __PAINT.spotlight(document.querySelector('#target'));
      document.querySelector('[data-browser-teacher-paint]').remove();
    });
    await page.waitForTimeout(60); assert.equal(await page.evaluate(() => pendingPaintFrames.size), 0);
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#target'))); await aligned('#target');
  });
  await test('SPA navigation during scrolling cancels pending guidance and prevents stale continuation', async () => {
    await page.evaluate(() => {
      window.routeGuidance = { settled: false, cursorCalls: 0 };
      const spotlight = __PAINT.spotlight;
      const moveCursor = __PAINT.moveCursor;
      __PAINT.spotlight = async box => { await spotlight(box); window.routeGuidance.settled = true; };
      __PAINT.moveCursor = async box => { window.routeGuidance.cursorCalls++; await moveCursor(box); };
    });
    await page.locator('#show-scroll').click();
    await page.waitForFunction(() => document.querySelector('#scrollbox').scrollTop > 0 && !window.routeGuidance.settled);
    await page.evaluate(() => history.pushState({}, '', '?route=next'));
    await page.waitForFunction(() => window.routeGuidance.settled);
    await assertCleared();
    const stoppedAt = await page.locator('#scrollbox').evaluate(container => container.scrollTop);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.routeGuidance.cursorCalls), 0);
    assert.ok(Math.abs(await page.locator('#scrollbox').evaluate(container => container.scrollTop) - stoppedAt) < 1);
    await page.locator('#nested-target').click();
    await assertCleared();
  });
  await test('SPA navigation cancels the pending chain before old targets can advance it', async () => {
    await recordGuidanceTargets();
    await page.locator('#show-chain').click();
    await cursorAligned('#wrong-target');
    await page.evaluate(() => history.pushState({}, '', '?route=next'));
    await assertCleared();
    await page.locator('#wrong-target').click();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['wrong-target']);
    await assertCleared();
  });
  await test('Pagehide clears and cancels guidance retained by a document lifecycle transition', async () => {
    await recordGuidanceTargets();
    await page.locator('#show-chain').click();
    await cursorAligned('#wrong-target');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await assertCleared();
    await page.locator('#wrong-target').click();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.guidanceTargets), ['wrong-target']);
    await assertCleared();
  });
  await test('A real redirect clears the departing guidance and starts the next document without effects', async () => {
    await page.locator('#show-redirect').click();
    await cursorAligned('#redirect-target');
    await Promise.all([
      page.waitForURL(`${url}?destination=1`),
      page.locator('#redirect-target').click(),
    ]);
    await page.waitForFunction(() => window.paintReady);
    await assertCleared();
    assert.equal(await page.locator('#dialog').evaluate(dialog => dialog.open), false);
  });
  await test('Host styling survives aggressive website CSS and transformed body', async () => {
    await page.addStyleTag({ content: 'body {transform:translateX(12px)} div {box-sizing:content-box; border:7px solid orange; font-size:42px; pointer-events:auto} [data-browser-teacher-paint] {display:none !important; padding:80px !important; opacity:.2 !important; transform:scale(.8) !important}' });
    await page.evaluate(() => __PAINT.spotlight(document.querySelector('#target'))); await aligned('#target');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-browser-teacher-paint]')).opacity), '1');
  });
  await test('A later modal can be highlighted without blur or click interception', async () => {
    await page.locator('#open-dialog').click();
    await page.evaluate(async () => {
      window.paintBlurCount = 0;
      document.querySelector('#dialog-target').addEventListener('blur', () => window.paintBlurCount++);
      await __PAINT.spotlight(document.querySelector('#dialog-target'));
      await __PAINT.moveCursor(document.querySelector('#dialog-target'));
      window.modalClicks = 0;
      document.querySelector('#dialog-target').addEventListener('click', () => window.modalClicks++);
    });
    await aligned('#dialog-target');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dialog-target');
    assert.equal(await page.evaluate(() => window.paintBlurCount), 0);
    // A screenshot proves the ring is visible above the dialog, not merely aligned behind it.
    await page.screenshot({ path: path.join(artifacts, 'paint-modal.png') });
    const box = await page.locator('#dialog-target').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.evaluate(() => window.modalClicks), 1);
  });
  await test('Static ownership boundaries and no real click dispatch', async () => {
    const files = await fs.readdir(path.join(root, 'extension/src/paint'));
    for (const name of files.filter(name => name.endsWith('.js'))) {
      const source = await fs.readFile(path.join(root, 'extension/src/paint', name), 'utf8');
      assert.doesNotMatch(source, /from\s+['"][^'"]*(resolve|panel)\//);
      assert.doesNotMatch(source, /docs\.google|__RESOLVE|\.dispatchEvent\(|\.click\(/);
    }
  });
  await test('Second website presentation needs no paint changes', async () => {
    await page.evaluate(async () => { document.body.classList.add('shop'); await __PAINT.spotlight(document.querySelector('#target')); });
    await aligned('#target');
    await page.locator('#target').click(); assert.equal(await page.evaluate(() => publishClicks), 1);
  });
  await test('Contract 4 composition with an A-shaped resolver double', async () => {
    await page.evaluate(() => {
      const target = { scope: 'any', name: 'Publish' };
      const R = {
        find: async t => [...document.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label') === t.name) || null,
        waitForClick: t => new Promise(resolve => document.addEventListener('click', async function handler(event) {
          document.removeEventListener('click', handler, true);
          const el = await R.find(t); resolve(el?.contains(event.target) ? 'correct' : { wrong: event.target.textContent.trim() });
        }, true)),
        verify: async () => window.publishClicks > 0,
      };
      window.integrationTeach = {
        async highlight(t) { const el = await R.find(t); if (!el) return false; await __PAINT.spotlight(el); return true; },
        waitForClick: t => R.waitForClick(t), verify: v => R.verify(v), clear: () => __PAINT.clear(),
        async demo(t) { const el = await R.find(t); if (!el) return; await __PAINT.spotlight(el); await __PAINT.moveCursor(el); await __PAINT.clickCursor(); el.click(); },
      };
      window.integrationTarget = target;
    });
    assert.equal(await page.evaluate(() => integrationTeach.highlight(integrationTarget)), true);
    assert.equal(await page.evaluate(() => integrationTeach.highlight({ name: 'Missing' })), false);
    await page.evaluate(() => { window.clickResult = integrationTeach.waitForClick(integrationTarget); });
    await page.locator('#target').click();
    assert.equal(await page.evaluate(() => clickResult), 'correct');
    assert.equal(await page.evaluate(() => integrationTeach.verify({ kind: 'none' })), true);
    await page.evaluate(() => integrationTeach.demo(integrationTarget));
    assert.equal(await page.evaluate(() => publishClicks), 2);
    await page.evaluate(() => integrationTeach.clear()); assert.equal(await hidden(), true);
  });

  await reset();
  await page.locator('#show-guidance').click();
  await page.waitForTimeout(750);
  await page.screenshot({ path: path.join(artifacts, 'paint-workshop.png') });
  assert.deepEqual(errors, [], 'Browser page errors');
  const report = `# Paint browser test results\n\nRun: ${new Date().toISOString()}\n\nBrowser: ${await browser.version()} (headless Chrome), 1440x900; responsive check at 820x700.\n\n${results.filter(r => r.passed).length}/${results.length} checks passed. Page errors: ${errors.length}.\n\n` + results.map(r => `- ${r.passed ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` — ${r.error}` : ''}`).join('\n') + '\n\nThese checks load the real paint ES modules. Resolver composition uses a test double; live Google Docs and the complete extension were not tested. The screenshot is saved to `docs/.paint-artifacts/paint-workshop.png`.\n';
  await fs.writeFile(path.join(__dirname, 'paint-test-results.md'), report);
  console.log(`\n${results.filter(r => r.passed).length}/${results.length} checks passed. Screenshot: ${path.join(artifacts, 'paint-workshop.png')}`);
  if (results.some(r => !r.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.close();
});
