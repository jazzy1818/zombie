// Real Chromium + production HLS/player/proxy, with synthetic local MP4 media.
// No Steel, model, credentials, or user documents are accessed.
// node --test --test-isolation=none pipeline/replay-player-tests.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createReplayService } from './session-replay.js';

let browser;
let server;
let service;
let origin;
let init;
let fragment;
const cases = new Map();
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(20); }
  throw new Error(message);
}
async function untilWithClock(page, check, message) {
  // HLS schedules segment loading on its own small interval. Advance the real
  // production scheduler while waiting for asynchronous HTTP/media events.
  await until(async () => { await page.clock.runFor(100); return check(); }, message);
}
async function syntheticVideo() {
  // 1.4s of solid blue, created locally with FFmpeg (no captured/user content):
  // ffmpeg -f lavfi -i color=c=blue:s=64x64:r=10 -t 1.4 -c:v libx264
  //   -preset ultrafast -tune zerolatency -pix_fmt yuv420p
  //   -movflags empty_moov+default_base_moof+frag_keyframe -an replay-fixture.mp4
  const mp4 = Buffer.from(await readFile(new URL('./replay-fixture.b64', import.meta.url), 'utf8'), 'base64');
  let offset = 0;
  while (offset + 8 <= mp4.length) {
    const size = mp4.readUInt32BE(offset);
    const type = mp4.toString('ascii', offset + 4, offset + 8);
    if (type === 'moof') break;
    assert.ok(size >= 8, 'synthetic MP4 boxes have valid sizes');
    offset += size;
  }
  assert.ok(offset > 0 && offset < mp4.length, 'synthetic MP4 includes initialization and media fragments');
  init = mp4.subarray(0, offset);
  fragment = mp4.subarray(offset);
}

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? process.env.BROWSER_EXECUTABLE ?? fileURLToPath(new URL('../docs/.paint-artifacts/browsers/chromium-1234/chrome-win64/chrome.exe', import.meta.url)),
    headless: true,
  });
  await syntheticVideo();
  service = createReplayService({ apiKey: 'FIXTURE-KEY', baseUrl: () => origin, fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    const id = parsed.hostname === 'api.steel.dev' ? parsed.pathname.split('/')[3] : parsed.pathname.split('/')[1];
    const fixture = cases.get(id);
    assert.ok(fixture, 'every media request belongs to a registered fixture');
    if (parsed.hostname === 'api.steel.dev') {
      fixture.requests++;
      if (fixture.hang) {
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
          fixture.aborted++;
          reject(new Error('fixture request aborted'));
        }, { once: true }));
      }
      if (fixture.requests <= fixture.failures) return new Response('processing', { status: 404 });
      return new Response(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="https://fly.storage.tigris.dev/${id}/init.mp4"\n#EXTINF:1.4,\nhttps://fly.storage.tigris.dev/${id}/segment.m4s\n#EXT-X-ENDLIST\n`, {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (parsed.pathname.endsWith('segment.m4s')) {
      fixture.mediaRequests++;
      if (fixture.fragmentUnavailable) return new Response('processing', { status: 404 });
    }
    return new Response(parsed.pathname.endsWith('init.mp4') ? init : fragment, { headers: { 'content-type': 'video/mp4' } });
  } });
  server = createServer(async (req, res) => {
    if (!await service.handle(req, res, new URL(req.url, origin))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  console.log(JSON.stringify({ browserVersion: browser?.version(), syntheticVideo: '64x64 MP4, generated locally', passed: results }));
  await browser?.close();
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
});

async function fixture(id, options = {}) {
  const state = { requests: 0, aborted: 0, failures: 0, mediaRequests: 0, hang: false, ...options };
  cases.set(id, state);
  const recording = service.register({ sessionId: id, attempt: 1, phase: 'exploring' });
  const page = await browser.newPage();
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await page.goto(recording.url);
  return { page, state };
}
const isWaiting = page => page.evaluate(() => document.body.dataset.playback === 'loading' &&
  document.querySelector('#replay-status').textContent.includes('automatically'));
async function advanceToFailure(page, state, delay, expectedRequests) {
  await page.clock.fastForward(delay);
  await until(() => state.requests === expectedRequests, 'expected playback request');
  await until(() => isWaiting(page), 'player automatically waits after processing response');
}

test('new recording waits briefly, then automatically recovers from processing and decodes video', async () => {
  const { page, state } = await fixture('recovers', { failures: 1 });
  try {
    assert.equal(state.requests, 0);
    assert.equal(await isWaiting(page), true);
    assert.equal(await page.locator('#replay-retry').isHidden(), true);
    await page.clock.fastForward(1499);
    assert.equal(state.requests, 0);
    await advanceToFailure(page, state, 1, 1);
    await page.clock.fastForward(1500);
    await untilWithClock(page, () => page.evaluate(() => document.querySelector('video').readyState >= 2), 'automatic retry loads actual video');
    const video = await page.evaluate(() => ({ width: document.querySelector('video').videoWidth,
      height: document.querySelector('video').videoHeight, state: document.body.dataset.playback }));
    assert.deepEqual(video, { width: 64, height: 64, state: 'ready' });
    assert.equal(state.requests, 2);
    await page.clock.fastForward(60000);
    assert.equal(state.requests, 2, 'ready playback cancels retry/watchdog timers');
    results.push('initial wait and automatic recovery with decoded media');
  } finally { await page.close(); }
});

test('persistent processing stops after five attempts and manual Retry starts a fresh working attempt', async () => {
  const { page, state } = await fixture('persistent', { failures: 99 });
  try {
    await advanceToFailure(page, state, 1500, 1);
    await advanceToFailure(page, state, 1500, 2);
    await advanceToFailure(page, state, 2500, 3);
    await advanceToFailure(page, state, 4000, 4);
    await page.clock.fastForward(6000);
    await until(() => page.locator('#replay-retry').isVisible(), 'manual Retry appears after bounded attempts');
    assert.equal(state.requests, 5);
    await page.clock.fastForward(120000);
    assert.equal(state.requests, 5, 'persistent failure does not retry forever');
    state.failures = 0;
    await page.locator('#replay-retry').click();
    await untilWithClock(page, () => page.evaluate(() => document.querySelector('video').readyState >= 2), 'manual retry can recover later');
    assert.equal(state.requests, 6);
    assert.equal(await page.locator('#replay-retry').isHidden(), true);
    results.push('bounded persistent failure and working manual retry');
  } finally { await page.close(); }
});

test('available metadata does not end automatic recovery while media fragments are still processing', async () => {
  const { page, state } = await fixture('fragments-processing', { fragmentUnavailable: true });
  try {
    await page.clock.fastForward(1500);
    await untilWithClock(page, () => state.mediaRequests > 0, 'manifest and initialization reached the media request');
    assert.equal(await page.locator('#replay-retry').isHidden(), true);
    assert.equal(await page.evaluate(() => document.body.dataset.playback), 'loading');
    assert.ok(await page.evaluate(() => document.querySelector('video').readyState < 2));
    await page.clock.fastForward(10000);
    await until(() => isWaiting(page), 'missing playable media remains eligible for automatic retry');
    state.fragmentUnavailable = false;
    await page.clock.fastForward(1500);
    await untilWithClock(page, () => page.evaluate(() => document.querySelector('video').readyState >= 2), 'later playable fragments recover automatically');
    assert.equal(state.requests, 2);
    assert.equal(await page.locator('#replay-retry').isHidden(), true);
    results.push('metadata alone does not prematurely disable processing recovery');
  } finally { await page.close(); }
});

test('a stalled initial load respects the overall retry deadline', async () => {
  const { page, state } = await fixture('deadline', { hang: true });
  try {
    await page.clock.fastForward(1500);
    await until(() => state.requests === 1, 'stalled manifest request starts');
    await page.clock.fastForward(45000);
    await until(() => page.locator('#replay-retry').isVisible(), 'global startup deadline reveals manual Retry');
    await until(() => state.aborted === 1, 'deadline aborts stalled request');
    const requests = state.requests;
    await page.clock.fastForward(120000);
    assert.equal(state.requests, requests);
    assert.ok(requests <= 5);
    results.push('global retry deadline aborts stalled startup and stops requests');
  } finally { await page.close(); }
});

test('pagehide cancels both initial waiting and queued automatic retries', async () => {
  for (const afterFailure of [false, true]) {
    const { page, state } = await fixture(`cancel-${afterFailure}`, { failures: 99 });
    try {
      if (afterFailure) await advanceToFailure(page, state, 1500, 1);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      const previous = state.requests;
      await page.clock.fastForward(120000);
      await sleep(100);
      assert.equal(state.requests, previous);
    } finally { await page.close(); }
  }
  results.push('pagehide cancels initial wait and retry backoff');
});

test('pagehide aborts an in-flight manifest and prevents later attempts', async () => {
  const { page, state } = await fixture('abort-request', { hang: true });
  try {
    await page.clock.fastForward(1500);
    await until(() => state.requests === 1, 'manifest request starts');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await until(() => state.aborted === 1, 'pagehide aborts active manifest request');
    await page.clock.fastForward(120000);
    assert.equal(state.requests, 1);
    results.push('pagehide aborts active request and prevents stale work');
  } finally { await page.close(); }
});
