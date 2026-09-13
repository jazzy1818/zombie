// [B] Client for the local authoring bridge (pipeline/bridge.js).
//
// Only used when semantic search comes up empty. The normal path — a question
// that matches a lesson we already have — never touches the network, and the
// panel works completely without the bridge running.
//
// Everything here degrades to "not available". A missing bridge is the common
// case, not an error: most people run the extension against a pre-generated
// library and never start one.

const BRIDGE = 'http://localhost:7777';
export const bridgeOrigin = new URL(BRIDGE).origin;

// Generation takes 1-4 minutes. Polling beats holding a request open for that
// long — a request that dies at a proxy timeout loses a lesson we already paid
// a cloud browser to produce.
const POLL_MS = 1200;
const MAX_WAIT_MS = 6 * 60_000;

/** Is a bridge running? Fast, and never throws — used to decide whether to offer generation. */
export async function bridgeAvailable({ timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    return (await res.json())?.ok === true;
  } catch {
    return false;   // not running, wrong port, blocked — all the same to us
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => {
    clearTimeout(t);
    reject(new DOMException('Generation cancelled', 'AbortError'));
  };
  const t = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
});

/**
 * Tell the bridge to stop and release the cloud browser.
 *
 * Aborting the fetch only stops us listening — the session keeps running, keeps billing,
 * and holds the bridge's one-at-a-time lock, so the next question comes back 409. This is
 * the only thing that actually stops it.
 *
 * sendBeacon first: it is the one request that survives the page going away, which is
 * exactly when this matters most.
 */
export function cancelGeneration(jobId) {
  if (typeof jobId !== 'string' || !jobId) return;
  const url = `${BRIDGE}/jobs/${encodeURIComponent(jobId)}/cancel`;
  try {
    if (navigator.sendBeacon?.(url, new Blob([], { type: 'text/plain' }))) return;
  } catch { /* fall through to fetch */ }
  fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
}

/**
 * Ask the cloud browser to work out `goal` and return its lesson.
 * onProgress receives narration; onJob receives full metadata on every poll,
 * including session changes with no new narration. Job IDs stay local here.
 */
export async function generateLesson(goal, { signal, onProgress, onJob, docUrl } = {}) {
  const lifetime = new AbortController();
  let jobId = null;
  let terminal = false;
  let cancelSent = false;
  const stop = () => {
    lifetime.abort();
    if (jobId && !terminal && !cancelSent) {
      cancelSent = true;
      cancelGeneration(jobId);
    }
  };
  const check = () => {
    if (lifetime.signal.aborted) throw new DOMException('Generation cancelled', 'AbortError');
  };
  signal?.addEventListener('abort', stop, { once: true });
  window.addEventListener('pagehide', stop, { once: true });
  if (signal?.aborted) stop();

  try {
    check();
    // Let an accepted creation request return its ID even if Stop is clicked
    // during allocation. The panel's abort race remains immediate; once the ID
    // arrives we can release that exact job. A lost response/closed document
    // is covered by the bridge's no-poll reaper.
    const res = await fetch(`${BRIDGE}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, ...(docUrl ? { docUrl } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 409) throw new Error('The cloud browser is already building another lesson. Try again in a minute.');
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `The bridge said ${res.status}.`);
    ({ jobId } = await res.json());
    if (typeof jobId !== 'string' || !jobId) throw new Error('The bridge did not return a job ID.');
    check();

    const started = Date.now();
    let seen = 0;
    for (;;) {
      await sleep(POLL_MS, lifetime.signal);
      check();
      if (Date.now() - started > MAX_WAIT_MS) {
        throw new Error('Generation is taking longer than expected — check the bridge terminal.');
      }

      let job;
      try {
        const pollSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]);
        const response = await fetch(`${BRIDGE}/jobs/${encodeURIComponent(jobId)}`, { signal: pollSignal });
        if (!response.ok) throw new Error(`The bridge said ${response.status}.`);
        job = await response.json();
        if (!Array.isArray(job.progress)) throw new Error('Invalid job response.');
      } catch (err) {
        check();
        onJob?.({ state: 'running', viewer: { status: 'unavailable', url: null, reason: 'disconnected' } });
        continue;   // a dropped poll is not a dead job
      }

      check();
      terminal = ['done', 'error', 'cancelled'].includes(job.state);
      onJob?.(job);
      for (const p of job.progress.slice(seen)) onProgress?.(p.text, job);
      seen = job.progress.length;

      if (job.state === 'done') return job.lesson;
      if (job.state === 'cancelled') throw new DOMException('Generation cancelled', 'AbortError');
      if (job.state === 'error') throw new Error(job.error || 'Generation failed.');
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    window.removeEventListener('pagehide', stop);
    if (!terminal) stop();
  }
}
