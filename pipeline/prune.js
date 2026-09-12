// [C] Stage 3 — pruning.
// Replay backwards from the success state; keep only load-bearing actions.
//
// If you ship the raw trace, the teacher walks users through the agent's mistakes.
// You'd be teaching confusion. The pruned path is the lesson.
//
// WHY THIS IS A PURE FUNCTION (signature changed from the scaffold's prune(session, trace))
// ----------------------------------------------------------------------------------------
// The literal reading — re-running candidate subsequences in fresh sessions — costs
// ~45-70s per replay (session create + Docs cold load + N clicks + release). For a
// 12-action trace that is 9-14 minutes per lesson on top of exploration, and every replay
// inherits Docs' load-time variance. A flaky prune produces a SHORTER WRONG lesson, which
// is the worst failure mode available. Not affordable for what §16 lists as cut item #1.
//
// Instead we read the pre/post observations explore already captured. An action is
// load-bearing exactly when a later kept action's target BECAME VISIBLE because of it.
// Zero sessions, and the dependency edges are printable and eyeballable.
//
// verify.js is the acceptance test — and it had to exist anyway — so pruning costs one
// session, the one Stage 5 was already going to spend.

/**
 * @param {object} trace  from explore()
 * @returns {{kept: object[], dropped: object[], reasons: Record<number,string>, edges: Array}}
 */
export function prune(trace) {
  const { steps } = trace;
  const reasons = {};
  const edges = [];

  if (!steps.length) return { kept: [], dropped: [], reasons, edges };

  // 1. explore() only returns ok:true once goalCheck passed on the final observation,
  //    so the last recorded step IS the terminal one. Nothing sits past the finish line.
  const terminalIdx = steps.length - 1;

  // 2. No-ops: the click changed nothing on the page, so nothing downstream can need it.
  const isNoop = s =>
    !s.delta.appeared.length && !s.delta.disappeared.length && !s.delta.changed.length;

  // 3. Walk the causal chain backwards from the terminal step.
  const need = new Set([terminalIdx]);
  let cursor = terminalIdx;

  for (;;) {
    const step = steps[cursor];
    const name = step.target.raw;

    // Was this step's target already on screen before anything was clicked?
    // If so its provenance is the page's initial state and the chain ends here.
    if (visibleIn(steps[0].pre, step.target)) break;

    // Otherwise: find the LATEST earlier step that made it appear.
    let producer = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (steps[i].delta.appeared.some(c => c.raw === name && c.scope === step.target.scope)) {
        producer = i;
        break;
      }
    }

    if (producer === -1) break;   // unknown provenance — keep what we have, let verify judge
    edges.push({ from: steps[producer].n, to: step.n, via: step.target.name });
    need.add(producer);
    cursor = producer;
  }

  // `reasons` is keyed by step.n (explore's action counter), not array position — the two
  // diverge whenever a decide retry or a failed click skips a slot.
  const kept = [];
  const dropped = [];
  steps.forEach((s, i) => {
    if (need.has(i)) { kept.push(s); return; }
    reasons[s.n] = isNoop(s) ? 'no-op' : 'not-load-bearing';
    dropped.push(s);
  });

  return { kept, dropped, reasons, edges };
}

function visibleIn(obs, target) {
  const pool = obs[target.scope] ?? [];
  return pool.some(c => c.raw === target.raw);
}

/**
 * Escalation for when verify.js fails at a kept step: re-insert dropped steps that sat
 * between the previous kept step and the failing one, in chronological order. Caller
 * re-verifies after each and stops on the first pass. Cap at 2 attempts — past that the
 * lesson is unshippable and the honest answer is to say so.
 */
export function escalate(trace, kept, failedStepIndex) {
  const keptNs = new Set(kept.map(s => s.n));
  const lo = failedStepIndex > 0 ? kept[failedStepIndex - 1].n : -1;
  const hi = kept[failedStepIndex].n;
  return trace.steps
    .filter(s => s.n > lo && s.n < hi && !keptNs.has(s.n))
    .map(extra => [...kept.slice(0, failedStepIndex), extra, ...kept.slice(failedStepIndex)]);
}

/** Print the dependency chain. The whole point of the heuristic is that it's inspectable. */
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
