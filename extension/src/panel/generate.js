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
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(new DOMException('Generation cancelled', 'AbortError'));
  }, { once: true });
});

/**
 * Ask the cloud browser to work out how to do `goal`, and hand back a lesson.
 *
 * `onProgress` receives the human-readable trail as it happens — the agent's
 * own reasoning, one line per click. That trail is the point: four minutes of
 * a blank spinner reads as broken, and the same four minutes narrated reads as
 * the product working.
 */
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
  if (!jobId) return;
  const url = `${BRIDGE}/jobs/${jobId}/cancel`;
  try {
    if (navigator.sendBeacon?.(url, new Blob([], { type: 'text/plain' }))) return;
  } catch { /* fall through to fetch */ }
  fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
}

export async function generateLesson(goal, { signal, onProgress, docUrl, onJob } = {}) {
  const res = await fetch(`${BRIDGE}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal, ...(docUrl ? { docUrl } : {}) }),
    signal,
  });

  if (res.status === 409) throw new Error('The cloud browser is already building another lesson. Try again in a minute.');
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `The bridge said ${res.status}.`);

  const { jobId } = await res.json();
  onJob?.(jobId);
  // Whatever ends this — cancel, navigation, an error — the bridge is told once.
  signal?.addEventListener('abort', () => cancelGeneration(jobId), { once: true });

  const started = Date.now();
  let seen = 0;

  for (;;) {
    await sleep(POLL_MS, signal);
    if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');

    let job;
    try {
      job = await (await fetch(`${BRIDGE}/jobs/${jobId}`, { signal })).json();
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      continue;   // a dropped poll is not a dead job
    }

    for (const p of job.progress.slice(seen)) onProgress?.(p.text, job);
    seen = job.progress.length;

    if (job.state === 'done') return job.lesson;
    if (job.state === 'cancelled') throw new DOMException('Generation cancelled', 'AbortError');
    if (job.state === 'error') throw new Error(job.error || 'Generation failed.');

    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error('Generation is taking longer than expected — check the bridge terminal.');
    }
  }
}
