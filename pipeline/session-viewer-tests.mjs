// Offline lifecycle tests. Cloud browsers, model calls, replay, and lesson writes
// are test doubles; metadata handling and closeSession are production functions.
// Run from the repository root:
// node --test --test-isolation=none pipeline/session-viewer-tests.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { embedViewerUrl, createSessionViewer, createJobViewer } from './session-viewer.js';
import { closeSession } from './session.js';
import { runJob } from './bridge.js';

const debugUrl = id => `https://api.steel.dev/v1/sessions/${id}/player`;
const publicSession = id => ({
  id, debugUrl: debugUrl(id),
  sessionViewerUrl: `https://app.steel.dev/sessions/${id}`,
  websocketUrl: 'wss://not-for-the-viewer.invalid/?apiKey=TEST-SECRET',
});

test('debug URLs preserve display options and force a watch-only iframe', () => {
  assert.equal(embedViewerUrl(`${debugUrl('s1')}?theme=dark&interactive=true`),
    `${debugUrl('s1')}?theme=dark&interactive=false`);
  assert.equal(embedViewerUrl(debugUrl('s1')), `${debugUrl('s1')}?interactive=false`);
});

test('viewer URLs reject untrusted hosts, credentials, and API-key queries', () => {
  const rejected = [
    undefined, '', 'invalid', 'javascript:alert(1)',
    'http://api.steel.dev/v1/sessions/s1/player',
    'https://api.steel.dev:8443/v1/sessions/s1/player',
    'https://app.steel.dev/sessions/s1',
    'https://other.steel.dev/v1/sessions/s1/player',
    'https://api.steel.dev.example.com/v1/sessions/s1/player',
    'https://user:pass@api.steel.dev/v1/sessions/s1/player',
    ...['apiKey', 'API_KEY', 'api-key', 'token', 'access_token', 'auth', 'authorization', 'secret', 'password']
      .map(name => `${debugUrl('s1')}?${name}=TEST-SECRET`),
  ];
  for (const value of rejected) assert.equal(embedViewerUrl(value), null, String(value));
});

test('session lifecycle advertises only debugUrl and never revives after close', () => {
  const events = [];
  const viewer = createSessionViewer(state => events.push(state));
  viewer.ready(publicSession('s1'));
  assert.deepEqual(viewer.state, { status: 'live', url: `${debugUrl('s1')}?interactive=false`, sessionId: 's1' });
  viewer.close();
  viewer.close();
  viewer.ready(publicSession('late'));
  assert.deepEqual(events.map(state => state.status), ['starting', 'live', 'closed']);
  assert.equal(viewer.state.url, null);
  assert.equal(JSON.stringify(events).includes('TEST-SECRET'), false);
  assert.equal(JSON.stringify(events).includes('app.steel.dev'), false);
});

test('missing debugUrl is unavailable instead of falling back to the dashboard', () => {
  const viewer = createSessionViewer();
  viewer.ready({ id: 's1', sessionViewerUrl: 'https://app.steel.dev/sessions/s1' });
  assert.equal(viewer.state.status, 'unavailable');
  assert.equal(viewer.state.url, null);
  viewer.close();
  assert.equal(viewer.state.status, 'closed');
});

test('a broken observer cannot stop session cleanup', async () => {
  const calls = [];
  const viewer = createSessionViewer(() => { throw new Error('UI unavailable'); });
  viewer.ready(publicSession('s1'));
  await closeSession({
    viewer, session: { id: 's1' },
    browser: { close: async () => { calls.push('disconnect'); throw new Error('gone'); } },
    steel: { sessions: { release: async id => { calls.push(`release ${id}`); throw new Error('gone'); } } },
  });
  assert.deepEqual(calls, ['disconnect', 'release s1']);
  assert.equal(viewer.state.status, 'closed');
  assert.equal(viewer.state.url, null);
});

