// Runtime lesson generation, in the real loaded extension.
// Run with Playwright on NODE_PATH: node docs/generate-tests.cjs
//
// Covers the path the panel takes when semantic search finds nothing: offer to
// generate, stream the agent's trail, run the lesson that comes back, and make
// the result searchable so the same question never pays for a second cloud run.
//
// The bridge here is an ephemeral local stand-in for pipeline/bridge.js. The
// test loads a disposable extension copy with only its bridge URL replaced;
// the live bridge at port 7777 and all production files remain untouched.
// The bridge is stubbed because the real one drives a cloud browser
// for minutes and costs money; everything on the extension side of the boundary
// — panel, matcher, index, teaching adapter, paint — is the real implementation.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, '.paint-artifacts');
const productionExtension = path.join(root, 'extension');
const testFilter = process.env.GENERATE_TEST_FILTER ? new RegExp(process.env.GENERATE_TEST_FILTER) : null;
const VIEWER_URL = 'https://api.steel.dev/v1/sessions/11111111-1111-4111-8111-111111111111/player';
const RETRY_VIEWER_URL = 'https://api.steel.dev/v1/sessions/22222222-2222-4222-8222-222222222222/player';
const THIRD_VIEWER_URL = 'https://api.steel.dev/v1/sessions/33333333-3333-4333-8333-333333333333/player';
const REPLAY_TOKEN = 'a'.repeat(48);
const RETRY_REPLAY_TOKEN = 'b'.repeat(48);
const HTTPS_FIXTURE = 'https://example.com/browser-teacher-fixture';

const results = [];
const runtimeErrors = [];
const expectedConsoleErrors = [];
let expectedConsolePattern;
let context;
let browserVersion = 'not launched';
let extensionId;
let bridgeUrl;
let sourceBefore;
const viewerRequests = [];
const networkFailures = [];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const reportText = value => String(value).replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------ fixture server */

