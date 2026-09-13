// [A] Contract 2 — builds window.__RESOLVE. PLAN.md §6.
// DOM intelligence: finds things, judges outcomes. Draws NOTHING.
import { find, findSync } from './resolver.js';
import { waitForClick } from './click.js';
import { verify } from './verify.js';

window.__RESOLVE = {
  find,                                  // Promise<Element|null>, retries RESOLVE_TIMEOUT_MS
  findSync,                              // sync single attempt, for the rAF loop
  waitForClick,                          // Promise<'correct' | { wrong: string }>
  verify,                                // Promise<boolean>
};
