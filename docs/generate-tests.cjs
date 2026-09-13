// Runtime lesson generation, in the real loaded extension.
// Run with Playwright on NODE_PATH: node docs/generate-tests.cjs
//
// Covers the path the panel takes when semantic search finds nothing: offer to
// generate, stream the agent's trail, run the lesson that comes back, and make
// the result searchable so the same question never pays for a second cloud run.
//
// The bridge here is a local stand-in on the same port and contract as
// pipeline/bridge.js. It is stubbed because the real one drives a cloud browser
// for minutes and costs money; everything on the extension side of the boundary
// — panel, matcher, index, teaching adapter, paint — is the real implementation.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, '.paint-artifacts');
const extensionPath = path.join(root, 'extension');
const BRIDGE_PORT = 7777;   // generate.js targets this; the real bridge must be stopped

const results = [];
const runtimeErrors = [];
let context;
let browserVersion = 'not launched';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------ fixture server */

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

/* --------------------------------------------------------------- fake bridge */

// A lesson that targets the real fixture's real controls, so the run that
// follows generation is a genuine teaching run, not a rendering of JSON.
const GENERATED = {
  id: 'schedule-a-post',
  app: 'fixture',
  goal: 'schedule a post for later',
  preamble: 'Scheduling is publishing with a delay attached, so it lives behind the same menu as the other publish options.',
  generalization: 'Anything that acts on the whole document tends to live in one menu rather than on the toolbar.',
  steps: [
    {
      id: 's1', mode: 'guided', action: 'click',
      target: { name: 'Options' },
      verify: { kind: 'visible', name: 'Schedule publication', scope: 'menu' },
      intent: 'Open the Options menu — the scheduling controls live inside it.',
      hints: ['It is grouped with the other document-wide actions.', 'The button labelled Options.'],
      wrongHints: {},
    },
    {
      id: 's2', mode: 'guided', action: 'click',
      target: { name: 'Schedule publication' },
      verify: { kind: 'none' },
      intent: 'Choose Schedule publication to set it for later rather than now.',
      hints: ['You want the option that delays rather than publishes.', 'Schedule publication, in the open menu.'],
      wrongHints: {},
    },
  ],
};

const bridgeState = { generateCalls: [], mode: 'ok', delayMs: 60 };