const server = http.createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/docs/generate-player-fixture.html') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><title>Wrong-origin player fixture</title><p id="wrong-origin">A different origin</p>');
      return;
    }
    const restrictive = pathname === '/docs/generate-csp-fixture.html';
    if (restrictive) pathname = '/docs/extension-fixture.html';
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(file)] || 'text/plain';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
      ...(restrictive ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'" } : {}) });
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

const freshBridgeState = () => ({ generateCalls: [], pollCalls: [], playerCalls: [], playerPollCalls: [],
  mode: 'ok', delayMs: 60, viewer: null, recordings: [], autoViewerReady: true, playerMode: 'ready', liveLoads: {}, livePlaybackPlans: {} });
let bridgeState = freshBridgeState();
const jobs = new Map();
const recordingOwners = new Map();
let nextJob = 0;

const bridge = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') { response.writeHead(204, cors).end(); return; }

  const recordingPath = url.pathname.match(/^\/replays\/([a-f0-9]{48})\/(player|state)$/);
  if (recordingPath) {
    const [, token, kind] = recordingPath;
    const owner = recordingOwners.get(token) || bridgeState;
    if (kind === 'state') {
      owner.playerPollCalls.push(token);
      const state = { mode: owner.playerMode, token };
      if (owner.playerDelayMs) await pause(owner.playerDelayMs);
      response.writeHead(200, cors).end(JSON.stringify(state));
      return;
    }
    owner.playerCalls.push(token);
    response.writeHead(200, { ...cors, 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(`<!doctype html>
      <title>Recording player fixture</title><style>body{margin:0;padding:24px;background:#101a2b;color:white;font:18px system-ui}button{font:inherit;padding:12px}</style>
      <main id="recording-fixture"><h1>Session recording</h1><p id="recording-state">Recording is processing</p><button id="recording-play" hidden>Play recording</button></main>
      <script>
        window.recordingClicks = 0;
        document.querySelector('#recording-play').onclick = () => { window.recordingClicks++; };
        addEventListener('keydown', event => {
          if (event.key === 'Escape' && !document.fullscreenElement) parent.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*');
        });
        async function refresh() {
          const state = await (await fetch('./state')).json();
          document.querySelector('#recording-state').textContent = state.mode === 'ready' ? 'Recording ready: ' + state.token : state.mode === 'error' ? 'Recording temporarily unavailable' : 'Recording is processing';
          document.querySelector('#recording-play').hidden = state.mode !== 'ready';
          setTimeout(refresh, 150);
        }
        refresh();
      </script>`);
    return;
  }

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
    bridgeState.jobId = `j_test_${++nextJob}`;
    jobs.set(bridgeState.jobId, bridgeState);
    response.writeHead(202, cors).end(JSON.stringify({ jobId: bridgeState.jobId }));
    return;
  }

  if (url.pathname.startsWith('/jobs/')) {
    const job = jobs.get(url.pathname.slice('/jobs/'.length));
    if (!job) { response.writeHead(404, cors).end(JSON.stringify({ error: 'no such job' })); return; }
    job.pollCalls.push(Date.now());
    if (job.mode === 'disconnect') { response.destroy(); return; }
    const elapsed = Date.now() - (job.startedAt || 0);
    const progress = [
      { at: 1, text: 'Opening a cloud browser…' },
      { at: 2, text: 'Tried "Options" — the scheduling controls are usually in a menu.' },
    ];
    for (const recording of job.recordings) {
      const token = recording.url?.match(/\/replays\/([a-f0-9]{48})\/player$/)?.[1];
      if (token) recordingOwners.set(token, job);
    }
    const done = elapsed > job.delayMs;
    const payload = JSON.stringify({ id: job.jobId, progress, viewer: job.viewer, recordings: job.recordings,
      ...(job.mode === 'error' ? { state: 'error', error: 'I explored but could not find a reliable way to do that.' }
        : done ? { state: 'done', lesson: GENERATED } : { state: 'running' }) });
    if (job.pollDelayMs) await pause(job.pollDelayMs);
    response.writeHead(200, cors).end(payload);
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
    `Unpacked extension: ${extensionId || 'not detected'}`, '',
    `Result: **${passed}/${results.length} checks passed**.`, '',
    ...(testFilter ? [`Selected checks: \`${process.env.GENERATE_TEST_FILTER}\`.`, ''] : []),
    'The real extension is loaded from its manifest in a disposable copy. Only the bridge base URL is changed to a local server on an operating-system-assigned port. The production extension files and live bridge on port 7777 are untouched. The panel, matcher, lesson index, teaching adapter, paint and viewer are the production implementations. Stub job responses replace cloud authoring; deterministic live-player and recording-player HTML exercise the real iframe lifecycle and controls without paid cloud sessions.', '',
    'For the public HTTPS fixture only, authoring JSON routes (`/health`, `/generate`, `/jobs/...`) are supplied through the test fixture because fresh-browser local-network permissions can block the existing content-script authoring request. Replay iframe navigation and its local player requests remain real network requests through the production extension wrapper. This verifies HTTPS replay access without claiming to verify authoring local-network permission setup.', '',
    ...results.map(r => `- ${r.passed ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` — ${reportText(r.error)}` : ''}`), '',
    `Unexpected page or extension console errors: ${runtimeErrors.length}.`,
    ...runtimeErrors.map(e => `- ${reportText(e)}`), '',
    `Expected negative-path console reports: ${expectedConsoleErrors.length}.`,
    ...expectedConsoleErrors.map(e => `- ${reportText(e.split('\n')[0])}`), '',
    'Scope: this proves the production UI can load live and recorded player iframes under restrictive page CSP, consume job metadata, retain recordings until Done, Stop or a new task, and clean up stale views across lifecycle transitions. Live fixtures model per-session ready, connected/state, autoplay-blocked, error and silent-start signals with real retry timers; they do not perform WebRTC or prove actual video/autoplay recovery. Recording HTML is a deterministic fixture; the backend suite separately checks the actual replay player and authenticated HLS proxy. These checks do not prove live Steel availability, authentication, video encoding, or current framing response headers.', '',
    'Screenshots, temporary extension copies and disposable browser profiles are saved under ignored `docs/.paint-artifacts/`. Run with Playwright on `NODE_PATH` and a Chromium/Chrome for Testing executable in `CHROME_PATH`.', '',
  ];
  await fs.writeFile(testFilter ? path.join(artifacts, 'generate-test-results-filtered.md') : path.join(__dirname, 'generate-test-results.md'), lines.join('\n'));
}

/* ---------------------------------------------------------------------- main */

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(0, '127.0.0.1', resolve);
  });
  bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
  const extensionPath = await fs.mkdtemp(path.join(artifacts, 'generate-extension-'));
  await fs.cp(productionExtension, extensionPath, { recursive: true });
  sourceBefore = await fs.readFile(path.join(productionExtension, 'src/panel/generate.js'), 'utf8');
  const bridgeConstant = /^const BRIDGE = ['"]http:\/\/localhost:7777['"];$/gm;
  assert.equal([...sourceBefore.matchAll(bridgeConstant)].length, 1, 'Only the known bridge constant may be changed in the disposable extension');
  await fs.writeFile(path.join(extensionPath, 'src/panel/generate.js'), sourceBefore.replace(bridgeConstant, `const BRIDGE = '${bridgeUrl}';`));

  const url = `http://127.0.0.1:${server.address().port}/docs/extension-fixture.html`;
  const profile = await fs.mkdtemp(path.join(artifacts, 'generate-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1440, height: 900 },
  });
  browserVersion = context.browser()?.version() || 'Chromium persistent context';
  await context.route(`${bridgeUrl}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    const authoring = pathname === '/health' || pathname === '/generate' || pathname.startsWith('/jobs/');
    const topUrl = route.request().frame().page().url().split(/[?#]/)[0];
    if (!authoring || topUrl !== HTTPS_FIXTURE) { await route.continue(); return; }
    // Keep the authoring service at the existing fixture boundary; do not
    // grant browser network permissions or intercept recording navigation.
    const response = await fetch(route.request().url(), { method: route.request().method(),
      headers: { 'content-type': 'application/json' },
      ...(route.request().postData() ? { body: route.request().postData() } : {}) });
    await route.fulfill({ status: response.status, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' },
      body: await response.text() });
  });
  await context.route('https://example.com/**', async route => {
    if (route.request().url().split(/[?#]/)[0] !== HTTPS_FIXTURE) {
      await route.fulfill({ status: 404, body: 'Fixture route not found' });
      return;
    }
    await route.fulfill({ contentType: 'text/html',
      headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'" },
      body: await fs.readFile(path.join(__dirname, 'extension-fixture.html'), 'utf8') });
  });
  // A real cross-origin iframe navigation with deterministic remote content.
  // No browser/UI methods or extension functions are mocked by this route.
  await context.route('https://api.steel.dev/**', async route => {
    viewerRequests.push(route.request().url());
    const sessionId = new URL(route.request().url()).pathname.match(/\/sessions\/([^/]+)/)?.[1] || 'fixture-session';
    const loadNumber = bridgeState.liveLoads[sessionId] = (bridgeState.liveLoads[sessionId] || 0) + 1;
    const plan = bridgeState.livePlaybackPlans[sessionId];
    const configured = plan?.[Math.min(loadNumber - 1, plan.length - 1)] || (bridgeState.autoViewerReady !== false ? 'ready' : 'manual');
    const playback = typeof configured === 'string' ? { type: configured } : configured;
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Steel viewer fixture</title></head><body style="margin:0;background:#0b1522;color:#fff;font:20px system-ui"><main id="steel-fixture">Cloud browser fixture</main><script>
      window.viewerStateRequests = 0;
      window.fixtureSessionId = ${JSON.stringify(sessionId)};
      window.fixturePlayback = ${JSON.stringify(playback)};
      window.fixtureEmitted = [];
      addEventListener('message', event => {
        if (event.data?.type !== 'steel:get-state') return;
        window.viewerStateRequests++;
        const mode = window.fixturePlayback;
        if (mode.type === 'manual' || mode.type === 'silent') return;
        setTimeout(() => {
          const type = mode.type === 'state-ready' ? 'steel:state' : 'steel:' + mode.type;
          window.fixtureEmitted.push(type);
          parent.postMessage({ type, detail: { state: mode.type, firstFrameDrawn: mode.type === 'ready' || mode.type === 'state-ready', isConnected: mode.type === 'ready' || mode.type === 'state-ready', videoWidth: 1920, videoHeight: 1080, timestamp: Date.now(), sessionId: window.fixtureSessionId } }, '*');
        }, mode.delayMs || 0);
      });
    </script></body></html>` });
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => runtimeErrors.push(`Page: ${e.message}`));
  page.on('requestfailed', request => networkFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  const cdp = await context.newCDPSession(page);
  const contexts = new Map();
  let world;
  cdp.on('Runtime.executionContextCreated', ({ context: created }) => contexts.set(created.id, created));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => { contexts.clear(); world = undefined; });
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type !== 'error') return;
    const description = event.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ');
    if (expectedConsolePattern?.test(description)) { expectedConsoleErrors.push(description); return; }
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
          const value = await evaluate(`typeof __BT_DEV !== 'undefined' && typeof __BT_DEV.runLesson === 'function' && chrome.runtime.id`, id);
          if (value) { world = id; extensionId = value; return; }
        } catch { /* A navigating or initializing context may disappear. */ }
      }
      await pause(70);
    }
    throw new Error('Real manifest extension did not become ready');
  }

  const panel = () => page.locator('#browser-teacher-root');
  const actionLabels = async () =>
    panel().locator('.bt-actions .bt-btn').allTextContents();
  const cloudWindow = () => panel().locator('.bt-cloud-window');
  const cloudFrame = () => panel().locator('.bt-cloud-frame');
  const watch = () => panel().locator('.bt-cloud-watch');
  const history = () => panel().locator('.bt-cloud-history');
  const minimize = () => panel().locator('.bt-cloud-minimize');

  async function until(check, message, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await pause(60);
    }
    throw new Error(message);
  }
  async function startGeneration({ viewer = { status: 'starting', url: null, attempt: 1, phase: 'explore' }, question = 'how do I schedule a post for later' } = {}) {
    bridgeState.delayMs = 120000;
    bridgeState.viewer = viewer;
    await ask(question);
    await panel().locator('.bt-card-picker').waitFor();
    await panel().locator('.bt-actions .bt-btn-generate').click();
    await watch().waitFor();
  }
  function liveViewer(url = VIEWER_URL, attempt = 1) {
    bridgeState.viewer = { status: 'live', url, attempt, phase: 'explore' };
  }
  function playbackPlan(url, ...states) {
    bridgeState.livePlaybackPlans[new URL(url).pathname.match(/\/sessions\/([^/]+)/)[1]] = states;
  }
  function liveLoads(url) { return viewerRequests.filter(request => request.startsWith(url)).length; }
  function replayUrl(token = REPLAY_TOKEN) { return `${bridgeUrl}/replays/${token}/player`; }
  function releaseRecording({ token = REPLAY_TOKEN, sessionId = '11111111-1111-4111-8111-111111111111', attempt = 1, phase = 'explore' } = {}) {
    const recording = { sessionId, attempt, phase, url: replayUrl(token) };
    bridgeState.recordings = [...bridgeState.recordings.filter(item => item.sessionId !== sessionId), recording];
    recordingOwners.set(token, bridgeState);
    bridgeState.viewer = { status: 'closed', url: null, attempt, phase, sessionId };
    return recording;
  }
  async function viewerReady(expected = VIEWER_URL, { playback = true } = {}) {
    await cloudWindow().waitFor();
    await cloudFrame().waitFor();
    await until(() => page.frames().some(frame => frame.url().startsWith(expected)), `Cross-origin viewer did not navigate to ${expected}`);
    let frame = page.frames().find(candidate => candidate.url().startsWith(expected));
    await frame.locator('#steel-fixture').waitFor();
    assert.equal(new URL(frame.url()).searchParams.get('interactive'), 'false', 'Viewer must be watch-only');
    await until(() => frame.evaluate(() => window.viewerStateRequests > 0), 'Extension must request playback state after iframe document load');
    if (playback) await panel().locator('.bt-cloud-message').waitFor({ state: 'hidden' });
    frame = page.frames().find(candidate => candidate.url().startsWith(expected));
    assert.ok(frame, 'Current live frame must still exist after becoming ready');
    return frame;
  }
  async function noViewer(message = 'Viewer must be cleaned up') {
    await until(async () => !(await cloudWindow().isVisible()) && await cloudFrame().count() === 0, message);
    assert.equal(page.frames().some(frame => frame.url().startsWith('https://api.steel.dev/')), false, 'Remote browsing context must be detached');
    assert.equal(page.frames().some(frame => frame.url().startsWith(`${bridgeUrl}/replays/`)), false, 'Recording browsing context must be detached');
  }
  async function recordingReady(token = REPLAY_TOKEN, { state = 'ready' } = {}) {
    await cloudWindow().waitFor();
    await until(() => page.frames().some(frame => frame.url() === replayUrl(token)), 'Recording must load from the trusted bridge');
    const frame = page.frames().find(candidate => candidate.url() === replayUrl(token));
    await frame.locator('#recording-fixture').waitFor();
    await until(async () => (await frame.locator('#recording-state').textContent()).includes(state === 'ready' ? 'Recording ready' : state === 'pending' ? 'processing' : 'unavailable'), `Recording player must report ${state}`);
    await panel().locator('.bt-cloud-message').waitFor({ state: 'hidden' });
    assert.equal(await cloudFrame().getAttribute('title'), 'Steel session recording');
    const wrapperUrl = new URL(await cloudFrame().getAttribute('src'));
    assert.equal(wrapperUrl.protocol, 'chrome-extension:', 'A recording must use the extension-owned wrapper');
    assert.equal(wrapperUrl.hostname, extensionId);
    assert.equal(wrapperUrl.searchParams.get('url'), replayUrl(token));
    assert.equal(frame.parentFrame()?.url(), wrapperUrl.href, 'The bridge player must load inside the actual extension wrapper');
    assert.equal(await cloudFrame().getAttribute('tabindex'), '0');
    assert.equal(await cloudFrame().evaluate(element => getComputedStyle(element).pointerEvents), 'auto', 'Recording playback controls must accept user input');
    return frame;
  }

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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('about:blank');
    bridgeState = freshBridgeState();
    viewerRequests.length = 0;
    networkFailures.length = 0;
    await page.goto(url);
    await ready();
    await panel().locator('.bt-bar').waitFor();
  }

  async function test(name, run, { expectedConsole } = {}) {
    if (testFilter && !testFilter.test(name)) return;
    expectedConsolePattern = expectedConsole;
    const previousErrors = runtimeErrors.length;
    try {
      await reset();
      await run();
      assert.equal(runtimeErrors.length, previousErrors, `Unexpected console/page errors: ${runtimeErrors.slice(previousErrors).join('; ')}`);
      results.push({ name, passed: true });
      console.log(`PASS ${name}`);
    } catch (err) {
      results.push({ name, passed: false, error: err.message });
      console.log(`FAIL ${name} — ${err.message}`);
      console.log('Network failures:', JSON.stringify(networkFailures));
      await page.screenshot({ path: path.join(artifacts, `generate-failure-${results.length}.png`) }).catch(() => {});
      console.log('Diagnostic:', JSON.stringify(await page.evaluate(() => {
        const shadow = document.querySelector('#browser-teacher-root')?.shadowRoot;
        return { url: location.href, panel: shadow?.querySelector('.bt-body')?.textContent,
          viewer: shadow?.querySelector('.bt-cloud-window')?.textContent,
          frames: [...(shadow?.querySelectorAll('iframe') || [])].map(frame => ({ src: frame.src, title: frame.title })) };
      }).catch(() => null)));
    } finally {
      expectedConsolePattern = undefined;
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
    await until(() => bridgeState.generateCalls.length === 1, 'Choosing None of these must send the original question to authoring');
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
    assert.ok(trail.some(t => t.includes('Tried "Options"')), `expected the actual exploration trail, got ${JSON.stringify(trail)}`);
    assert.ok(!trail.some(t => /^Opening a cloud browser/.test(t)), 'Opening status has one persistent clickable row rather than a duplicate trail entry');
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
  }, { expectedConsole: /^\[browser-teacher\] Error: I explored but could not find a reliable way to do that\./ });

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

  await test('The cloud viewer opens while waiting, then becomes live without a new progress entry', async () => {
    await startGeneration();
    assert.match(await watch().textContent(), /Opening a cloud browser/i);
    await watch().click();
    await cloudWindow().waitFor();
    assert.equal(await cloudWindow().getAttribute('role'), 'dialog');
    assert.equal(await cloudWindow().getAttribute('aria-label'), 'Cloud browser');
    assert.equal(await cloudFrame().count(), 0, 'No iframe before a viewer URL exists');
    await panel().locator('.bt-cloud-message').waitFor();
    await panel().locator('.bt-trail li').first().waitFor();
    const progressBefore = await panel().locator('.bt-trail li').allTextContents();
    liveViewer();
    await viewerReady();
    assert.match(await watch().textContent(), /Watch cloud browser/i);
    assert.deepEqual(await panel().locator('.bt-trail li').allTextContents(), progressBefore, 'Viewer readiness must not depend on appending progress');
    assert.equal(await cloudFrame().getAttribute('title'), 'Steel live browser');
    assert.equal(await cloudFrame().getAttribute('tabindex'), '-1');
    assert.equal(await cloudFrame().evaluate(element => getComputedStyle(element).pointerEvents), 'none', 'Viewer must not forward mouse input into the AI session');
    const requestsBefore = viewerRequests.length;
    const pollsBefore = bridgeState.pollCalls.length;
    await until(() => bridgeState.pollCalls.length >= pollsBefore + 2, 'Job must continue polling while viewer is open');
    assert.equal(viewerRequests.length, requestsBefore, 'Unchanged job metadata must not reload the live stream');
    assert.equal(bridgeState.generateCalls.length, 1);
    await page.screenshot({ path: path.join(artifacts, 'cloud-viewer-desktop.png') });
  });

  await test('The viewer loads cross-origin content even when the website CSP disallows frames and connections', async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/docs/generate-csp-fixture.html`);
    await ready();
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    assert.ok(viewerRequests.length > 0, 'Remote frame content must actually load, not just have a src');
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    const recording = await recordingReady();
    await recording.locator('#recording-play').click();
    assert.equal(await recording.evaluate(() => window.recordingClicks), 1, 'Recording controls must work under the restrictive host CSP');
  });

  await test('A public HTTPS website can open and reopen a completed recording under restrictive CSP', async () => {
    await page.goto(HTTPS_FIXTURE);
    await ready();
    assert.equal(await page.evaluate(() => location.origin), 'https://example.com');
    assert.equal(await page.evaluate(() => window.isSecureContext), true);
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    let frame = await recordingReady();
    await frame.locator('#recording-play').click();
    assert.equal(await frame.evaluate(() => window.recordingClicks), 1);
    await minimize().click();
    await history().click();
    frame = await recordingReady();
    await frame.locator('#recording-play').focus();
    await frame.locator('#recording-play').press('Enter');
    assert.equal(await frame.evaluate(() => window.recordingClicks), 1);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('The web-accessible recording wrapper rejects arbitrary local and remote destinations', async () => {
    const wrapper = await evaluate(`chrome.runtime.getURL('src/panel/replay-frame.html')`);
    const rejected = [
      'https://attacker.invalid/player',
      `${bridgeUrl}/health`,
      `http://127.0.0.1:${bridge.address().port + 1}/replays/${REPLAY_TOKEN}/player`,
    ];
    for (const destination of rejected) {
      const wrapperUrl = new URL(wrapper);
      wrapperUrl.searchParams.set('url', destination);
      await evaluate(`(() => { const element = document.createElement('iframe'); element.id = 'invalid-wrapper'; element.src = ${JSON.stringify(wrapperUrl.href)}; document.body.appendChild(element); })()`);
      await until(() => page.frames().some(frame => frame.url() === wrapperUrl.href), 'The actual extension wrapper must load for validation');
      const frame = page.frames().find(candidate => candidate.url() === wrapperUrl.href);
      await frame.locator('#message', { hasText: 'not valid' }).waitFor();
      assert.equal(await frame.locator('iframe').count(), 0, 'Invalid input must not create a privileged local-network iframe');
      await evaluate(`document.querySelector('#invalid-wrapper').remove()`);
    }
    assert.deepEqual(bridgeState.playerCalls, []);
  });

  await test('Playback waits for a real player signal and rejects the wrong source and origin', async () => {
    bridgeState.autoViewerReady = false;
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    let frame = await viewerReady(VIEWER_URL, { playback: false });
    const message = panel().locator('.bt-cloud-message');
    assert.equal(await message.isVisible(), true, 'Loading HTML alone must not claim live playback');
    assert.match(await message.textContent(), /Connecting to the live browser/);
    await page.evaluate(() => window.postMessage({ type: 'steel:ready', detail: {} }, '*'));
    await pause(100);
    assert.equal(await message.isVisible(), true, 'The host website may not fake player readiness');
    await evaluate(`(() => { const other = document.createElement('iframe'); other.id = 'unrelated-player'; other.hidden = true; other.src = ${JSON.stringify(RETRY_VIEWER_URL)}; document.body.appendChild(other); })()`);
    await until(() => page.frames().some(candidate => candidate.url().startsWith(RETRY_VIEWER_URL)), 'Unrelated same-origin fixture frame must load');
    const otherFrame = page.frames().find(candidate => candidate.url().startsWith(RETRY_VIEWER_URL));
    await otherFrame.locator('#steel-fixture').waitFor({ state: 'attached' });
    await otherFrame.evaluate(() => parent.postMessage({ type: 'steel:ready', detail: {} }, '*'));
    await pause(100);
    assert.equal(await message.isVisible(), true, 'Even the allowed origin must come from the current player frame');
    await evaluate(`document.querySelector('#unrelated-player').remove()`);
    const wrongOrigin = `http://127.0.0.1:${server.address().port}/docs/generate-player-fixture.html`;
    // An iframe process may be replaced during cross-site navigation. Re-find
    // the actual browsing context after changing src instead of retaining a
    // Playwright/CDP object tied to the previous out-of-process target.
    await cloudFrame().evaluate((element, destination) => { element.src = destination; }, wrongOrigin);
    await until(() => page.frames().some(candidate => candidate.url() === wrongOrigin), 'Current player must navigate to the wrong-origin fixture');
    frame = page.frames().find(candidate => candidate.url() === wrongOrigin);
    await frame.locator('#wrong-origin').waitFor();
    await frame.evaluate(() => parent.postMessage({ type: 'steel:ready', detail: {} }, '*'));
    await pause(100);
    assert.equal(await message.isVisible(), true, 'The current frame at a different origin may not fake playback');
    await cloudFrame().evaluate((element, destination) => { element.src = destination; }, `${VIEWER_URL}?interactive=false`);
    await until(() => page.frames().some(candidate => candidate.url().startsWith(VIEWER_URL)), 'Current player must return to the allowed-origin fixture');
    frame = page.frames().find(candidate => candidate.url().startsWith(VIEWER_URL));
    await frame.locator('#steel-fixture').waitFor();
    await frame.evaluate(() => parent.postMessage({ type: 'steel:state', detail: { firstFrameDrawn: false, isConnected: true } }, '*'));
    await pause(100);
    assert.equal(await message.isVisible(), true, 'A connection without a decoded first frame is still connecting');
    await frame.evaluate(() => parent.postMessage({ type: 'steel:state', detail: { firstFrameDrawn: true, isConnected: true } }, '*'));
    await message.waitFor({ state: 'hidden' });
    assert.match(await panel().locator('.bt-cloud-status').textContent(), /^Live/);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Playback errors recover in place while a closed session stays closed', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    const frame = await viewerReady();
    const failures = [
      ['steel:autoplay-blocked', /paused live playback/i],
      ['steel:error', /not ready|reconnecting|could not connect/i],
      ['steel:disconnected', /not ready|reconnecting|stream disconnected/i],
      ['steel:session-ended', /browser has closed/i],
    ];
    const requestsBefore = viewerRequests.length;
    for (const [type, expectedMessage] of failures) {
      await frame.evaluate(eventType => parent.postMessage({ type: eventType, detail: {} }, '*'), type);
      const message = panel().locator('.bt-cloud-message');
      await message.waitFor();
      assert.match(await message.textContent(), expectedMessage);
      const link = panel().locator('.bt-cloud-external');
      assert.equal(await link.isVisible(), true, 'Failure must leave a usable direct-player fallback');
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(new URL(await link.getAttribute('href')).searchParams.get('interactive'), 'false');
      assert.equal(await cloudFrame().count(), 1, 'Playback messages must not repeatedly reload the player');
      await frame.evaluate(() => parent.postMessage({ type: 'steel:ready', detail: {} }, '*'));
      if (type === 'steel:session-ended') {
        await frame.evaluate(() => parent.postMessage({ type: 'steel:disconnected', detail: {} }, '*'));
        await pause(1800);
        assert.equal(await message.isVisible(), true, 'An ended session must ignore late ready and disconnected events');
        assert.match(await message.textContent(), /browser has closed/i);
      } else await message.waitFor({ state: 'hidden' });
    }
    assert.equal(viewerRequests.length, requestsBefore);
    assert.equal(bridgeState.generateCalls.length, 1);
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(await panel().locator('.bt-cloud-message').isVisible(), false, 'A new session must not inherit the previous terminal latch');
  });

  await test('Minimize unloads the viewer and keyboard reopen preserves the same generation job', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().focus();
    await watch().press('Enter');
    await viewerReady();
    await minimize().focus();
    assert.equal(await minimize().getAttribute('aria-label'), 'Minimize cloud browser');
    await minimize().press('Enter');
    await cloudWindow().waitFor({ state: 'hidden' });
    assert.equal(await cloudFrame().count(), 0, 'Minimize must release the embedded remote session view');
    assert.equal(page.frames().some(frame => frame.url().startsWith('https://api.steel.dev/')), false);
    assert.equal(await watch().evaluate(element => element.getRootNode().activeElement === element), true, 'Focus must return to the reopen button');
    const pollsBefore = bridgeState.pollCalls.length;
    await until(() => bridgeState.pollCalls.length > pollsBefore, 'Minimizing must leave generation polling alive');
    await watch().press('Enter');
    await viewerReady();
    assert.equal(bridgeState.generateCalls.length, 1, 'Reopen must not create another job');
    assert.equal(await cloudWindow().count(), 1, 'Reopen must reuse one viewer window');
  });

  await test('A retry replaces the live URL without requiring more progress or another generation request', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    const trailBefore = await panel().locator('.bt-trail li').allTextContents();
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(page.frames().some(frame => frame.url().startsWith(VIEWER_URL)), false, 'Previous session iframe must be replaced');
    assert.equal(await cloudFrame().count(), 1);
    assert.deepEqual(await panel().locator('.bt-trail li').allTextContents(), trailBefore);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('The primary live trigger leaves recording history and reopens the second attempt', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    await recordingReady();
    await history().click();
    await recordingReady();
    await minimize().click();
    await noViewer();
    liveViewer(RETRY_VIEWER_URL, 2);
    await until(async () => /Watch cloud browser/.test(await watch().textContent()), 'Primary trigger must describe the current live attempt while an older recording is selected');
    await watch().click();
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(await panel().locator('.bt-cloud-session').inputValue(), 'current');
    await history().click();
    await recordingReady();
    assert.match(await watch().textContent(), /Watch cloud browser/);
    await watch().click();
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(await panel().locator('.bt-cloud-session').inputValue(), 'current');
    assert.equal(bridgeState.generateCalls.length, 1, 'Returning to the active browser must not start another authoring job');
  });

  await test('A second-attempt startup error reconnects its iframe automatically and becomes ready', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'error', 'ready');
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    await until(() => liveLoads(RETRY_VIEWER_URL) === 2, 'The second live browser must retry a transient startup failure');
    const frame = await viewerReady(RETRY_VIEWER_URL);
    assert.equal(await frame.evaluate(() => window.fixtureSessionId), '22222222-2222-4222-8222-222222222222');
    assert.equal(await panel().locator('.bt-cloud-retry').isVisible(), false);
    const readyLoads = liveLoads(RETRY_VIEWER_URL);
    await pause(1800);
    assert.equal(liveLoads(RETRY_VIEWER_URL), readyLoads, 'Successful playback must cancel pending retries');
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('A second live connection recovers from get-state without requiring another ready event', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    const frame = await viewerReady(RETRY_VIEWER_URL);
    const loads = liveLoads(RETRY_VIEWER_URL);
    const stateRequests = await frame.evaluate(() => window.viewerStateRequests);
    await frame.evaluate(() => {
      window.fixturePlayback = { type: 'state-ready' };
      parent.postMessage({ type: 'steel:disconnected', detail: { sessionId: window.fixtureSessionId } }, '*');
      parent.postMessage({ type: 'steel:connected', detail: { sessionId: window.fixtureSessionId } }, '*');
    });
    await until(() => frame.evaluate(before => window.viewerStateRequests > before, stateRequests), 'A connected event must query the existing playback state');
    await panel().locator('.bt-cloud-message').waitFor({ state: 'hidden' });
    await pause(1800);
    assert.equal(liveLoads(RETRY_VIEWER_URL), loads, 'Recovering an already-drawn frame must not reload its browser');
    assert.equal(await frame.evaluate(() => window.fixtureEmitted.filter(type => type === 'steel:ready').length), 1, 'Steel does not emit a second ready event for the same decoded stream');
    assert.ok((await frame.evaluate(() => window.fixtureEmitted)).includes('steel:state'));
  });

  await test('A silent second-attempt startup uses the bounded readiness timeout and recovers', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'silent', 'ready');
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL, { playback: false });
    await until(() => liveLoads(RETRY_VIEWER_URL) === 2, 'A player that never signals readiness must reconnect after the production timeout', 22000);
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Minimizing cancels a scheduled second-attempt reconnect until the user reopens it', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'error', 'ready');
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL, { playback: false });
    await until(async () => /Reconnecting automatically/.test(await panel().locator('.bt-cloud-message').textContent()), 'A transient failure must schedule reconnect');
    await minimize().click();
    await noViewer();
    const loads = liveLoads(RETRY_VIEWER_URL);
    await pause(1800);
    assert.equal(liveLoads(RETRY_VIEWER_URL), loads, 'A minimized viewer must not recreate its iframe');
    await watch().click();
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Selecting an older recording cancels the second live attempt reconnect', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'error', 'ready');
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    const first = releaseRecording();
    await recordingReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL, { playback: false });
    await until(async () => /Reconnecting automatically/.test(await panel().locator('.bt-cloud-message').textContent()), 'A transient failure must schedule reconnect');
    await panel().locator('.bt-cloud-session').selectOption(first.sessionId);
    await recordingReady();
    const loads = liveLoads(RETRY_VIEWER_URL);
    await pause(1800);
    assert.equal(liveLoads(RETRY_VIEWER_URL), loads, 'Live retry must not replace the recording selected by the user');
    await watch().click();
    await viewerReady(RETRY_VIEWER_URL);
  });

  await test('Switching to another live session cancels retries for the previous browser', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'error');
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL, { playback: false });
    await until(async () => /Reconnecting automatically/.test(await panel().locator('.bt-cloud-message').textContent()), 'The old session must have a pending retry');
    liveViewer(THIRD_VIEWER_URL, 3);
    await viewerReady(THIRD_VIEWER_URL);
    const oldLoads = liveLoads(RETRY_VIEWER_URL);
    await pause(1800);
    assert.equal(liveLoads(RETRY_VIEWER_URL), oldLoads, 'An old retry must not reload after session selection changed');
    assert.ok((await cloudFrame().getAttribute('src')).startsWith(THIRD_VIEWER_URL));
  });

  await test('Live reconnects stop after three retries and a manual retry can recover', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'error', 'error', 'error', 'error', 'ready');
    await startGeneration({ viewer: { status: 'live', url: RETRY_VIEWER_URL, attempt: 2, phase: 'explore' } });
    await watch().click();
    await until(() => liveLoads(RETRY_VIEWER_URL) === 4, 'Three automatic retries must follow the first failed load', 15000);
    await until(async () => /Retry the live view here/.test(await panel().locator('.bt-cloud-message').textContent()), 'Exhausted retries must offer a manual action');
    await pause(5500);
    assert.equal(liveLoads(RETRY_VIEWER_URL), 4, 'Retries must be bounded while job polling continues');
    await panel().locator('.bt-cloud-retry').click();
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(liveLoads(RETRY_VIEWER_URL), 5);
    assert.equal(await minimize().evaluate(element => element.getRootNode().activeElement === element), true, 'Retry focus must remain on an available viewer control');
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Second-attempt autoplay blocking stays explicit and a manual retry opens a fresh live view', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'autoplay-blocked', 'ready');
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL, { playback: false });
    await until(async () => /paused live playback/.test(await panel().locator('.bt-cloud-message').textContent()), 'An autoplay restriction must be explained');
    await pause(1800);
    assert.equal(liveLoads(RETRY_VIEWER_URL), 1, 'Autoplay policy must not produce an automatic reload loop');
    assert.equal(await cloudFrame().evaluate(element => getComputedStyle(element).pointerEvents), 'none', 'Recovery must not enable remote input');
    await panel().locator('.bt-cloud-external').waitFor();
    await panel().locator('.bt-cloud-retry').focus();
    await panel().locator('.bt-cloud-retry').press('Enter');
    await viewerReady(RETRY_VIEWER_URL);
    assert.equal(liveLoads(RETRY_VIEWER_URL), 2);
    assert.equal(await minimize().evaluate(element => element.getRootNode().activeElement === element), true);
  });

  await test('Second-attempt playback ignores late messages from an earlier session view', async () => {
    playbackPlan(RETRY_VIEWER_URL, 'manual');
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    const current = await viewerReady(RETRY_VIEWER_URL, { playback: false });
    await evaluate(`(() => { const old = document.createElement('iframe'); old.id = 'old-session-view'; old.hidden = true; old.src = ${JSON.stringify(VIEWER_URL)}; document.body.appendChild(old); })()`);
    await until(() => page.frames().some(frame => frame.url().startsWith(VIEWER_URL)), 'Earlier session view must load independently');
    const old = page.frames().find(frame => frame.url().startsWith(VIEWER_URL));
    await old.locator('#steel-fixture').waitFor({ state: 'attached' });
    const requests = await current.evaluate(() => window.viewerStateRequests);
    await old.evaluate(() => {
      for (const type of ['steel:ready', 'steel:error', 'steel:disconnected', 'steel:connected', 'steel:session-ended']) {
        parent.postMessage({ type, detail: { sessionId: window.fixtureSessionId } }, '*');
      }
    });
    await pause(1800);
    assert.equal(liveLoads(RETRY_VIEWER_URL), 1);
    assert.equal(await current.evaluate(() => window.viewerStateRequests), requests, 'Old connection messages must not query the current player');
    assert.match(await panel().locator('.bt-cloud-message').textContent(), /Connecting to the live browser/);
    await evaluate(`document.querySelector('#old-session-view').remove()`);
    await current.evaluate(() => parent.postMessage({ type: 'steel:ready', detail: { sessionId: window.fixtureSessionId } }, '*'));
    await panel().locator('.bt-cloud-message').waitFor({ state: 'hidden' });
  });

  await test('A closed remote session unloads its stale iframe and presents the viewer state', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    bridgeState.viewer = { status: 'closed', url: VIEWER_URL, attempt: 1, phase: 'explore' };
    await until(async () => await cloudFrame().count() === 0, 'Closed session must unload its iframe');
    await cloudWindow().waitFor();
    assert.match(await panel().locator('.bt-cloud-message').textContent(), /clos|finish|ended/i);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Unavailable viewer metadata removes the old frame while the authoring job continues', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    bridgeState.viewer = { status: 'unavailable', url: null, attempt: 1, phase: 'explore' };
    await until(async () => await cloudFrame().count() === 0, 'Unavailable session must unload the previous iframe');
    assert.match(await panel().locator('.bt-cloud-message').textContent(), /unavailable|not available/i);
    assert.equal(await panel().locator('.bt-trail').count(), 1, 'Job progress must remain visible');
  });

  await test('A disconnected bridge unloads a stale viewer and recovers on the next successful poll', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    bridgeState.mode = 'disconnect';
    await until(async () => await cloudFrame().count() === 0, 'Disconnected bridge must unload stale viewer');
    assert.match(await panel().locator('.bt-cloud-message').textContent(), /disconnect|connection|reconnect/i);
    bridgeState.mode = 'ok';
    await viewerReady();
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('A completed generation retains its recording until the user clicks Done', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    const recording = await recordingReady();
    assert.equal(await minimize().evaluate(element => element.getRootNode().activeElement === element), true, 'The retained viewer must preserve keyboard focus');
    await recording.locator('#recording-play').click();
    assert.equal(await recording.evaluate(() => window.recordingClicks), 1, 'The saved recording must accept actual user playback input');
    await history().waitFor();
    assert.equal(await watch().count(), 0);
    const completedPolls = bridgeState.pollCalls.length;
    await minimize().click();
    await showMe();
    await page.locator('#menu-open').click();
    await panel().locator('.bt-card-step .bt-card-body', { hasText: 'Schedule publication' }).waitFor();
    await page.locator('#schedule').click();
    await panel().locator('.bt-card-generalization').waitFor();
    await history().click();
    await recordingReady();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Done' }).click();
    await noViewer();
    assert.equal(await history().count(), 0, 'Done must remove the completed task recording history');
    assert.equal(bridgeState.pollCalls.length, completedPolls, 'Job polling must end when the lesson arrives');
    assert.equal(bridgeState.generateCalls.length, 1, 'Replaying after the lesson must not generate again');
  });

  await test('A failed generation retains its recording after closing the error panel', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.mode = 'error';
    await panel().locator('.bt-card-error').waitFor();
    await recordingReady();
    const completedPolls = bridgeState.pollCalls.length;
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Close' }).click();
    await noViewer();
    await history().click();
    await recordingReady();
    assert.equal(bridgeState.pollCalls.length, completedPolls);
    assert.equal(bridgeState.generateCalls.length, 1);
  }, { expectedConsole: /^\[browser-teacher\] Error: I explored but could not find a reliable way to do that\./ });

  await test('Switching a completed viewer to its recording preserves the website focus', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    await page.locator('#name-input').focus();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    await recordingReady();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'name-input', 'Recording readiness must not steal focus from the website');
  });

  await test('A minimized recording trigger transfers keyboard focus to the arriving lesson', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().focus();
    await watch().press('Enter');
    await viewerReady();
    await minimize().press('Enter');
    await noViewer();
    assert.equal(await watch().evaluate(element => element.getRootNode().activeElement === element), true);
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    assert.equal(await panel().locator('.bt-actions .bt-btn', { hasText: 'Show me' }).evaluate(element => element.getRootNode().activeElement === element), true, 'Removing the focused generating trigger must focus the next lesson action');
    await history().waitFor();
    await noViewer();
  });

  await test('Recording processing and recovery continue independently after job polling has ended', async () => {
    bridgeState.playerMode = 'pending';
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    await recordingReady(REPLAY_TOKEN, { state: 'pending' });
    assert.equal(page.frames().some(frame => frame.url().startsWith('https://api.steel.dev/')), false, 'A closed session must release its obsolete live iframe');
    const jobPolls = bridgeState.pollCalls.length;
    const loads = bridgeState.playerCalls.length;
    bridgeState.playerMode = 'error';
    await recordingReady(REPLAY_TOKEN, { state: 'error' });
    bridgeState.playerMode = 'ready';
    const recording = await recordingReady();
    await recording.locator('#recording-play').focus();
    await recording.locator('#recording-play').press('Enter');
    assert.equal(await recording.evaluate(() => window.recordingClicks), 1);
    assert.equal(bridgeState.pollCalls.length, jobPolls, 'Encoding readiness must not extend generation polling');
    assert.equal(bridgeState.playerCalls.length, loads, 'Player readiness changes must not reload its iframe');
    await minimize().click();
    await history().click();
    await recordingReady();
    assert.equal(bridgeState.generateCalls.length, 1);
    await page.screenshot({ path: path.join(artifacts, 'cloud-recording-desktop.png') });
  });

  await test('Escape inside a recording minimizes it while untrusted minimize messages are ignored', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    let frame = await recordingReady();
    const originalWrapper = await cloudFrame().getAttribute('src');
    await page.evaluate(() => window.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*'));
    await pause(100);
    assert.equal(await cloudWindow().isVisible(), true, 'Host-page messages must not minimize the recording');
    const otherWrapper = new URL(originalWrapper);
    otherWrapper.searchParams.set('url', replayUrl(RETRY_REPLAY_TOKEN));
    await evaluate(`(() => { const other = document.createElement('iframe'); other.id = 'unrelated-recording'; other.hidden = true; other.src = ${JSON.stringify(otherWrapper.href)}; document.body.appendChild(other); })()`);
    await until(() => page.frames().some(candidate => candidate.url() === otherWrapper.href), 'Unrelated extension-origin wrapper must load');
    const otherFrame = page.frames().find(candidate => candidate.url() === otherWrapper.href);
    await otherFrame.locator('#message').waitFor({ state: 'attached' });
    await otherFrame.evaluate(() => parent.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*'));
    await pause(100);
    assert.equal(await cloudWindow().isVisible(), true, 'Only the currently embedded recording may request minimize');
    await evaluate(`document.querySelector('#unrelated-recording').remove()`);
    const wrongOrigin = `http://127.0.0.1:${server.address().port}/docs/generate-player-fixture.html`;
    await cloudFrame().evaluate((element, destination) => { element.src = destination; }, wrongOrigin);
    await until(() => page.frames().some(candidate => candidate.url() === wrongOrigin), 'Current recording must reach the wrong-origin fixture');
    frame = page.frames().find(candidate => candidate.url() === wrongOrigin);
    await frame.locator('#wrong-origin').waitFor();
    await frame.evaluate(() => parent.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*'));
    await pause(100);
    assert.equal(await cloudWindow().isVisible(), true, 'A different origin in the same frame must not request minimize');
    await cloudFrame().evaluate((element, destination) => { element.src = destination; }, originalWrapper);
    frame = await recordingReady();
    const activeWrapper = frame.parentFrame();
    await activeWrapper.evaluate(() => {
      const sibling = document.createElement('iframe');
      sibling.id = 'unrelated-inner';
      sibling.hidden = true;
      sibling.src = document.querySelector('iframe').src;
      document.body.appendChild(sibling);
    });
    await until(() => activeWrapper.childFrames().length === 2, 'Unrelated loopback frame inside wrapper must load');
    const unrelatedInner = activeWrapper.childFrames().find(candidate => candidate !== frame);
    await unrelatedInner.locator('#recording-fixture').waitFor({ state: 'attached' });
    await unrelatedInner.evaluate(() => parent.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*'));
    await pause(100);
    assert.equal(await cloudWindow().isVisible(), true, 'Wrapper must reject messages from another same-origin inner frame');
    await activeWrapper.locator('#unrelated-inner').evaluate(element => element.remove());
    await activeWrapper.locator('iframe').evaluate((element, destination) => { element.src = destination; }, wrongOrigin);
    await until(() => activeWrapper.childFrames().some(candidate => candidate.url() === wrongOrigin), 'Inner player must reach wrong-origin fixture');
    const wrongInner = activeWrapper.childFrames().find(candidate => candidate.url() === wrongOrigin);
    await wrongInner.locator('#wrong-origin').waitFor();
    await wrongInner.evaluate(() => parent.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*'));
    await pause(100);
    assert.equal(await cloudWindow().isVisible(), true, 'Wrapper must reject a different origin in the current inner frame');
    await activeWrapper.locator('iframe').evaluate((element, destination) => { element.src = destination; }, replayUrl());
    frame = await recordingReady();
    await frame.locator('#recording-play').focus();
    await frame.locator('#recording-play').press('Escape');
    await noViewer();
    assert.equal(await history().evaluate(element => element.getRootNode().activeElement === element), true, 'Escape must return focus to Watch recording');
    await history().press('Enter');
    await recordingReady();
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Closed attempts remain selectable while a newer cloud browser is running', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    const first = releaseRecording();
    await recordingReady();
    liveViewer(RETRY_VIEWER_URL, 2);
    await viewerReady(RETRY_VIEWER_URL);
    const sessions = panel().locator('.bt-cloud-session');
    await sessions.selectOption(first.sessionId);
    await recordingReady();
    const beforePolls = bridgeState.pollCalls.length;
    await until(() => bridgeState.pollCalls.length > beforePolls, 'An active attempt must keep polling');
    assert.equal(page.frames().some(frame => frame.url() === replayUrl()), true, 'Polling must preserve the user-selected earlier attempt');
    await sessions.selectOption('current');
    await viewerReady(RETRY_VIEWER_URL);
    releaseRecording({ token: RETRY_REPLAY_TOKEN, sessionId: '22222222-2222-4222-8222-222222222222', attempt: 2 });
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    await recordingReady(RETRY_REPLAY_TOKEN);
    await sessions.selectOption(first.sessionId);
    await recordingReady();
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Stop clears a released recording and stops waiting for the remaining authoring work', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    await recordingReady();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Stop' }).click();
    await noViewer();
    assert.equal(await history().count(), 0, 'Stop must remove the current task recording history');
    const stoppedAt = bridgeState.pollCalls.length;
    bridgeState.delayMs = 0;
    await pause(1500);
    assert.equal(bridgeState.pollCalls.length, stoppedAt);
    assert.equal(await history().count(), 0, 'A later job result must not restore recordings after Stop');
    assert.equal(await panel().locator('.bt-card-preamble, .bt-card-step').count(), 0);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('Starting a new lesson clears the previous recording history', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    await recordingReady();
    await evaluate(`void (__BT_DEV.runLesson(${JSON.stringify(GENERATED)}))`);
    await panel().locator('.bt-card-preamble').waitFor();
    await noViewer();
    assert.equal(await history().count(), 0);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('A new cached question clears previous recordings without generating again', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    await recordingReady();
    await panel().locator('.bt-close').click();
    await noViewer();
    await history().waitFor();
    await ask('how do I schedule a post for later');
    await panel().locator('.bt-card-picker').waitFor();
    assert.equal(await history().count(), 0, 'A fresh question must clear the old task history even when served from cache');
    await panel().getByRole('button', { name: GENERATED.goal, exact: true }).click();
    await panel().locator('.bt-card-preamble').waitFor();
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  await test('A new generation clears old recording history and ignores a delayed old job result', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    await recordingReady();
    const previous = bridgeState;
    previous.pollDelayMs = 2300;
    const beforePolls = previous.pollCalls.length;
    await until(() => previous.pollCalls.length > beforePolls, 'Old job must have a delayed request in flight');
    await panel().locator('.bt-close').click();
    await history().waitFor();
    bridgeState = freshBridgeState();
    await startGeneration({ viewer: { status: 'live', url: RETRY_VIEWER_URL, attempt: 1, phase: 'explore' }, question: 'how do I create a lunar publishing reminder' });
    assert.equal(await history().count(), 0, 'Starting a different generation must clear previous history');
    await watch().click();
    await viewerReady(RETRY_VIEWER_URL);
    await pause(2400);
    assert.equal(await history().count(), 0, 'The delayed old job must not restore its recordings');
    assert.equal(await cloudFrame().getAttribute('title'), 'Steel live browser');
    assert.ok((await cloudFrame().getAttribute('src')).startsWith(RETRY_VIEWER_URL));
    assert.notEqual(bridgeState.jobId, previous.jobId);
    assert.equal(bridgeState.generateCalls.length, 1);
    assert.equal(previous.generateCalls.length, 1);
  });

  await test('Late recording readiness cannot restore history after a new generation replaces it', async () => {
    bridgeState.playerMode = 'pending';
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    await recordingReady(REPLAY_TOKEN, { state: 'pending' });
    const previous = bridgeState;
    previous.playerDelayMs = 1800;
    const beforePolls = previous.playerPollCalls.length;
    await until(() => previous.playerPollCalls.length > beforePolls, 'Recording must have a delayed readiness response in flight');
    await panel().locator('.bt-close').click();
    bridgeState = freshBridgeState();
    await startGeneration({ question: 'how do I create a lunar publishing reminder' });
    await watch().click();
    previous.playerMode = 'ready';
    await pause(2000);
    assert.equal(await history().count(), 0);
    assert.equal(await cloudFrame().count(), 0, 'An old recording response must not populate the new waiting window');
    assert.match(await panel().locator('.bt-cloud-message').textContent(), /Waiting for the cloud browser/);
  });

  await test('Route navigation after declining a lesson clears retained recording history', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    await recordingReady();
    await minimize().click();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Not now' }).click();
    await history().click();
    await recordingReady();
    await page.locator('#spa').focus();
    await page.locator('#spa').press('Enter');
    await until(() => page.url().includes('extension-fixture-route'), 'Fixture route must change');
    await noViewer();
    assert.equal(await history().count(), 0, 'History must clear even when the original lesson run has already finished');
  });

  await test('A full redirect clears retained recordings from the previous page', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    await recordingReady();
    await page.locator('#redirect').focus();
    await page.locator('#redirect').press('Enter');
    await page.waitForURL('**/extension-fixture.html?destination=1');
    await ready();
    await noViewer();
    assert.equal(await history().count(), 0);
  });

  await test('Recording URLs must use the bridge port and exact opaque replay-player path', async () => {
    await startGeneration();
    await watch().click();
    const rejected = [
      `https://attacker.invalid/replays/${REPLAY_TOKEN}/player`,
      `http://localhost.attacker.invalid:${bridge.address().port}/replays/${REPLAY_TOKEN}/player`,
      `http://127.0.0.1:${bridge.address().port + 1}/replays/${REPLAY_TOKEN}/player`,
      `http://user:secret@127.0.0.1:${bridge.address().port}/replays/${REPLAY_TOKEN}/player`,
      `${replayUrl()}?token=fixture-secret`,
      `${replayUrl()}#fragment`,
      `${bridgeUrl}/replays/short/player`,
      `${bridgeUrl}/arbitrary/${REPLAY_TOKEN}/player`,
      VIEWER_URL,
    ];
    for (const rejectedUrl of rejected) {
      bridgeState.viewer = { status: 'closed', url: null, attempt: 1, phase: 'explore' };
      bridgeState.recordings = [{ sessionId: 'untrusted', attempt: 1, phase: 'explore', url: rejectedUrl }];
      const beforePolls = bridgeState.pollCalls.length;
      await until(() => bridgeState.pollCalls.length > beforePolls, 'Invalid recording metadata must be received');
      await pause(120);
      assert.equal(await cloudFrame().count(), 0, `Recording URL must not load: ${rejectedUrl}`);
      assert.equal(await history().count(), 0, 'Invalid recordings must not get a persistent launcher');
    }
    assert.deepEqual(bridgeState.playerCalls, []);
    bridgeState.recordings = [];
    releaseRecording();
    await recordingReady();
  });

  await test('Recorded-session controls and the persistent launcher remain usable on a narrow viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    releaseRecording();
    bridgeState.delayMs = 0;
    await panel().locator('.bt-card-preamble').waitFor();
    const frame = await recordingReady();
    const bounds = await cloudWindow().boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845, `Recording window must fit viewport: ${JSON.stringify(bounds)}`);
    await frame.locator('#recording-play').focus();
    await frame.locator('#recording-play').press('Enter');
    assert.equal(await frame.evaluate(() => window.recordingClicks), 1);
    await page.screenshot({ path: path.join(artifacts, 'cloud-recording-mobile.png') });
    await minimize().focus();
    await minimize().press('Enter');
    await noViewer();
    assert.equal(await history().evaluate(element => element.getRootNode().activeElement === element), true, 'Minimize must focus the surviving recording launcher');
    await history().press('Enter');
    await recordingReady();
    assert.equal(bridgeState.generateCalls.length, 1);
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Not now' }).click();
    await noViewer();
    await history().waitFor();
  });

  await test('Stop closes the viewer and stops polling without starting a lesson later', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    await panel().locator('.bt-actions .bt-btn', { hasText: 'Stop' }).click();
    await noViewer();
    const stoppedAt = bridgeState.pollCalls.length;
    bridgeState.delayMs = 0;
    await pause(1600);
    assert.equal(bridgeState.pollCalls.length, stoppedAt, 'Stop must abort future job polls');
    assert.equal(await panel().locator('.bt-card-preamble, .bt-card-step').count(), 0);
    assert.equal(await panel().locator('.bt-bar input').isEnabled(), true);
  });

  await test('Closing the teaching panel also releases the viewer and its polling', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    await panel().locator('.bt-close').click();
    await noViewer();
    const stoppedAt = bridgeState.pollCalls.length;
    await pause(1500);
    assert.equal(bridgeState.pollCalls.length, stoppedAt);
  });

  await test('Replacing generation with a lesson removes the viewer and blocks old job callbacks', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    await evaluate(`void (__BT_DEV.runLesson(${JSON.stringify(GENERATED)}))`);
    await panel().locator('.bt-card-preamble').waitFor();
    await noViewer();
    assert.equal(await panel().locator('.bt-actions .bt-btn', { hasText: 'Show me' }).evaluate(element => element.getRootNode().activeElement === element), true, 'Replacement must restore viewer focus to the new lesson action');
    const stoppedAt = bridgeState.pollCalls.length;
    bridgeState.delayMs = 0;
    await pause(1500);
    assert.equal(bridgeState.pollCalls.length, stoppedAt);
    assert.equal(await watch().count(), 0);
    assert.equal(await panel().locator('.bt-card-preamble').count(), 1);
  });

  await test('Same-page route navigation clears the viewer and prevents stale job updates', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    await page.locator('#spa').focus();
    await page.locator('#spa').press('Enter');
    await until(() => page.url().includes('extension-fixture-route'), 'Fixture route must change');
    await noViewer();
    const stoppedAt = bridgeState.pollCalls.length;
    await pause(1500);
    assert.equal(bridgeState.pollCalls.length, stoppedAt);
    assert.equal(await panel().locator('.bt-trail').count(), 0);
  });

  await test('A full page redirect removes the previous cloud browsing context and polling', async () => {
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().click();
    await viewerReady();
    await page.locator('#redirect').focus();
    await page.locator('#redirect').press('Enter');
    await page.waitForURL('**/extension-fixture.html?destination=1');
    await ready();
    await noViewer();
    const stoppedAt = bridgeState.pollCalls.length;
    await pause(1500);
    assert.equal(bridgeState.pollCalls.length, stoppedAt);
    assert.equal(await watch().count(), 0);
  });

  await test('Untrusted, credential-bearing and non-HTTPS viewer URLs never become iframe requests', async () => {
    await startGeneration();
    await watch().click();
    const rejected = [
      'javascript:window.viewerInjected=true',
      'data:text/html,<h1>Wrong origin</h1>',
      'http://api.steel.dev/v1/sessions/test/player',
      'https://api.steel.dev.attacker.invalid/v1/sessions/test/player',
      'https://attacker.invalid/?next=https://api.steel.dev',
      'https://user:secret@api.steel.dev/v1/sessions/test/player',
      'https://api.steel.dev:444/v1/sessions/test/player',
      `${VIEWER_URL}?apiKey=fixture-secret`,
      `${VIEWER_URL}?api_key=fixture-secret`,
      `${VIEWER_URL}?token=fixture-secret`,
    ];
    for (const rejectedUrl of rejected) {
      const pollsBefore = bridgeState.pollCalls.length;
      bridgeState.viewer = { status: 'live', url: rejectedUrl, attempt: 1, phase: 'explore' };
      await until(() => bridgeState.pollCalls.length > pollsBefore, 'Invalid URL metadata must be received');
      await pause(120);
      assert.equal(await cloudFrame().count(), 0, `Rejected URL must not create an iframe: ${rejectedUrl}`);
    }
    assert.deepEqual(viewerRequests, [], 'No unsafe Steel URL may reach the network');
    assert.equal(await page.evaluate(() => window.viewerInjected), undefined);
    liveViewer(`${VIEWER_URL}?interactive=true`);
    await viewerReady();
  });

  await test('The cloud window fits a narrow viewport and its minimize action stays keyboard accessible', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startGeneration({ viewer: { status: 'live', url: VIEWER_URL, attempt: 1, phase: 'explore' } });
    await watch().focus();
    await watch().press('Enter');
    await viewerReady();
    const bounds = await cloudWindow().boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845, `Viewer must fit viewport: ${JSON.stringify(bounds)}`);
    assert.ok(await minimize().isVisible());
    await page.screenshot({ path: path.join(artifacts, 'cloud-viewer-mobile.png') });
    await minimize().focus();
    await minimize().press('Enter');
    await cloudWindow().waitFor({ state: 'hidden' });
    assert.equal(await watch().evaluate(element => element.getRootNode().activeElement === element), true);
    assert.equal(bridgeState.generateCalls.length, 1);
  });

  const passed = results.filter(r => r.passed).length;
  assert.equal(await fs.readFile(path.join(productionExtension, 'src/panel/generate.js'), 'utf8'), sourceBefore, 'Production bridge source must remain unchanged by the test');
  console.log(`\n${passed}/${results.length} generation checks passed.`);
  if (runtimeErrors.length) console.log(`Runtime errors: ${runtimeErrors.length}`);

  await report();
  await context.close();
  server.close();
  bridge.close();
  process.exit(passed === results.length && runtimeErrors.length === 0 ? 0 : 1);
})().catch(async err => {
  console.error(err);
  try { await context?.close(); } catch { /* already gone */ }
  server.close();
  bridge.close();
  process.exit(1);
});
