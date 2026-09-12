// [C] Stage 2 — exploration loop over CDP.
// read the accessibility tree (NOT screenshots — cheaper, faster, more
// reliable) → decide (LLM picks one action) → act → observe. Repeat to goal.
//
// Hard cap at MAX_AGENT_ACTIONS, then fail and re-run. A lost agent stays
// lost; letting it wander burns minutes producing nothing.
import { MAX_AGENT_ACTIONS, AGENT_STEP_TIMEOUT_MS } from './config.js';

export async function explore(session, goal) {
  // TODO [C] — returns the raw trace (~40 actions, most of it garbage)
}
