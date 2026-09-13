import { makeFloating } from './floating.js';
import { bridgeOrigin } from './generate.js';
import { watchNavigation } from '../paint/navigation.js';

const LIVE_RETRY_DELAYS = [1500, 3000, 5000];
const LIVE_READY_TIMEOUT = 15_000;

// debugUrl is Steel's embeddable player. Dashboard links require a login, and
// websocket URLs contain credentials that must never reach an iframe.
export function cloudPlayerUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'api.steel.dev' ||
        url.port || url.username || url.password) return null;
    for (const key of url.searchParams.keys()) {
      if (/api.?key|token|auth|secret|password/i.test(key)) return null;
    }
    url.searchParams.set('interactive', 'false');
    return url.href;
  } catch { return null; }
}

// The bridge serves a local replay player and authenticates Steel requests on
// the server. Only its own opaque recording routes may become replay iframes.
export function cloudRecordingUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const bridge = new URL(bridgeOrigin);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.port !== bridge.port || url.username || url.password || url.search || url.hash
      || !/^\/replays\/[a-f0-9]{48}\/player$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

/** One viewer per panel. Opening/minimizing never creates or releases a job. */
export function createCloudViewer(root, raise) {
  const win = document.createElement('section');
  win.id = 'bt-cloud-window';
  win.className = 'bt-cloud-window';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'Cloud browser');
  win.hidden = true;
  win.innerHTML = `
    <header class="bt-head">
      <span class="bt-grip" aria-hidden="true"></span>
      <span class="bt-title">Cloud browser</span>
      <span class="bt-cloud-status" role="status"></span>
      <button class="bt-cloud-minimize" type="button" aria-label="Minimize cloud browser" title="Minimize cloud browser">−</button>
    </header>
    <div class="bt-cloud-session-wrap" hidden>
      <label>Session <select class="bt-cloud-session" aria-label="Browser session"></select></label>
    </div>
    <div class="bt-cloud-screen">
      <p class="bt-cloud-message" role="status"></p>
    </div>
    <footer class="bt-cloud-footer">
      <span class="bt-cloud-caption">This window is view only. The AI keeps working when minimized.</span>
      <button class="bt-cloud-retry" type="button" hidden>Retry live view</button>
      <a class="bt-cloud-external" target="_blank" rel="noopener noreferrer" hidden>Open Steel player in a tab ↗</a>
    </footer>
    <div class="bt-resize" title="Drag to resize"></div>
  `;
  const screen = win.querySelector('.bt-cloud-screen');
  const message = win.querySelector('.bt-cloud-message');
  const status = win.querySelector('.bt-cloud-status');
  const minimizeButton = win.querySelector('.bt-cloud-minimize');
  const external = win.querySelector('.bt-cloud-external');
  const caption = win.querySelector('.bt-cloud-caption');
  const retryButton = win.querySelector('.bt-cloud-retry');
  const sessionWrap = win.querySelector('.bt-cloud-session-wrap');
  const sessionPicker = win.querySelector('.bt-cloud-session');
  const history = document.createElement('button');
  history.type = 'button';
  history.className = 'bt-cloud-history';
  history.textContent = 'Watch recording';
  history.setAttribute('aria-controls', win.id);
  history.setAttribute('aria-haspopup', 'dialog');
  history.addEventListener('mousedown', event => event.preventDefault());
  history.addEventListener('click', () => {
    selection = recordings.at(-1)?.sessionId || 'current';
    open();
  });
  const floating = makeFloating(win, {
    handle: win.querySelector('.bt-head'), resizer: win.querySelector('.bt-resize'),
  });
  let trigger = null;
  let viewer = { status: 'starting', url: null };
  let frame = null;
  let frameUrl = null;
  let frameReady = false;
  let frameEnded = false;
  let playbackLabel = 'Connecting';
  let receivePlayback = null;
  let opened = false;
  let placed = false;
  let restoreFocus = false;
  let recordings = [];
  let selection = 'current';
  let stopHistoryNavigation = null;
  let liveRetryTimer = null;
  let liveReadyTimer = null;
  let liveRetryCount = 0;
  let liveRetryUrl = null;

  const recordingLabel = item => item.phase === 'verifying'
    ? `Verification · Session ${item.attempt}` : `Attempt ${item.attempt}`;

  function syncHistory() {
    if (recordings.length) {
      if (!history.isConnected) root.appendChild(history);
      // The lesson's own navigation watcher ends when its runner finishes.
      // Keep completed-session UI scoped to this webpage as well.
      stopHistoryNavigation ||= watchNavigation(() => api.reset({ forgetRecordings: true }));
      history.setAttribute('aria-expanded', String(opened));
    } else {
      history.remove();
      stopHistoryNavigation?.();
      stopHistoryNavigation = null;
    }
    const options = [
      { value: 'current', text: viewer.status === 'live' ? `Live browser · Attempt ${viewer.attempt || 1}` : 'Latest recording' },
      ...recordings.map(item => ({ value: item.sessionId, text: `${recordingLabel(item)} · Recording` })),
    ];
    // Rebuilding a focused select on every poll interrupts keyboard selection.
    const signature = JSON.stringify(options);
    if (sessionPicker.dataset.options !== signature) {
      sessionPicker.replaceChildren(...options.map(item => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.text;
        return option;
      }));
      sessionPicker.dataset.options = signature;
    }
    sessionPicker.value = selection;
    sessionWrap.hidden = recordings.length < 2 && !(recordings.length && viewer.status === 'live');
  }

  sessionPicker.addEventListener('change', () => {
    selection = sessionPicker.value;
    render();
  });

  function hideRetry() {
    if (root.activeElement === retryButton) minimizeButton.focus({ preventScroll: true });
    retryButton.hidden = true;
  }

  function unload() {
    clearTimeout(liveRetryTimer);
    clearTimeout(liveReadyTimer);
    liveRetryTimer = null;
    liveReadyTimer = null;
    hideRetry();
    if (receivePlayback) window.removeEventListener('message', receivePlayback);
    receivePlayback = null;
    frame?.remove();
    frame = null;
    frameUrl = null;
    frameReady = false;
    frameEnded = false;
    playbackLabel = 'Connecting';
  }

  function retryLive(current) {
    if (frame !== current || frameEnded || !opened || viewer.status !== 'live' || selection !== 'current') return;
    clearTimeout(liveReadyTimer);
    liveReadyTimer = null;
    if (liveRetryTimer !== null) return;
    retryButton.hidden = false;
    if (liveRetryCount >= LIVE_RETRY_DELAYS.length) {
      playbackLabel = 'Playback unavailable';
      message.hidden = false;
      message.textContent = 'The live stream could not connect. Retry the live view here, or open the Steel player in a tab below.';
      render();
      return;
    }
    const source = frameUrl;
    playbackLabel = 'Reconnecting';
    message.hidden = false;
    message.textContent = 'The live stream is not ready yet. Reconnecting automatically…';
    liveRetryTimer = setTimeout(() => {
      liveRetryTimer = null;
      if (frame !== current || frameEnded || !opened || selection !== 'current' || viewer.status !== 'live' || viewer.url !== source) return;
      liveRetryCount++;
      unload();
      render();
    }, LIVE_RETRY_DELAYS[liveRetryCount]);
    render();
  }

  retryButton.addEventListener('mousedown', event => event.preventDefault());
  retryButton.addEventListener('click', () => {
    if (viewer.status !== 'live' || selection !== 'current') return;
    liveRetryCount = 0;
    unload();
    render();
    minimizeButton.focus({ preventScroll: true });
  });

  function render() {
    const recording = selection === 'current'
      ? (viewer.status === 'live' && viewer.url ? null : recordings.at(-1))
      : recordings.find(item => item.sessionId === selection);
    const live = !recording && viewer.status === 'live' && viewer.url;
    const source = recording?.url || (live ? viewer.url : null);
    syncHistory();
    const retry = viewer.attempt > 1;
    if (trigger) {
      // This row follows the AI. Reviewing an older recording must not turn
      // the route back to the current live browser into another history link.
      trigger.textContent = viewer.status === 'live' && viewer.url ? 'Watch cloud browser' : viewer.status === 'starting'
        ? (retry ? 'Opening another cloud browser…' : 'Opening a cloud browser…')
        : recordings.length ? 'Watch recording'
        : viewer.status === 'closed' ? 'Cloud browser finished — view status'
        : 'Cloud browser viewer unavailable';
      trigger.setAttribute('aria-expanded', String(opened));
    }
    status.textContent = recording ? 'Recording' : live ? (opened && !frameReady ? playbackLabel
      : viewer.phase === 'verifying' ? 'Live · Verifying' : 'Live')
      : viewer.status === 'starting' ? 'Connecting' : viewer.status === 'closed' ? 'Closed' : 'Unavailable';
    status.classList.toggle('is-live', Boolean(live && (!opened || frameReady)));
    caption.textContent = recording
      ? 'Session finished. Play, pause or seek through its recording.'
      : 'This window is view only. The AI keeps working when minimized.';
    external.textContent = recording ? 'Open session in Steel ↗' : 'Open Steel player in a tab ↗';
    external.hidden = !source;
    if (recording) external.href = `https://app.steel.dev/sessions/${encodeURIComponent(recording.sessionId)}`;
    else if (live) external.href = viewer.url;
    else external.removeAttribute('href');
    if (!opened) return;

    if (!source) {
      unload();
      message.hidden = false;
      message.textContent = viewer.status === 'starting'
        ? 'Waiting for the cloud browser to open. Its live view will appear here automatically.'
        : viewer.status === 'closed'
          ? 'This cloud browser has closed. The AI is finishing your lesson or preparing its next browser.'
          : viewer.reason === 'disconnected'
            ? 'Connection to the lesson service was lost. The live view will reconnect when the service responds.'
            : 'A live view is not available for this session. You can still follow the progress in Browser Teacher.';
      return;
    }
    if (frameUrl === source) return; // Polls must not restart the stream.
    unload();
    if (liveRetryUrl !== (live ? source : null)) {
      liveRetryUrl = live ? source : null;
      liveRetryCount = 0;
    }
    message.hidden = false;
    message.textContent = recording ? 'Opening the session recording…'
      : 'Connecting to the live browser… This view will retry automatically if the stream is not ready.';
    frame = document.createElement('iframe');
    frame.className = `bt-cloud-frame${recording ? ' is-recording' : ''}`;
    frame.title = recording ? 'Steel session recording' : 'Steel live browser';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('allow', 'autoplay; fullscreen');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    // A watch window must not send clicks or keystrokes into the AI's browser,
    // even if a player version ignores the interactive=false query setting.
    frame.tabIndex = recording ? 0 : -1;
    frame.setAttribute('aria-label', recording ? 'Recorded browser session with playback controls' : 'Live view of the AI browser, view only');
    const current = frame;
    if (!recording) {
      receivePlayback = event => {
        if (frame !== current || frameEnded || event.source !== current.contentWindow || event.origin !== 'https://api.steel.dev') return;
        const { type, detail } = event.data || {};
        if (type === 'steel:connected') {
          // Steel emits ready only for its first frame. After a transient
          // disconnect, ask about the already-drawn frame to reveal recovery.
          current.contentWindow?.postMessage({ type: 'steel:get-state' }, 'https://api.steel.dev');
          return;
        }
        if (type === 'steel:ready' || (type === 'steel:state' && detail?.firstFrameDrawn && detail?.isConnected)) {
          clearTimeout(liveRetryTimer);
          clearTimeout(liveReadyTimer);
          liveRetryTimer = null;
          liveReadyTimer = null;
          hideRetry();
          frameReady = true;
          message.hidden = true;
        } else {
          const hints = {
            'steel:autoplay-blocked': 'Your browser paused live playback. Open the Steel player in a tab below to start the video.',
            'steel:error': 'The live stream could not connect. Open the Steel player in a tab below, or keep following the lesson progress.',
            'steel:disconnected': 'The live stream disconnected. Open the Steel player in a tab below to check its connection.',
            'steel:session-ended': 'This cloud browser has closed. The AI is finishing your lesson or preparing its next browser.',
          };
          if (!hints[type]) return;
          frameReady = false;
          if (type === 'steel:error' || type === 'steel:disconnected') {
            retryLive(current);
            return;
          }
          clearTimeout(liveRetryTimer);
          clearTimeout(liveReadyTimer);
          liveRetryTimer = null;
          liveReadyTimer = null;
          if (type === 'steel:session-ended') {
            frameEnded = true;
            hideRetry();
          } else retryButton.hidden = false;
          playbackLabel = type === 'steel:session-ended' ? 'Closed' : 'Playback unavailable';
          message.hidden = false;
          message.textContent = hints[type];
        }
        render();
      };
    } else {
      const recordingOrigin = `chrome-extension://${chrome.runtime.id}`;
      receivePlayback = event => {
        if (frame !== current || event.source !== current.contentWindow || event.origin !== recordingOrigin) return;
        if (event.data?.type === 'browser-teacher-replay' && event.data.status === 'minimize') minimize();
      };
    }
    window.addEventListener('message', receivePlayback);
    // A document load does not prove the video is playing. Ask the player for
    // its state; only its first-frame signal removes our connecting message.
    frame.addEventListener('load', () => {
      if (frame !== current || frameEnded) return;
      if (recording) {
        // Our replay document owns media readiness, encoding waits, and Retry.
        // Loading this shell does not claim the video has started playing.
        message.hidden = true;
        return;
      }
      // Reparenting the host into a website modal can reload the iframe too.
      frameReady = false;
      playbackLabel = 'Connecting';
      message.hidden = false;
      message.textContent = 'Connecting to the live browser… This view will retry automatically if the stream is not ready.';
      render();
      current.contentWindow?.postMessage({ type: 'steel:get-state' }, 'https://api.steel.dev');
      clearTimeout(liveReadyTimer);
      liveReadyTimer = setTimeout(() => retryLive(current), LIVE_READY_TIMEOUT);
    });
    frame.addEventListener('error', () => {
      if (frame !== current) return;
      if (!recording) {
        frameReady = false;
        retryLive(current);
        return;
      }
      unload();
      message.hidden = false;
      message.textContent = 'The recording player could not load. Check that the lesson service is running, or open the session in Steel below.';
    });
    frameUrl = source;
    if (recording) {
      // Chrome blocks public HTTPS pages from navigating directly to a local
      // player. An extension-owned parent uses our loopback host permissions.
      const wrapper = new URL(chrome.runtime.getURL('src/panel/replay-frame.html'));
      wrapper.searchParams.set('url', source);
      frame.src = wrapper.href;
    } else frame.src = source;
    screen.appendChild(frame);
    // A failed navigation can produce no useful load/error or Steel message.
    if (!recording) liveReadyTimer = setTimeout(() => retryLive(current), LIVE_READY_TIMEOUT);
  }

  function minimize() {
    opened = false;
    unload();
    win.hidden = true;
    render();
    (trigger?.isConnected ? trigger : history)?.focus({ preventScroll: true });
  }

  function open() {
    if (!trigger?.isConnected && !recordings.length) return;
    raise();
    root.appendChild(win);
    opened = true;
    win.hidden = false;
    if (!placed) {
      floating.place({ left: 16, top: 24,
        width: Math.min(840, window.innerWidth - 32),
        height: Math.min(560, window.innerHeight - 48) });
      placed = true;
    } else floating.apply();
    render();
    minimizeButton.focus({ preventScroll: true });
  }

  minimizeButton.addEventListener('mousedown', event => event.preventDefault());
  minimizeButton.addEventListener('click', minimize);
  win.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    minimize();
  });

  const api = {
    begin(container) {
      this.reset({ forgetRecordings: true });
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'bt-cloud-watch';
      trigger.setAttribute('aria-controls', win.id);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.addEventListener('mousedown', event => event.preventDefault());
      trigger.addEventListener('click', () => {
        selection = 'current';
        open();
      });
      container.appendChild(trigger);
      render();
    },
    update(job) {
      if (!trigger) return;
      if (Array.isArray(job.recordings)) {
        recordings = job.recordings.flatMap(item => {
          const url = cloudRecordingUrl(item?.url);
          return url && typeof item.sessionId === 'string' && item.sessionId
            ? [{ sessionId: item.sessionId, attempt: item.attempt, phase: item.phase, url }] : [];
        });
        if (selection !== 'current' && !recordings.some(item => item.sessionId === selection)) selection = 'current';
      }
      const next = job.viewer || { status: job.viewerUrl ? 'live' : 'unavailable', url: job.viewerUrl };
      const finished = job.state === 'done' || job.state === 'error' || job.state === 'cancelled';
      if (job.state === 'cancelled') { this.reset({ forgetRecordings: true }); return; }
      const url = !finished && next.status === 'live' ? cloudPlayerUrl(next.url) : null;
      viewer = { ...next, url, status: finished ? 'closed' : next.status === 'live' && !url ? 'unavailable' : next.status };
      if (finished && !recordings.length) { this.reset(); return; }
      render();
    },
    lessonStarted() {
      restoreFocus ||= trigger?.isConnected && root.activeElement === trigger;
      if (!recordings.length) { this.reset(); return; }
      trigger?.remove();
      trigger = null;
      render();
    },
    reset({ forgetRecordings = false } = {}) {
      restoreFocus ||= win.contains(root.activeElement);
      opened = false;
      unload();
      win.hidden = true;
      win.remove();
      trigger?.remove();
      trigger = null;
      if (forgetRecordings) recordings = [];
      selection = 'current';
      liveRetryUrl = null;
      liveRetryCount = 0;
      viewer = { status: 'starting', url: null };
      render();
    },
    restoreFocus() {
      if (!restoreFocus) return;
      const control = root.querySelector('.bt-window.is-open .bt-actions button:not(:disabled)')
        || root.querySelector('.bt-bar-input:not(:disabled)');
      if (!control) return;
      restoreFocus = false;
      control.focus({ preventScroll: true });
    },
  };
  return api;
}
