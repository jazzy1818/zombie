// Offline: loopback HTTP requests, fixture playlists/media, no Steel/model calls.
// node --test --test-isolation=none pipeline/session-replay-tests.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReplayService, recordingMediaUrl, rewritePlaylist } from './session-replay.js';
import { createJobViewer } from './session-viewer.js';

const sessionId = 'fixture-session';
const playlistUrl = `https://api.steel.dev/v1/sessions/${sessionId}/hls`;
const initUrl = 'https://fly.storage.tigris.dev/recordings/init.mp4?X-Amz-Signature=fixture-init';
const segmentUrl = 'https://fly.storage.tigris.dev/recordings/segment.m4s?X-Amz-Signature=fixture-media';
const playlist = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MAP:URI="${initUrl}"\n#EXTINF:4,\n${segmentUrl}\n#EXT-X-ENDLIST\n`;

async function fixture(options = {}) {
  const calls = [];
  let available = options.available ?? true;
  let clock = 100;
  const server = createServer(async (req, res) => {
    if (!await service.handle(req, res, new URL(req.url, origin))) { res.writeHead(404); res.end(); }
  });
  let origin;
  const service = createReplayService({
    apiKey: 'FIXTURE-STEEL-KEY', baseUrl: () => origin, now: () => clock, retainMs: 1000,
    fetchImpl: async (url, request) => {
      calls.push({ url, headers: request.headers });
      if (options.fetchImpl) return options.fetchImpl(url, request);
      if (url === playlistUrl) return available
        ? new Response(playlist, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
        : new Response('PRIVATE PROVIDER DETAIL', { status: 404 });
      assert.ok([initUrl, segmentUrl].includes(url));
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: request.headers.range ? 206 : 200,
        headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes',
          ...(request.headers.range ? { 'content-range': 'bytes 0-3/100' } : {}) },
      });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const recording = service.register({ sessionId, attempt: 1, phase: 'exploring' });
  return {
    service, recording, origin, calls, ready: () => { available = true; }, expire: () => { clock += 1000; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

test('replay URLs bind to one registered session and survive job terminal metadata', async () => {
  const f = await fixture();
  try {
    const job = {};
    const viewer = createJobViewer(job, { registerRecording: f.service.register });
    const first = viewer.begin({ attempt: 1 });
    first({ status: 'live', sessionId, url: `https://api.steel.dev/v1/sessions/${sessionId}/player` });
    first({ status: 'closed', sessionId, url: null });
    viewer.finish();
    assert.equal(job.viewerUrl, null);
    assert.equal(job.recordings.length, 1);
    assert.equal(job.recordings[0].url, f.recording.url);
    assert.match(f.recording.url, /^http:\/\/127\.0\.0\.1:\d+\/replays\/[a-f0-9]{48}\/player$/);
    assert.equal(f.service.register({ sessionId: '../unregistered' }), null);
  } finally { await f.close(); }
});

test('player and pinned HLS assets are served locally without API keys or external scripts', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.recording.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="recording" controls/);
    assert.match(html, /id="replay-retry"/);
    assert.match(html, /src="\.\/hls.js"/);
    assert.equal(html.includes('FIXTURE-STEEL-KEY'), false);
    assert.equal(html.includes('https://'), false);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    const script = await fetch(new URL('./hls.js', f.recording.url));
    assert.equal(script.status, 200);
    assert.ok((await script.text()).length > 100_000);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('manifest and media proxy keep Steel keys and signed upstream URLs server-side', async () => {
  const f = await fixture();
  try {
    const manifest = await fetch(new URL('./media/0', f.recording.url));
    const text = await manifest.text();
    assert.equal(manifest.status, 200);
    assert.match(text, /^#EXTM3U/);
    assert.equal(text.includes('steel.dev'), false);
    assert.equal(text.includes('tigris.dev'), false);
    assert.equal(text.includes('Signature'), false);
    assert.equal(text.includes('FIXTURE-STEEL-KEY'), false);
    const init = /URI="([^"]+)"/.exec(text)[1];
    const segment = text.split('\n').find(line => line.startsWith('/replays/'));
    assert.deepEqual(Array.from(new Uint8Array(await (await fetch(new URL(init, f.origin))).arrayBuffer())), [1, 2, 3, 4]);
    const media = await fetch(new URL(segment, f.origin), { headers: { range: 'bytes=0-3' } });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get('content-range'), 'bytes 0-3/100');
    await media.arrayBuffer();
    assert.equal(f.calls[0].headers['steel-api-key'], 'FIXTURE-STEEL-KEY');
    assert.equal(f.calls[1].headers['steel-api-key'], undefined);
    assert.equal(f.calls[2].headers['steel-api-key'], undefined);
    assert.equal(f.calls[2].headers.range, 'bytes=0-3');
  } finally { await f.close(); }
});

test('processing recordings can be retried using the same completed-session link', async () => {
  const f = await fixture({ available: false });
  try {
    const target = new URL('./media/0', f.recording.url);
    const initial = await fetch(target);
    assert.equal(initial.status, 425);
    assert.equal((await initial.text()).includes('PRIVATE PROVIDER DETAIL'), false);
    f.ready();
    const retry = await fetch(target);
    assert.equal(retry.status, 200);
    assert.match(await retry.text(), /#EXT-X-ENDLIST/);
  } finally { await f.close(); }
});

test('unregistered, expired, and arbitrary resource requests cannot use the provider key', async () => {
  const f = await fixture();
  try {
    for (const url of [f.origin + '/replays/' + '0'.repeat(48) + '/player', new URL('./media/999', f.recording.url)]) {
      assert.equal((await fetch(url)).status, 404);
    }
    assert.equal((await fetch(new URL('./media/0', f.recording.url), { method: 'POST' })).status, 405);
    assert.equal(f.calls.length, 0);
    f.expire();
    assert.equal((await fetch(f.recording.url)).status, 404);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('playlist URLs and redirects cannot escape the known recording hosts and session', async () => {
  for (const value of ['http://fly.storage.tigris.dev/video.mp4', 'https://localhost/video.mp4',
    'https://127.0.0.1/video.mp4', 'https://fly.storage.tigris.dev.attacker.test/video.mp4',
    'https://user:pass@fly.storage.tigris.dev/video.mp4', 'https://api.steel.dev/v1/sessions/other/hls',
    playlistUrl + '?apiKey=secret']) {
    assert.throws(() => recordingMediaUrl(value, sessionId));
  }
  assert.throws(() => rewritePlaylist('not ready', value => value));
  const f = await fixture({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.test/steal' } }) });
  try {
    const response = await fetch(new URL('./media/0', f.recording.url));
    assert.equal(response.status, 502);
    assert.equal(f.calls.length, 1);
    assert.equal((await response.text()).includes('attacker'), false);
  } finally { await f.close(); }
});

test('nested playlists and URI attributes are rewritten without corrupting HLS tags', () => {
  const source = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmain.m3u8\n';
  const found = [];
  const output = rewritePlaylist(source, value => { found.push(value); return `/local/${found.length}`; });
  assert.deepEqual(found, ['audio.m3u8', 'main.m3u8']);
  assert.match(output, /TYPE=AUDIO,URI="\/local\/1"/);
  assert.match(output, /BANDWIDTH=100\n\/local\/2/);
});
