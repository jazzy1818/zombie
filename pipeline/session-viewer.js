// Public viewer metadata only. CDP/websocket URLs and credentials never enter
// this contract. Steel documents debugUrl (not sessionViewerUrl) for iframes:
// https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions
export function embedViewerUrl(debugUrl) {
  if (typeof debugUrl !== 'string' || !debugUrl) return null;
  try {
    const url = new URL(debugUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.steel.dev'
      || url.port || url.username || url.password) return null;
    for (const name of url.searchParams.keys()) {
      if (/api.?key|token|auth|secret|password/i.test(name)) return null;
    }
    url.searchParams.set('interactive', 'false');
    return url.href;
  } catch { return null; }
}

export function createSessionViewer(onViewer) {
  let state = { status: 'starting', url: null };
  let ended = false;
  function update(next) {
    state = next;
    // Watching is optional. A consumer failure must not stop paid work or leak
    // its session by throwing before cleanup is installed.
    try { onViewer?.({ ...state }); } catch { /* viewer observer is optional */ }
    return { ...state };
  }
  update(state);
  return {
    get state() { return { ...state }; },
    ready(session) {
      if (ended) return { ...state };
      const url = embedViewerUrl(session?.debugUrl);
      return update({ status: url ? 'live' : 'unavailable', url,
        ...(typeof session?.id === 'string' ? { sessionId: session.id } : {}) });
    },
    unavailable() {
      if (ended) return { ...state };
      return update({ status: 'unavailable', url: null });
    },
    close() {
      if (ended) return { ...state };
      ended = true;
      return update({ ...state, status: state.sessionId ? 'closed' : 'unavailable', url: null });
    },
  };
}

// A later attempt must not be overwritten by a delayed callback from an older
// browser. Each begin call owns its own update function, including verification.
// Public job contract: { status, url: string|null, attempt, phase, sessionId? }.
// `live` means Steel supplied an active session embed, not iframe connectivity.
export function createJobViewer(job, { registerRecording } = {}) {
  let revision = 0;
  job.viewer = { status: 'starting', url: null, attempt: 1, phase: 'exploring' };
  job.viewerUrl = null;
  job.recordings ??= [];
  function retainRecording(state, local = false) {
    if (local || state.status !== 'closed' || !state.sessionId || !registerRecording) return;
    let recording = job.recordings.find(item => item.sessionId === state.sessionId);
    if (!recording) {
      recording = registerRecording({ sessionId: state.sessionId, attempt: state.attempt, phase: state.phase });
      if (recording) job.recordings.push(recording);
    }
    if (recording) state.recording = recording;
  }
  return {
    begin({ attempt, phase = 'exploring', local = false }) {
      const current = ++revision;
      const accept = state => {
        if (current !== revision) return;
        const status = local ? 'unavailable' : ['starting', 'live', 'closed', 'unavailable'].includes(state.status) ? state.status : 'unavailable';
        const url = status === 'live' ? embedViewerUrl(state.url) : null;
        job.viewer = { status: status === 'live' && !url ? 'unavailable' : status, url, attempt, phase,
          ...(typeof state.sessionId === 'string' ? { sessionId: state.sessionId } : {}) };
        job.viewerUrl = url;
        retainRecording(job.viewer, local);
      };
      accept({ status: local ? 'unavailable' : 'starting', url: null });
      return accept;
    },
    finish() {
      ++revision;
      const previous = job.viewer;
      job.viewer = { ...previous, status: previous.status === 'starting' ? 'unavailable'
        : previous.status === 'live' ? 'closed' : previous.status, url: null };
      job.viewerUrl = null;
      retainRecording(job.viewer);
    },
  };
}
