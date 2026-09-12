// [B] Side panel: narration, cards, lesson loading.
// Calls window.__TEACH only — never __RESOLVE or __PAINT directly.
//
// CRITICAL: never .focus() anything during a step. Docs menus dismiss on blur.
import { PANEL_WIDTH, PANEL_SIDE } from '../constants.js';

export function mountPanel() {
  // TODO [B] — mount panel, load a lesson from ../../lessons/, run the machine
}
