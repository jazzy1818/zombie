// Local/offline authoring handoff checks. No credentials, model calls or cloud
// sessions. Run `npm test` in pipeline; CHROME_PATH optionally selects Chromium.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { PROBE_SOURCE } from './dom-probe.js';
import { diff } from './explore.js';
import { prune } from './prune.js';
import { skeleton, deriveTarget, validate } from './emit.js';
import { matchesCandidate } from './target-policy.js';
import { validatePublishable, verificationEvidence, recordVerification, runRecordedVerification, publishLesson } from './publish.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'bt-pipeline-'));
const results = [];
const pageErrors = [];
let browser;
let browserVersion = 'not launched';
const fixture = `<!doctype html><meta charset="utf-8"><title>Pipeline local fixture</title>
<style>button,input,[role=combobox]{padding:12px;margin:4px} #zoom-readout{width:20px;height:20px}</style>
<div id="docs-toolbar-wrapper" role="toolbar">
 <button aria-label="Zoom" disabled>Loading duplicate</button>
 <div id="zoom" role="combobox" aria-label="Zoom"><input id="zoom-inner" aria-label="Zoom"></div>
 <div id="zoom-readout" role="listbox" aria-label="Zoom list. 100% selected."></div>
 <button aria-label="Duplicate" disabled>Disabled</button><button id="duplicate-a" aria-label="Duplicate">A</button><button id="duplicate-b" aria-label="Duplicate">B</button>
</div>
<div id="zoom-menu" role="listbox" aria-label="Zoom choices" hidden><button id="zoom100" role="option">100%</button><button id="zoom150" role="option">150%</button></div>
<div role="menu"><button id="page-elements" role="menuitem">Page elementsUpdated►</button><button id="heading1" role="menuitem">Heading 1</button><button id="heading10" role="menuitem">Heading 10</button></div>
<div role="menu"><button id="text-accelerator" role="menuitem">Text(S)</button><button role="menuitem">Text(Style)</button><button id="details-accelerator" role="menuitem">Details(B)</button><button id="drive-accelerator" role="menuitem">Add shortcut to Drive(,)</button><button id="issues-count" role="menuitem">Issues 12</button><button id="inbox-count" role="menuitem">Inbox 1,203</button><button id="stars-count" role="menuitem">Stars 1.2k</button><button role="menuitem">Tasks12</button></div>
<div id="hidden-readout" hidden aria-label="Verified result">Verified result</div><div aria-label="Disabled result" aria-disabled="true">Disabled result</div>
<fieldset disabled><legend><button id="legend" aria-label="Legend exception">Legend exception</button></legend><button id="disabled-field" aria-label="Field control">Field control</button></fieldset>
<script>window.activations={zoom:0,selected:0};document.querySelector('#zoom').onclick=()=>{activations.zoom++;document.querySelector('#zoom-menu').hidden=false};document.querySelector('#zoom150').onclick=()=>{activations.selected++;document.querySelector('#zoom-readout').setAttribute('aria-label','Zoom list. 150% selected.');document.querySelector('#zoom-menu').hidden=true};</script>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture); return; }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': extname(file) === '.js' ? 'text/javascript' : 'text/plain' }).end(body);
  } catch { response.writeHead(404).end(); }
});

async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.stack}`); }
}

