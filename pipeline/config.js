// [C] Mirror of extension/src/constants.js. PLAN.md §3.
import { fileURLToPath } from 'node:url';

// If these two files ever disagree, the Steel session and the demo laptop
// disagree about what's on screen, and lessons reference elements that don't
// exist. Keep them identical.

export const VIEWPORT   = { width: 1440, height: 900 };
export const TARGET_URL = 'https://docs.google.com/document/d/*';

export const MAX_AGENT_ACTIONS     = 15;   // hard cap; lost agents stay lost
export const AGENT_STEP_TIMEOUT_MS = 8000;

// Replay timings — verify.js reproduces what the extension does at teach time, so it
// must wait exactly as long as the extension waits. Mirrored from constants.js §3.
export const RESOLVE_TIMEOUT_MS = 2000;
export const VERIFY_TIMEOUT_MS  = 3000;

export const STEEL_API_KEY = process.env.STEEL_API_KEY;

// Saved Google auth. Defaults to pipeline/profile.json and resolves RELATIVE TO THIS
// DIRECTORY, not the cwd — `node --env-file=.env pipeline/run-t1.js` from the repo root
// would otherwise drop the file in the repo root, where pipeline/.gitignore does not
// cover it and a live Google session would be one `git add .` from the remote.
// An absolute PROFILE_PATH is honoured as-is.
export const PROFILE_PATH = process.env.PROFILE_PATH
  ? fileURLToPath(new URL(process.env.PROFILE_PATH, new URL('./', import.meta.url)))
  : fileURLToPath(new URL('./profile.json', import.meta.url));
