// [D] Ghost cursor: tween + click animation.
// clickCursor() animates only — it must NOT dispatch a real click. The real
// click is __TEACH.demo()'s job, and in guided/solo modes it's the user's.
import { CURSOR_TWEEN_MS } from '../constants.js';

export async function moveCursor(box) { /* TODO [D] */ }
export async function clickCursor()   { /* TODO [D] — ripple + depress */ }
export function setCursorVisible(v)   { /* TODO [D] — hidden during `solo` steps */ }