test('job attempt changes clear stale links and ignore delayed previous callbacks', () => {
  const job = {};
  const viewer = createJobViewer(job);
  const first = viewer.begin({ attempt: 1 });
  first({ status: 'live', url: debugUrl('first'), sessionId: 'first' });
  assert.ok(job.viewerUrl);
  const second = viewer.begin({ attempt: 2, phase: 'verifying' });
  assert.equal(job.viewerUrl, null);
  first({ status: 'closed', url: null, sessionId: 'first' });
  assert.equal(job.viewer.status, 'starting');
  assert.equal(job.viewer.attempt, 2);
  second({ status: 'live', url: debugUrl('second'), sessionId: 'second' });
  assert.equal(job.viewer.phase, 'verifying');
  viewer.finish();
  second({ status: 'live', url: debugUrl('late') });
  assert.equal(job.viewer.status, 'closed');
  assert.equal(job.viewerUrl, null);
});

test('local job metadata always remains unavailable', async () => {
  const job = {};
  const viewer = createJobViewer(job);
  const onViewer = viewer.begin({ attempt: 1, local: true });
  const local = createSessionViewer(onViewer);
  local.ready(publicSession('unexpected'));
  assert.equal(job.viewer.status, 'unavailable');
  assert.equal(job.viewerUrl, null);
  let disconnected = false;
  await closeSession({ local: true, viewer: local, browser: { close: async () => { disconnected = true; } } });
  viewer.finish();
  assert.equal(disconnected, true);
  assert.equal(job.viewer.status, 'unavailable');
});

function jobFixture({ results = [{ ok: true }], openError, exploreError, verifyError, verifyOk = true, saveError, anonymous = false } = {}) {
  const job = { id: 'viewer-test', state: 'running', progress: [] };
  const snapshots = [];
  const released = [];
  const inputs = { open: [], explore: [], emit: [], verify: [] };
  let serial = 0;
  let explorations = 0;
  let saved = false;
  const snapshot = stage => snapshots.push({ stage, ...job.viewer, viewerUrl: job.viewerUrl });
  async function open(options) {
    const { onViewer } = options;
    inputs.open.push(options);
    snapshot('opening');
    if (openError) throw openError;
    const session = publicSession(`session-${++serial}`);
    const viewer = createSessionViewer(state => { onViewer(state); snapshot('viewer'); });
    viewer.ready(session);
    return {
      viewer, session, anonymous, browser: { close: async () => {} },
      steel: { sessions: { release: async id => { released.push(id); } } },
    };
  }
  const services = {
    openExploreSession: open,
    closeSession,
    explore: async (_handle, options) => {
      inputs.explore.push(options);
      snapshot('explore');
      if (exploreError) throw exploreError;
      return results[explorations++];
    },
    prune: trace => { snapshot('prune'); return trace; },
    uniqueId: async () => 'test-lesson',
    emit: async (_pruned, options) => {
      inputs.emit.push(options);
      snapshot('emit');
      return { id: 'test-lesson', app: options.app.id, steps: [{ id: 's1' }] };
    },
    verifyLesson: async (_lesson, options) => {
      inputs.verify.push(options);
      const handle = await open(options);
      try {
        snapshot('verify');
        if (verifyError) throw verifyError;
        return { ok: verifyOk };
      } finally { await closeSession(handle); }
    },
    saveLesson: async () => {
      snapshot('save');
      if (saveError) throw saveError;
      saved = true;
    },
  };
  return { job, snapshots, released, inputs, services, get saved() { return saved; } };
}

test('bridge preserves selected app and auth mode through authoring and replay metadata', async () => {
  for (const [docUrl, appId, auth] of [
    ['https://github.com/example/repo', 'github', 'none'],
    ['https://builder.example/dashboard', 'builder.example', 'required'],
  ]) {
    const fixture = jobFixture({ anonymous: auth === 'none' });
    await runJob(fixture.job, { goal: 'fixture', docUrl, auth, verify: true }, fixture.services);
    assert.equal(fixture.job.app, appId);
    assert.equal(fixture.job.lesson.app, appId);
    assert.equal(fixture.job.anonymous, auth === 'none');
    assert.ok(fixture.inputs.open.every(options => options.app.id === appId && options.auth === auth));
    assert.equal(fixture.inputs.explore[0].app.id, appId);
    assert.equal(fixture.inputs.explore[0].docUrl, docUrl);
    assert.equal(fixture.inputs.emit[0].app.id, appId);
    assert.equal(fixture.inputs.verify[0].app.id, appId);
    assert.equal(fixture.inputs.verify[0].auth, auth);
    assert.equal(fixture.job.recordings.length, 2);
    assert.equal(fixture.job.viewerUrl, null);
  }
});

