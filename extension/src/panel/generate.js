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
 * Ask the cloud browser to work out how to do `goal`, and hand back a lesson.
 *
 * `onProgress` receives the human-readable trail as it happens — the agent's
 * own reasoning, one line per click. That trail is the point: four minutes of
 * a blank spinner reads as broken, and the same four minutes narrated reads as
 * the product working.
 */
// onJob runs for every poll, even when the textual progress hasn't changed.
// Session allocation/release and retries can happen between progress entries.
export async function generateLesson(goal, { signal, onProgress, onJob, docUrl } = {}) {
  const res = await fetch(`${BRIDGE}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal, ...(docUrl ? { docUrl } : {}) }),
    signal,
  });

  if (res.status === 409) throw new Error('The cloud browser is already building another lesson. Try again in a minute.');
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `The bridge said ${res.status}.`);

  const { jobId } = await res.json();
  const started = Date.now();
  let seen = 0;

  for (;;) {
    await sleep(POLL_MS, signal);
    if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error('Generation is taking longer than expected — check the bridge terminal.');
    }

    let job;
    try {
      const pollSignal = AbortSignal.any([
        ...(signal ? [signal] : []), AbortSignal.timeout(15_000),
      ]);
      const response = await fetch(`${BRIDGE}/jobs/${jobId}`, { signal: pollSignal });
      if (!response.ok) throw new Error(`The bridge said ${response.status}.`);
      job = await response.json();
      if (!Array.isArray(job.progress)) throw new Error('Invalid job response.');
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
      onJob?.({ state: 'running', viewer: { status: 'unavailable', url: null, reason: 'disconnected' } });
      continue;   // a dropped poll is not a dead job
    }

    if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
    onJob?.(job);
    for (const p of job.progress.slice(seen)) onProgress?.(p.text, job);
    seen = job.progress.length;

    if (job.state === 'done') return job.lesson;
    if (job.state === 'error') throw new Error(job.error || 'Generation failed.');

  }
}
