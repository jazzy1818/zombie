// SHARED — written hour 0, NEVER edited after. PLAN.md §3.
// Mirrored in pipeline/config.js. If you change one, change both — or don't change either.

export const VIEWPORT   = { width: 1440, height: 900 };  // Steel AND demo laptop
export const TARGET_URL = 'https://docs.google.com/document/d/*';

// Timing
export const RESOLVE_TIMEOUT_MS = 2000;   // resolver retry window
export const IDLE_HINT_MS       = 8000;   // before hint tier 1
export const HINT_ESCALATE_MS   = 8000;   // between subsequent tiers
export const CURSOR_TWEEN_MS    = 600;    // ghost cursor travel
export const TRANSITION_MS      = 250;    // spotlight move
export const DEMO_DWELL_MS      = 900;    // pause before demo-mode click
export const VERIFY_TIMEOUT_MS  = 3000;

// Spotlight geometry
export const SPOT_PADDING = 4;
export const SPOT_RADIUS  = 8;
export const SCRIM        = 'rgba(0,0,0,0.55)';
export const OVERLAY_Z    = 2147483647;

// Colors
export const ACCENT  = '#4F9CF9';
export const CORRECT = '#34A853';
export const WRONG   = '#EA4335';

// Panel
export const PANEL_WIDTH = 340;
export const PANEL_SIDE  = 'right';

// Pipeline
export const MAX_AGENT_ACTIONS     = 15;   // hard cap; lost agents stay lost
export const AGENT_STEP_TIMEOUT_MS = 8000;
