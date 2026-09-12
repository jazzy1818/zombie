// [C] Mirror of extension/src/constants.js (PLAN.md §3). Keep them identical.
import { fileURLToPath } from 'node:url';

export const VIEWPORT   = { width: 1440, height: 900 };
export const TARGET_URL = 'https://docs.google.com/document/d/*';

export const MAX_AGENT_ACTIONS     = 15;
export const AGENT_STEP_TIMEOUT_MS = 8000;
export const RESOLVE_TIMEOUT_MS    = 2000;
export const VERIFY_TIMEOUT_MS     = 3000;

export const STEEL_API_KEY = process.env.STEEL_API_KEY;

// Relative to this directory, not the cwd — running from the repo root would otherwise
// drop a live Google session where pipeline/.gitignore doesn't cover it.
export const PROFILE_PATH = process.env.PROFILE_PATH
  ? fileURLToPath(new URL(process.env.PROFILE_PATH, new URL('./', import.meta.url)))
  : fileURLToPath(new URL('./profile.json', import.meta.url));