const bridge = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${BRIDGE_PORT}`);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') { response.writeHead(204, cors).end(); return; }

  if (url.pathname === '/health') {
    if (bridgeState.mode === 'down') { response.destroy(); return; }
    response.writeHead(200, cors).end(JSON.stringify({ ok: true, busy: false }));
    return;
  }

  if (url.pathname === '/generate') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    bridgeState.generateCalls.push(JSON.parse(raw || '{}'));
    bridgeState.startedAt = Date.now();
    response.writeHead(202, cors).end(JSON.stringify({ jobId: 'j_test' }));
    return;
  }

  if (url.pathname === '/jobs/j_test') {
    const elapsed = Date.now() - (bridgeState.startedAt || 0);
    const progress = [
      { at: 1, text: 'Opening a cloud browser…' },
      { at: 2, text: 'Tried "Options" — the scheduling controls are usually in a menu.' },
    ];
    if (bridgeState.mode === 'error') {
      response.writeHead(200, cors).end(JSON.stringify({ state: 'error', progress, error: 'I explored but could not find a reliable way to do that.' }));
      return;
    }
    const done = elapsed > bridgeState.delayMs;
    response.writeHead(200, cors).end(JSON.stringify(
      done ? { state: 'done', progress, lesson: GENERATED } : { state: 'running', progress },
    ));
    return;
  }

  response.writeHead(404, cors).end(JSON.stringify({ error: 'not found' }));
});

/* -------------------------------------------------------------------- report */

async function report() {
  const passed = results.filter(r => r.passed).length;
  const lines = [
    '# Runtime lesson generation results', '',
    `Run: ${new Date().toISOString()}`, '',
    `Browser: ${browserVersion}`, '',
    `Result: **${passed}/${results.length} checks passed**.`, '',
    'The real extension is loaded from its manifest. The panel, matcher, lesson index, teaching adapter and paint are the production implementations. Only the authoring bridge is stubbed: the real one at `pipeline/bridge.js` drives a cloud browser for minutes per lesson. The stub serves the same routes on the same port.', '',
    ...results.map(r => `- ${r.passed ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` — ${r.error.replace(/\n/g, ' ')}` : ''}`), '',
    `Uncaught page or extension console errors: ${runtimeErrors.length}.`,
    ...runtimeErrors.map(e => `- ${e.replace(/\n/g, ' ')}`), '',
    'Not covered here: the real bridge end to end against Google Docs, which needs Steel credentials and is verified by hand. See `pipeline/bridge.js`.', '',
  ];
  await fs.writeFile(path.join(__dirname, 'generate-test-results.md'), lines.join('\n'));
}

/* ---------------------------------------------------------------------- main */

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => {
    bridge.once('error', err => reject(new Error(
      err.code === 'EADDRINUSE'
        ? `port ${BRIDGE_PORT} is busy — stop the real bridge (npm run bridge) before running these tests`
        : err.message,
    )));
    bridge.listen(BRIDGE_PORT, '127.0.0.1', resolve);
  });

  const url = `http://127.0.0.1:${server.address().port}/docs/extension-fixture.html`;
  const profile = await fs.mkdtemp(path.join(artifacts, 'generate-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1440, height: 900 },
  });
  browserVersion = context.browser()?.version() || 'Chromium persistent context';

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => runtimeErrors.push(`Page: ${e.message}`));

  const panel = () => page.locator('#browser-teacher-root');
  const actionLabels = async () =>
    panel().locator('.bt-actions .bt-btn').allTextContents();

  async function ask(question) {
    const input = panel().locator('.bt-bar input, .bt-bar textarea').first();
    await input.fill(question);
    await input.press('Enter');
  }

  /** Every lesson opens on its preamble and waits. Step one is behind "Show me". */
  async function showMe({ timeout = 8000 } = {}) {
    await panel().locator('.bt-card-preamble').waitFor({ timeout });
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Show me' }).click();
    await panel().locator('.bt-card-step').waitFor({ timeout });
  }

  async function reset() {
    bridgeState.generateCalls = [];
    bridgeState.mode = 'ok';
    bridgeState.delayMs = 60;
    await page.goto(url);
    await panel().locator('.bt-bar').waitFor();
    await pause(250);   // let the module graph settle before typing
  }

  async function test(name, run) {
    try {
      await reset();
      await run();
      results.push({ name, passed: true });
      console.log(`PASS ${name}`);
    } catch (err) {
      results.push({ name, passed: false, error: err.message });
      console.log(`FAIL ${name} — ${err.message}`);
    }
  }

  await test('An unmatched question offers to generate when a bridge is reachable', async () => {
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    const labels = await actionLabels();
    assert.ok(labels.includes('Work it out for me'), `expected a generate button, got ${JSON.stringify(labels)}`);
  });

  await test('A partial match offers its shortlist and puts "None of these" last', async () => {
    await ask('make my text bigger');
    await panel().locator('.bt-card-picker').waitFor();
    const labels = await actionLabels();
    assert.equal(labels.at(-1), 'None of these', `the escape hatch belongs last, got ${JSON.stringify(labels)}`);
    // The shortlist is what the question matched, not the library in order.
    const shipped = JSON.parse(await fs.readFile(path.join(extensionPath, 'lessons', 'index.json'), 'utf8'));
    assert.ok(labels.length - 1 < shipped.length, `expected a shortlist of ${shipped.length}, got ${JSON.stringify(labels)}`);
  });

  await test('"None of these" sends the original question to the cloud browser', async () => {
    await ask('make my text bigger');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'None of these' }).click();
    await panel().locator('.bt-trail li').first().waitFor();
    assert.equal(bridgeState.generateCalls.length, 1);
    assert.equal(bridgeState.generateCalls[0].goal, 'make my text bigger');
  });

  await test('A question matching nothing offers no guesses, only generation', async () => {
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    const labels = await actionLabels();
    assert.deepEqual(labels, ['Work it out for me'], `unmatched questions must not be padded with lessons, got ${JSON.stringify(labels)}`);
  });

  await test('A matched question is offered, and choosing it never contacts the bridge', async () => {
    await ask('how do I add a table of contents');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn:not(.bt-btn-generate)').first().click();
    await panel().locator('.bt-card-preamble').waitFor();
    assert.equal(bridgeState.generateCalls.length, 0, 'a lesson we already have must not reach the bridge');
  });

  await test('With no bridge running the panel degrades to the plain picker', async () => {
    bridgeState.mode = 'down';
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    const labels = await actionLabels();
    assert.ok(!labels.includes('Work it out for me'), `must not offer generation with no bridge, got ${JSON.stringify(labels)}`);
    assert.ok(labels.length > 0, 'the existing lessons must still be offered');
  });

  await test("The agent's trail streams into the panel while it works", async () => {
    bridgeState.delayMs = 2500;
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Work it out for me' }).click();
    await panel().locator('.bt-trail li').first().waitFor();
    const trail = await panel().locator('.bt-trail li').allTextContents();
    assert.ok(trail.some(t => t.includes('cloud browser')), `expected the trail, got ${JSON.stringify(trail)}`);
  });

  await test('The generated lesson is taught as soon as it arrives', async () => {
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Work it out for me' }).click();
    await showMe({ timeout: 15000 });
    const body = await panel().locator('.bt-card-step .bt-card-body').first().textContent();
    assert.match(body, /Options menu/, `expected the generated lesson's first step, got "${body}"`);
    assert.equal(bridgeState.generateCalls.length, 1);
    assert.equal(bridgeState.generateCalls[0].goal, 'how do I schedule a post for later');
  });

  await test('Teaching the generated lesson drives the real page, not a mock', async () => {
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Work it out for me' }).click();
    await showMe({ timeout: 15000 });
    // The real teaching adapter is waiting for a real click on the real control.
    await page.locator('#menu-open').click();
    await panel().locator('.bt-card-step .bt-card-body', { hasText: 'Schedule publication' })
      .waitFor({ timeout: 8000 });
  });

  await test('Asking again is answered from the index without a second cloud run', async () => {
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Work it out for me' }).click();
    await showMe({ timeout: 15000 });
    assert.equal(bridgeState.generateCalls.length, 1);

    // The bar is deliberately disabled while a lesson runs, so end it first.
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Stop' }).click();
    await panel().locator('.bt-bar input:not([disabled])').waitFor();

    // Same session, same question. It is in the live index now, so it comes
    // back as a choice rather than another cloud run.
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor({ timeout: 8000 });
    const labels = await actionLabels();
    assert.ok(labels.includes(GENERATED.goal), `expected the generated lesson on offer, got ${JSON.stringify(labels)}`);
    await panel().locator('.bt-actions .bt-btn', { hasText: GENERATED.goal }).click();
    await panel().locator('.bt-card-preamble').waitFor({ timeout: 8000 });
    assert.equal(bridgeState.generateCalls.length, 1, 'the second ask must be served from the index');
  });

  await test('A failing generation reports the reason instead of hanging', async () => {
    bridgeState.mode = 'error';
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Work it out for me' }).click();
    await panel().locator('.bt-card-error').waitFor({ timeout: 15000 });
    const body = await panel().locator('.bt-card-error .bt-card-body').textContent();
    assert.match(body, /could not find a reliable way/);
  });

  await test('Stop during generation cancels and leaves nothing running', async () => {
    bridgeState.delayMs = 20000;
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Work it out for me' }).click();
    await panel().locator('.bt-trail li').first().waitFor();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Stop' }).click();
    await pause(600);
    assert.equal(await panel().locator('.bt-card-step').count(), 0, 'no lesson may start after Stop');
    assert.equal(await panel().locator('.bt-trail').count(), 0, 'the trail must be cleared');
  });

  const passed = results.filter(r => r.passed).length;
  console.log(`\n${passed}/${results.length} generation checks passed.`);
  if (runtimeErrors.length) console.log(`Runtime errors: ${runtimeErrors.length}`);

  await report();
  await context.close();
  server.close();
  bridge.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch(async err => {
  console.error(err);
  try { await context?.close(); } catch { /* already gone */ }
  server.close();
  bridge.close();
  process.exit(1);
});
