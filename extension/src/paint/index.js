// [D] Contract 3 — builds window.__PAINT. PLAN.md §6.
// Pure rendering. Knows NOTHING about Docs, menus, or lessons.
// Every method accepts an Element or a raw {top,left,width,height} rect.
import { mountHost } from './host.js';
import { spotlight, clear } from './spotlight.js';
import { moveCursor, clickCursor, setCursorVisible } from './cursor.js';
import { flashCorrect, flashWrong } from './feedback.js';

window.__PAINT = {
  init: mountHost,   // idempotent, called once on load
  spotlight,
  clear,
  moveCursor,
  clickCursor,
  flashCorrect,
  flashWrong,
  setCursorVisible,
};

window.__PAINT.init();
