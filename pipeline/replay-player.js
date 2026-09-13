// This page is served by the local bridge, not injected into the host website.
// HLS and every media request go through the same origin; no key reaches it.
(() => {
  const video = document.querySelector('#recording');
  const status = document.querySelector('#replay-status');
  const retry = document.querySelector('#replay-retry');
  const INITIAL_WAIT_MS = 1500;
  const RETRY_DELAYS_MS = [1500, 2500, 4000, 6000];
  const READY_TIMEOUT_MS = 10000;
  const RETRY_WINDOW_MS = 45000;
  let player = null;
  let generation = 0;
  let stopped = false;
  let retryTimer = null;
  let readyTimer = null;
  let removeMediaListeners = () => {};
  let attempt = 0;
  let startedAt = 0;
  let wasReady = false;
  const manifest = new URL('./media/0', location.href).href;

  function show(message, state, canRetry = false) {
    if (stopped) return;
    status.textContent = message;
    document.body.dataset.playback = state;
    retry.hidden = !canRetry;
    // Parent may display readiness, but it must verify this iframe's source.
    parent.postMessage({ type: 'browser-teacher-replay', status: state }, '*');
  }
  function clearAttempt() {
    ++generation;
    clearTimeout(readyTimer);
    readyTimer = null;
    removeMediaListeners();
    removeMediaListeners = () => {};
    const previous = player;
    player = null;
    previous?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function unavailable() {
    clearTimeout(retryTimer);
    retryTimer = null;
    clearAttempt();
    show('Recording is still processing or unavailable. Try again in a moment.', 'unavailable', true);
  }
  function failed(current) {
    if (stopped || current !== generation) return;
    clearAttempt();
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (!wasReady && delay !== undefined && Date.now() + delay < startedAt + RETRY_WINDOW_MS) {
      wait(delay);
    } else unavailable();
  }
  function wait(delay) {
    clearTimeout(retryTimer);
    show('Recording is processing. We’ll retry automatically…', 'loading');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) loadAttempt();
    }, delay);
  }
  function loadAttempt() {
    if (stopped) return;
    const remaining = startedAt + RETRY_WINDOW_MS - Date.now();
    if (remaining <= 0) { unavailable(); return; }
    attempt++;
    const current = ++generation;
    show('Loading recording…', 'loading');
    const active = () => !stopped && current === generation;
    const ready = () => {
      if (!active() || wasReady || video.readyState < 2) return;
      wasReady = true;
      clearTimeout(readyTimer);
      readyTimer = null;
      show('Starting recording…', 'ready');
      video.muted = true;
      video.play().catch(() => {
        if (active() && video.paused) show('Recording ready. Press play to watch.', 'ready');
      });
    };
    const playing = () => { if (active()) show('Playing recording.', 'playing'); };
    const ended = () => { if (active()) show('Recording finished. Use the controls to watch again.', 'ended'); };
    const error = () => { if (active() && video.error) failed(current); };
    video.addEventListener('loadeddata', ready);
    video.addEventListener('canplay', ready);
    video.addEventListener('playing', playing);
    video.addEventListener('ended', ended);
    video.addEventListener('error', error);
    removeMediaListeners = () => {
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('playing', playing);
      video.removeEventListener('ended', ended);
      video.removeEventListener('error', error);
    };
    // Includes stalled manifests and media initialization. Once ready, ordinary
    // playback is unbounded; only the initial processing wait has this budget.
    readyTimer = setTimeout(() => failed(current), Math.min(READY_TIMEOUT_MS, remaining));
    if (window.Hls?.isSupported()) {
      const hls = new Hls({
        enableWorker: false, maxBufferLength: 30,
        // Own the initial retry schedule here rather than stacking it on HLS's
        // separate manifest retry loop. Normal segment buffering stays intact.
        manifestLoadPolicy: { default: {
          maxTimeToFirstByteMs: READY_TIMEOUT_MS, maxLoadTimeMs: READY_TIMEOUT_MS,
          timeoutRetry: null, errorRetry: null,
        } },
      });
      player = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (active()) show('Preparing recording playback…', 'loading');
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) failed(current);
      });
      hls.loadSource(manifest);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = manifest;
    } else {
      clearAttempt();
      show('This browser cannot play the recording. Try a current Chrome, Edge, or Safari.', 'unavailable');
    }
  }
  function start(initialDelay) {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    clearAttempt();
    attempt = 0;
    wasReady = false;
    startedAt = Date.now();
    if (initialDelay) wait(initialDelay);
    else loadAttempt();
  }
  retry.addEventListener('click', () => start(0));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.fullscreenElement) return;
    event.preventDefault();
    parent.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*');
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(retryTimer);
    retryTimer = null;
    clearAttempt();
  });
  start(INITIAL_WAIT_MS);
})();
