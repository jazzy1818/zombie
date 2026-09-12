// [C] Mirror of extension/src/constants.js. PLAN.md §3.
// If these two files ever disagree, the Steel session and the demo laptop
// disagree about what's on screen, and lessons reference elements that don't
// exist. Keep them identical.

export const VIEWPORT   = { width: 1440, height: 900 };
export const TARGET_URL = 'https://docs.google.com/document/d/*';

export const MAX_AGENT_ACTIONS     = 15;   // hard cap; lost agents stay lost
export const AGENT_STEP_TIMEOUT_MS = 8000;

export const STEEL_API_KEY = process.env.STEEL_API_KEY;
export const PROFILE_PATH  = process.env.PROFILE_PATH;  // saved cookies + localStorage