try {
  const cached = JSON.parse(await readFile(join(root, 'pipeline/cache/zoom-150.json'), 'utf8'));
  await test('Existing recording is valid lesson data, not current replay evidence', () => {
    validate(cached.lesson); validatePublishable(cached.lesson);
    assert.equal(prune(cached.trace).kept.length, 2);
    assert.throws(() => verificationEvidence(cached.lesson, { ok: true, steps: [] }), /complete/);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  async function reset() {
    await page.goto(url);
    await page.evaluate(PROBE_SOURCE);
    await page.evaluate(async () => {
      window.runtime = await import('/extension/src/resolve/resolver.js');
      window.adapter = await import('/extension/src/teaching/resolution.js');
    });
  }
  await reset();
  const compare = target => page.evaluate(target => {
    const hit = __PROBE.resolve(target);
    return { pipeline: hit ? __PROBE.el(hit.id).id : null, runtime: runtime.findSync(target)?.id || null };
  }, target);
  await test('Action candidates agree on nested labels, disabled duplicates and nth', async () => {
    assert.deepEqual(await compare({ scope: 'toolbar', name: 'Zoom' }), { pipeline: 'zoom', runtime: 'zoom' });
    assert.deepEqual(await compare({ scope: 'toolbar', name: 'Duplicate', nth: 1 }), { pipeline: 'duplicate-b', runtime: 'duplicate-b' });
    assert.deepEqual(await compare({ scope: 'toolbar', name: 'Duplicate' }), { pipeline: null, runtime: null });
  });
  await test('Action targets reject state labels while outcomes can inspect them', async () => {
    assert.deepEqual(await compare({ scope: 'toolbar', name: 'Zoom list. 100% selected.' }), { pipeline: null, runtime: null });
    assert.equal(await page.evaluate(() => __PROBE.check({ kind: 'dom', selector: '[aria-label="Zoom list. 100% selected."]' })), true);
    assert.equal(await page.evaluate(() => __PROBE.check({ kind: 'visible', name: 'Disabled result' })), true);
  });
  await test('Menu matching agrees on exact choices and known promo badges', async () => {
    assert.deepEqual(await compare({ scope: 'menu', name: 'Heading 1' }), { pipeline: 'heading1', runtime: 'heading1' });
    assert.deepEqual(await compare({ scope: 'menu', name: 'Page elements' }), { pipeline: 'page-elements', runtime: 'page-elements' });
    await page.locator('#zoom').click();
    assert.deepEqual(await compare({ scope: 'menu', name: '150%' }), { pipeline: 'zoom150', runtime: 'zoom150' });
  });
  const compareNames = async (name, expected) => {
    const target = { scope: 'menu', name };
    const actual = await page.evaluate(target => {
      const candidate = __PROBE.resolve(target);
      return {
        probe: candidate ? __PROBE.el(candidate.id).id : null,
        resolver: runtime.findSync(target)?.id || null,
        fallback: adapter.findTarget(target)?.id || null,
        candidates: __PROBE.observe().menu.map(item => ({ ...item, elementId: __PROBE.el(item.id).id })),
      };
    }, target);
    const policy = actual.candidates.filter(candidate => matchesCandidate(candidate, name, 'menu')).map(candidate => candidate.elementId);
    assert.deepEqual({ probe: actual.probe, resolver: actual.resolver, fallback: actual.fallback, policy },
      { probe: expected, resolver: expected, fallback: expected, policy: expected ? [expected] : [] }, name);
  };
  await test('Single-key menu accelerators agree across probe, resolver, fallback and authoring policy', async () => {
    for (const [name, id] of [['Text', 'text-accelerator'], ['Details', 'details-accelerator'], ['Add shortcut to Drive', 'drive-accelerator']]) {
      await compareNames(name, id);
    }
  });
  await test('Heading 1 and Heading 10 remain distinct across all name matchers', async () => {
    await compareNames('Heading 1', 'heading1');
    await compareNames('Heading 10', 'heading10');
  });
  await test('Native fieldset exception and rendered label checks agree', async () => {
    assert.deepEqual(await compare({ name: 'Legend exception' }), { pipeline: 'legend', runtime: 'legend' });
    assert.deepEqual(await compare({ name: 'Field control' }), { pipeline: null, runtime: null });
    assert.equal(await page.evaluate(() => __PROBE.check({ kind: 'label', selector: '#hidden-readout', match: 'Verified' })), false);
    assert.equal(await page.evaluate(() => __PROBE.check({ kind: 'label', selector: '#zoom-readout', match: '100% selected.' })), true);
  });

  let lesson;
  let replay;
  await test('Real observation → clicks → diff → prune → stable descriptors', async () => {
    await reset();
    const first = await page.evaluate(() => {
      const pre = __PROBE.observe();
      return { pre, target: pre.toolbar.find(c => __PROBE.el(c.id).id === 'zoom-inner') };
    });
    await page.locator('#zoom-inner').click();
    const second = await page.evaluate(() => {
      const post = __PROBE.observe();
      return { post, target: post.menu.find(c => __PROBE.el(c.id).id === 'zoom150') };
    });
    await page.locator('#zoom150').click();
    const final = await page.evaluate(() => __PROBE.observe());
    const trace = { ok: true, steps: [
      { n: 0, pre: first.pre, post: second.post, target: first.target, delta: diff(first.pre, second.post), action: { reasoning: 'Open the zoom choices.' } },
      { n: 1, pre: second.post, post: final, target: second.target, delta: diff(second.post, final), action: { reasoning: 'Choose the requested zoom.' } },
    ] };
    const steps = skeleton(prune(trace).kept).map(({ _trace, ...step }, index) => ({ ...step, intent: cached.lesson.steps[index].intent, hints: cached.lesson.steps[index].hints }));
    lesson = { ...cached.lesson, id: 'pipeline-fixture-zoom', steps };
    validate(lesson); validatePublishable(lesson);
    assert.deepEqual(steps.map(step => step.target), [{ scope: 'toolbar', name: 'Zoom' }, { scope: 'menu', name: '150%' }]);
    assert.deepEqual(steps[1].verify, { kind: 'dom', selector: '[aria-label="Zoom list. 150% selected."]' });
    assert.throws(() => deriveTarget({ ...trace.steps[0], target: { ...first.target, state: true } }), /state readout/);
  });
  await test('Fresh local browser replay produces evidence only after measured outcomes', async () => {
    assert.ok(lesson, 'Descriptor generation must pass');
    await reset();
    const steps = [];
    for (const step of lesson.steps) {
      const id = await page.evaluate(target => __PROBE.resolve(target)?.id, step.target);
      assert.ok(Number.isInteger(id));
      await page.locator(`[data-bt-id="${id}"]`).click();
      assert.equal(await page.evaluate(v => __PROBE.check(v), step.verify), true);
      steps.push({ id: step.id, status: 'ok' });
    }
    assert.deepEqual(await page.evaluate(() => activations), { zoom: 1, selected: 1 });
    replay = { ok: true, local: true, steps };
    assert.equal(verificationEvidence(lesson, replay).complete, true);
  });
  await test('Explicit publication writes complete lesson then discovers it through index', async () => {
    assert.ok(replay, 'Real replay must pass');
    const evidence = verificationEvidence(lesson, replay);
    const destination = join(temporary, 'lessons');
    const published = await publishLesson(lesson, evidence, { lessonsDir: destination });
    assert.deepEqual(JSON.parse(await readFile(published.index, 'utf8')), [lesson.id]);
    assert.deepEqual(JSON.parse(await readFile(published.lesson, 'utf8')), lesson);
    const files = await readdir(destination);
    assert.ok(files.every(file => file.endsWith('.json')), 'No publication lock or partial files remain');
  });
  await test('Modified, failed, skipped and unsafe lessons cannot be published', async () => {
    const evidence = verificationEvidence(lesson, replay);
    await assert.rejects(publishLesson({ ...lesson, goal: 'Changed after verification' }, evidence, { lessonsDir: join(temporary, 'rejected') }), /does not match/);
    assert.throws(() => verificationEvidence(lesson, { ...replay, ok: false }), /complete/);
    assert.throws(() => verificationEvidence(lesson, { ...replay, steps: [{ id: lesson.steps[0].id, status: 'skipped' }, replay.steps[1]] }), /complete/);
    assert.throws(() => validatePublishable({ ...lesson, id: '../outside' }), /safe/);
    assert.throws(() => validatePublishable({ ...lesson, id: 'index' }), /safe/);
    assert.throws(() => validatePublishable({ ...lesson, steps: [{ ...lesson.steps[0], target: { name: 'Zoom list. 100% selected.' } }] }), /state readout/);
  });
  await test('Failed re-verification invalidates the default prior success evidence', async () => {
    const reports = join(temporary, 'reports');
    const success = await recordVerification(lesson, replay, reports);
    assert.ok(success.evidenceFile);
    const failure = await recordVerification(lesson, { ...replay, ok: false }, reports);
    assert.equal(failure.evidenceFile, null);
    assert.deepEqual((await readdir(reports)).sort(), [`${lesson.id}.report.json`]);
  });
  await test('A thrown browser replay revokes prior proof before entering replay', async () => {
    const reports = join(temporary, 'thrown-reports');
    await recordVerification(lesson, replay, reports);
    await assert.rejects(runRecordedVerification(lesson, async () => {
      assert.ok(!(await readdir(reports)).some(file => file.endsWith('.verify.json')));
      throw new Error('Simulated navigation failure');
    }, reports), /navigation failure/);
    assert.deepEqual(await readdir(reports), [`${lesson.id}.report.json`]);
  });
  await test('Browser emitted no uncaught errors', () => assert.deepEqual(pageErrors, []));
} catch (error) {
  results.push({ name: 'Offline pipeline test runner completed', passed: false, error: error.message });
  console.error(error);
} finally {
  await browser?.close();
  if (server.listening) await new Promise(done => server.close(done));
  const safeRoot = resolve(tmpdir()) + sep;
  if (!resolve(temporary).startsWith(safeRoot) || !temporary.includes('bt-pipeline-')) throw new Error('Refusing to remove an unexpected test path.');
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(root, 'docs/pipeline-test-results.md'), [
    '# Offline pipeline handoff checks', '', `Run: ${new Date().toISOString()}`, '',
    `Browser: ${browserVersion}`, '',
    `Result: **${results.filter(result => result.passed).length}/${results.length} checks passed**.`, '',
    'The local browser observes and activates actual fixture controls. Production probe, diff, prune and descriptor generation produce a lesson; a fresh fixture replay checks its outcomes before a digest-bound verification record permits publication to a temporary lesson directory and index. The test reuses recorded narration prose and does not call a model, open Steel sessions, access Google accounts or modify external documents.', '',
    ...results.map(result => `- ${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ` — ${result.error.replace(/\n/g, ' ')}` : ''}`), '',
    `Uncaught page errors: ${pageErrors.length}.`, '',
    'The thrown-replay check deliberately injects a navigation exception into the recording wrapper to prove prior evidence is revoked before browser work begins. It is an exception-path test, not evidence of a live navigation failure.', '',
    'Run `node pipeline/tests.mjs` from the repository root, or `npm test` from pipeline after installing its locked dependencies. Set CHROME_PATH to a Chromium executable if installed Chrome is unavailable. No preview server or .env file is required.', '',
    'Scope: local mechanical authoring and publication handoff. Full model narration, authenticated Google Docs replay, cloud session behavior and the historical cached zoom descriptor are not certified by these checks.', '',
  ].join('\n'));
  console.log(`\n${results.filter(result => result.passed).length}/${results.length} offline pipeline checks passed.`);
  if (results.some(result => !result.passed)) process.exitCode = 1;
}
