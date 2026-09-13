// [C] Stage 3 — keep only load-bearing actions.
//
// Pure by design: replaying candidate subsequences in fresh sessions costs 9-14 min per
// lesson and a flaky replay yields a shorter WRONG lesson. Don't restore prune(session, trace).

export function prune(trace) {
  const { steps } = trace;
  const reasons = {};
  const edges = [];

  // emit() needs to know which app this was; the trace is the only record.
  const provenance = { app: trace.app, url: trace.steps[0]?.pre?.url };

  if (!steps.length) return { ...provenance, kept: [], dropped: [], reasons, edges };

  const isNoop = s =>
    !s.delta.appeared.length && !s.delta.disappeared.length && !s.delta.changed.length;

  const terminalIdx = steps.length - 1;
  const need = new Set([terminalIdx]);
  let cursor = terminalIdx;

  // An action is load-bearing exactly when a later kept action's target became visible
  // because of it. Walk that chain back from the terminal step.
  for (;;) {
    const step = steps[cursor];
    const name = step.target.raw;

    if (visibleIn(steps[0].pre, step.target)) break;

    let producer = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (steps[i].delta.appeared.some(c => c.raw === name && c.scope === step.target.scope)) {
        producer = i;
        break;
      }
    }

    if (producer === -1) break;
    edges.push({ from: steps[producer].n, to: step.n, via: step.target.name });
    need.add(producer);
    cursor = producer;
  }

  const kept = [];
  const dropped = [];
  steps.forEach((s, i) => {
    if (need.has(i)) { kept.push(s); return; }
    // keyed by step.n, not array index — they diverge when a retry skips a slot
    reasons[s.n] = isNoop(s) ? 'no-op' : 'not-load-bearing';
    dropped.push(s);
  });

  return { ...provenance, kept, dropped, reasons, edges };
}

function visibleIn(obs, target) {
  const pool = obs[target.scope] ?? [];
  return pool.some(c => c.raw === target.raw);
}

/** Re-insert dropped steps around a failing one. Caller re-verifies each; cap at 2. */
export function escalate(trace, kept, failedStepIndex) {
  const keptNs = new Set(kept.map(s => s.n));
  const lo = failedStepIndex > 0 ? kept[failedStepIndex - 1].n : -1;
  const hi = kept[failedStepIndex].n;
  return trace.steps
    .filter(s => s.n > lo && s.n < hi && !keptNs.has(s.n))
    .map(extra => [...kept.slice(0, failedStepIndex), extra, ...kept.slice(failedStepIndex)]);
}

export function printPrune(trace, result) {
  console.log(`\n  pruned ${trace.steps.length} → ${result.kept.length} steps`);
  for (const s of trace.steps) {
    const keep = result.kept.includes(s);
    console.log(`   ${keep ? 'KEEP' : ' -- '}  ${String(s.n).padStart(2)}  ${s.target.name.padEnd(28)} ${keep ? '' : result.reasons[s.n] ?? ''}`);
  }
  for (const e of result.edges) {
    console.log(`         step ${e.from} revealed "${e.via}" for step ${e.to}`);
  }
  console.log('');
}
