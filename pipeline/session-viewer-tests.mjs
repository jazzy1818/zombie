// Offline lifecycle tests. Cloud browsers, model calls, replay, and lesson writes
// are test doubles; metadata handling and closeSession are production functions.
// Run from the repository root:
// node --test --test-isolation=none pipeline/session-viewer-tests.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { embedViewerUrl, createSessionViewer, createJobViewer } from './session-viewer.js';
import { closeSession } from './session.js';
import { runJob, cancelJob } from './bridge.js';
import { verifyLesson } from './verify.js';

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

function jobFixture({ results = [{ ok: true }], openError, exploreError, verifyError, verifyOk = true, saveError, anonymous = false, hooks = {} } = {}) {
  const job = { id: 'viewer-test', state: 'running', progress: [], abort: new AbortController(), handle: null };
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
    await hooks.open?.(options);
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
      await hooks.explore?.(_handle, options);
      if (exploreError) throw exploreError;
      return results[explorations++];
    },
    prune: trace => { snapshot('prune'); return trace; },
    uniqueId: async () => 'test-lesson',
    emit: async (_pruned, options) => {
      inputs.emit.push(options);
      snapshot('emit');
      await hooks.emit?.(options);
      return { id: 'test-lesson', app: options.app.id, steps: [{ id: 's1' }] };
    },
    verifyLesson: async (_lesson, options) => {
      inputs.verify.push(options);
      const handle = await open(options);
      try {
        options.onHandle?.(handle);
        snapshot('verify');
        await hooks.verify?.(handle, options);
        if (verifyError) throw verifyError;
        return { ok: verifyOk };
      } finally {
        await (options.releaseHandle ?? closeSession)(handle);
        options.onHandle?.(null);
      }
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

function pause() {
  let entered, resume;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const resumed = new Promise(resolve => { resume = resolve; });
  return { entered: enteredPromise, resume, wait: async () => { entered(); await resumed; } };
}

function assertCancelled(fixture) {
  assert.equal(fixture.job.state, 'cancelled');
  assert.equal(fixture.job.abort.signal.aborted, true);
  assert.equal(fixture.saved, false);
  assert.equal(fixture.job.lesson, undefined);
  assert.equal(fixture.job.viewerUrl, null);
  assert.notEqual(fixture.job.viewer.status, 'live');
  assert.notEqual(fixture.job.viewer.status, 'starting');
  assert.equal(fixture.job.handle, null);
  assert.equal(fixture.job.progress.some(item => /^(Saving|Done)/.test(item.text)), false);
}

test('cancellation before opening performs no authoring work and is idempotent', async () => {
  const fixture = jobFixture();
  assert.equal(await cancelJob(fixture.job, 'fixture cancelled'), true);
  assert.equal(await cancelJob(fixture.job, 'second cancellation'), false);
  await assert.rejects(runJob(fixture.job, { goal: 'fixture' }, fixture.services), { name: 'AbortError' });
  assertCancelled(fixture);
  assert.deepEqual(fixture.inputs.open, []);
  assert.equal(fixture.job.error, 'fixture cancelled');
});

test('cancellation during opening ignores late live metadata and releases the acquired session once', async () => {
  const gate = pause();
  const fixture = jobFixture({ hooks: { open: gate.wait } });
  const finished = assert.rejects(runJob(fixture.job, { goal: 'fixture' }, fixture.services), { name: 'AbortError' });
  await gate.entered;
  await cancelJob(fixture.job, 'fixture cancelled while opening');
  assert.equal(fixture.job.viewer.status, 'unavailable');
  const cancelledAt = fixture.snapshots.length;
  gate.resume();
  await finished;
  assertCancelled(fixture);
  assert.deepEqual(fixture.released, ['session-1']);
  assert.deepEqual(fixture.inputs.explore, []);
  assert.equal(fixture.snapshots.slice(cancelledAt).some(event => event.status === 'live' || event.viewerUrl), false);
  assert.deepEqual(fixture.job.recordings.map(item => item.sessionId), ['session-1']);
});

test('cancellation during exploration releases immediately, suppresses late progress, and never emits', async () => {
  const gate = pause();
  const fixture = jobFixture({ hooks: { explore: gate.wait } });
  const finished = assert.rejects(runJob(fixture.job, { goal: 'fixture' }, fixture.services), { name: 'AbortError' });
  await gate.entered;
  assert.equal(fixture.inputs.explore[0].signal, fixture.job.abort.signal);
  const cancellation = cancelJob(fixture.job, 'fixture cancelled while exploring');
  assert.equal(fixture.job.viewer.status, 'closed');
  assert.equal(fixture.job.viewerUrl, null);
  await cancellation;
  assert.deepEqual(fixture.released, ['session-1']);
  const progressCount = fixture.job.progress.length;
  fixture.inputs.explore[0].onStep({ phase: 'reached' });
  assert.equal(fixture.job.progress.length, progressCount);
  gate.resume();
  await finished;
  assertCancelled(fixture);
  assert.deepEqual(fixture.inputs.emit, []);
  assert.deepEqual(fixture.released, ['session-1']);
  assert.equal(fixture.job.recordings.length, 1);
});

test('cancellation during lesson writing cannot start verification, save, or become done', async () => {
  const gate = pause();
  const fixture = jobFixture({ hooks: { emit: gate.wait } });
  const finished = assert.rejects(runJob(fixture.job, { goal: 'fixture', verify: true }, fixture.services), { name: 'AbortError' });
  await gate.entered;
  await cancelJob(fixture.job, 'fixture cancelled while writing');
  gate.resume();
  await finished;
  assertCancelled(fixture);
  assert.deepEqual(fixture.inputs.verify, []);
  assert.deepEqual(fixture.released, ['session-1']);
});

test('cancellation during a successful verification releases its separate browser and cannot publish', async () => {
  const gate = pause();
  const fixture = jobFixture({ hooks: { verify: gate.wait } });
  const finished = assert.rejects(runJob(fixture.job, { goal: 'fixture', verify: true }, fixture.services), { name: 'AbortError' });
  await gate.entered;
  assert.equal(fixture.job.handle.session.id, 'session-2');
  assert.equal(fixture.inputs.verify[0].signal, fixture.job.abort.signal);
  await cancelJob(fixture.job, 'fixture cancelled while verifying');
  assert.deepEqual(fixture.released, ['session-1', 'session-2']);
  assert.equal(fixture.job.viewer.phase, 'verifying');
  assert.equal(fixture.job.viewer.status, 'closed');
  gate.resume();
  await finished;
  assertCancelled(fixture);
  assert.deepEqual(fixture.released, ['session-1', 'session-2']);
  assert.deepEqual(fixture.job.recordings.map(item => item.phase), ['exploring', 'verifying']);
});

// These exercise the production verifier with only browser/session I/O replaced.
// A delayed probe deliberately succeeds after abort to catch accidental clicks or
// a false successful report from an already cancelled replay.
for (const phase of ['opening', 'navigation', 'resolve', 'check']) {
  test(`production verification cancels during ${phase} without later actions or a successful report`, async () => {
    const gate = pause();
    const abort = new AbortController();
    const owned = [];
    const actions = [];
    let releases = 0;
    const handle = {
      viewerUrl: 'fixture viewer',
      page: {
        goto: async () => { actions.push('navigate'); if (phase === 'navigation') await gate.wait(); },
        evaluate: async () => '1280x720',
        waitForTimeout: async () => {},
        click: async () => { actions.push('click'); },
      },
      probe: async kind => {
        actions.push(kind);
        if (phase === kind) await gate.wait();
        return kind === 'resolve' ? { id: 'fixture-target', count: 1 } : true;
      },
    };
    const finished = assert.rejects(verifyLesson({
      id: 'cancel-fixture', app: 'github',
      steps: [{ id: 'first', target: { name: 'Watch' }, verify: { kind: 'dom', selector: '#result' } }],
    }, {
      docUrl: 'https://github.com/example/repo', signal: abort.signal,
      keepOpen: true, // cancellation must still release even with this CLI option
      onHandle: value => { owned.push(value); },
    }, {
      openExploreSession: async () => { if (phase === 'opening') await gate.wait(); return handle; },
      closeSession: async () => { releases++; },
      waitForApp: async () => {}, whoami: async () => null,
    }), { name: 'AbortError' });
    await gate.entered;
    abort.abort();
    // Allow the abort listener's cleanup promise to settle while browser I/O is
    // still paused. An opening session cannot be released until it is acquired.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases, phase === 'opening' ? 0 : 1);
    const actionsAtAbort = [...actions];
    gate.resume();
    await finished;
    assert.deepEqual(actions, actionsAtAbort);
    assert.equal(releases, 1);
    assert.deepEqual(owned, [handle, null]);
  });
}
