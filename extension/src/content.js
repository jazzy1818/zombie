// [B] entry point — import order agreed hour 0, FROZEN. PLAN.md §4.
import './resolve/index.js';   // defines window.__RESOLVE  [A]
import './paint/index.js';     // defines window.__PAINT    [D]
import './teach.js';           // composes window.__TEACH    [shared]
import { mountPanel } from './panel/panel.js';

mountPanel();
