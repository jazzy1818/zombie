// [B] The real entry point. Import order agreed hour 0, FROZEN. PLAN.md §4.
//
// Loaded by content.js via a dynamic import so that these stay real ES modules
// without depending on manifest `"type": "module"` support.
import './resolve/index.js';   // defines window.__RESOLVE  [A]
import './paint/index.js';     // defines window.__PAINT    [D]
import './teach.js';           // composes window.__TEACH    [shared]
import { mountPanel } from './panel/panel.js';

mountPanel();