test('bridge retries and fresh verification expose distinct live browsers then clear links', async () => {
  const fixture = jobFixture({ results: [{ ok: false, reason: 'fixture retry' }, { ok: true }] });
  await runJob(fixture.job, { goal: 'fixture', docUrl: 'https://example.invalid', verify: true }, fixture.services);
  const active = fixture.snapshots.filter(event => ['explore', 'verify'].includes(event.stage));
  assert.deepEqual(active.map(event => [event.status, event.attempt, event.phase, event.sessionId]), [
    ['live', 1, 'exploring', 'session-1'],
    ['live', 2, 'exploring', 'session-2'],
    ['live', 3, 'verifying', 'session-3'],
  ]);
  for (const event of fixture.snapshots.filter(event => event.stage === 'opening')) {
    assert.equal(event.status, 'starting');
    assert.equal(event.url, null);
  }
  for (const event of fixture.snapshots.filter(event => ['prune', 'emit', 'save'].includes(event.stage))) {
    assert.equal(event.status, 'closed');
    assert.equal(event.viewerUrl, null);
  }
  assert.deepEqual(fixture.released, ['session-1', 'session-2', 'session-3']);
  assert.equal(fixture.job.state, 'done');
  assert.equal(fixture.saved, true);
  assert.equal(fixture.job.viewer.status, 'closed');
  assert.equal(fixture.job.viewerUrl, null);
  assert.deepEqual(fixture.job.recordings.map(item => [item.sessionId, item.attempt, item.phase]), [
    ['session-1', 1, 'exploring'], ['session-2', 2, 'exploring'], ['session-3', 3, 'verifying'],
  ]);
  assert.equal(fixture.job.viewer.recording, fixture.job.recordings[2]);
  assert.match(fixture.job.recordings[0].url, /^http:\/\/127\.0\.0\.1:\d+\/replays\/[a-f0-9]{48}\/player$/);
});

test('bridge opener failure terminates starting metadata without a stale URL', async () => {
  const fixture = jobFixture({ openError: new Error('fixture opener failed') });
  await assert.rejects(runJob(fixture.job, { goal: 'fixture' }, fixture.services), /fixture opener failed/);
  assert.equal(fixture.job.viewer.status, 'unavailable');
  assert.equal(fixture.job.viewerUrl, null);
  assert.equal(fixture.saved, false);
  assert.deepEqual(fixture.job.recordings, []);
});

test('bridge exploration errors close the active session and clear its viewer', async () => {
  const fixture = jobFixture({ exploreError: new Error('fixture exploration failed') });
  await assert.rejects(runJob(fixture.job, { goal: 'fixture' }, fixture.services), /fixture exploration failed/);
  assert.deepEqual(fixture.released, ['session-1']);
  assert.equal(fixture.job.viewer.status, 'closed');
  assert.equal(fixture.job.viewerUrl, null);
  assert.equal(fixture.saved, false);
});

test('bridge verification errors clear the fresh viewer and do not save', async () => {
  for (const config of [{ verifyError: new Error('fixture replay failed') }, { verifyOk: false }]) {
    const fixture = jobFixture(config);
    await assert.rejects(runJob(fixture.job, { goal: 'fixture', verify: true }, fixture.services));
    assert.deepEqual(fixture.released, ['session-1', 'session-2']);
    assert.equal(fixture.job.viewer.phase, 'verifying');
    assert.equal(fixture.job.viewer.status, 'closed');
    assert.equal(fixture.job.viewerUrl, null);
    assert.equal(fixture.saved, false);
  }
});

test('bridge save failure cannot leave the completed exploration viewer live', async () => {
  const fixture = jobFixture({ saveError: new Error('fixture save failed') });
  await assert.rejects(runJob(fixture.job, { goal: 'fixture' }, fixture.services), /fixture save failed/);
  assert.equal(fixture.job.viewer.status, 'closed');
  assert.equal(fixture.job.viewerUrl, null);
  assert.equal(fixture.saved, false);
});
