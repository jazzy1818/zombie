// Remember a real input gesture before a website's mouseup handler hides its
// control. Recognition still happens only on the resulting trusted click.
import { isVisible } from './visible.js';
import { isEnabled, isStateReadout, isTeacherUI, roleOf } from './eligibility.js';

const ACTION_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);

export function eventPath(event) {
  if (typeof event.composedPath === 'function') return event.composedPath();
  const path = [];
  for (let node = event.target; node; node = node.parentNode || node.host) path.push(node);
  return path;
}

export function pathHits(path, element) {
  return Boolean(element && (path.includes(element)
    || path.some(node => node?.localName === 'label' && node.control === element)));
}

function actionable(path) {
  return path.find(node => node?.nodeType === 1 && !isTeacherUI(node)
    && isVisible(node) && isEnabled(node) && !isStateReadout(node)
    && (node.matches('button, a[href], input:not([type="hidden"]), select, textarea, summary')
      || ACTION_ROLES.has(roleOf(node)))) || null;
}

const activatedTarget = (path, target) => pathHits(path, target) ? target : null;

// Chrome dispatches no click at all once the mousedown target has been removed
// from the document. A chosen row that is gone by the end of the input task and
// still has no click is taken on the press: the page consumed it.
const VANISH_MS = 80;

/**
 * `activate` may widen what counts as the target — a free-choice step accepts
 * any row chosen from the same list — but it can only ever add to the exact
 * match, never replace it. A hook that could say "no" to a click on the named
 * control itself would let one page detail make a step unpassable. `settle`
 * receives an activation the tracker had to decide on its own, without a click.
 */
export function createGestureTracker(target, find, findAction = actionable, activate = null, settle = null) {
  // A row chosen through `activate` is remembered as such: a popup that acts on
  // mousedown may have closed, re-rendered or moved by the time the click
  // arrives, so the click's own path is no proof of where the press landed.
  const accept = (path, current, action) => {
    const exact = activatedTarget(path, current);
    if (exact) return { target: exact, chosen: false };
    const choice = activate ? activate(path, current, action) : null;
    return choice ? { target: choice, chosen: true } : null;
  };
  let snapshot = null;
  let vanishTimer = null;
  const clear = () => { snapshot = null; clearTimeout(vanishTimer); vanishTimer = null; };
  function remember(event) {
    if (!event.isTrusted) return;
    const keyboard = event.type === 'keydown' || event.type === 'keyup';
    if (keyboard ? !['Enter', ' '].includes(event.key) || event.repeat : event.button !== 0) return;
    const path = eventPath(event);
    if (path.some(node => node?.nodeType === 1 && isTeacherUI(node))) { clear(); return; }
    // Within one gesture, a chosen row is kept even when the later event's path
    // no longer contains it — the page may have removed it on mousedown.
    const previous = !['pointerdown', 'keydown'].includes(event.type) && snapshot
      && (snapshot.chosen || pathHits(path, snapshot.target) || pathHits(path, snapshot.action)) ? snapshot : null;
    const current = find(target);
    const action = findAction(path);
    const hit = accept(path, current, action);
    snapshot = {
      target: hit?.target || previous?.target || null,
      chosen: hit ? hit.chosen : Boolean(previous?.chosen),
      action: action || previous?.action || null,
      time: event.timeStamp,
    };
    if (event.type === 'mouseup' && settle && snapshot.chosen && snapshot.target) {
      const chosen = snapshot.target;
      clearTimeout(vanishTimer);
      vanishTimer = setTimeout(() => {
        vanishTimer = null;
        // A click, had one come, would have cleared the snapshot by now.
        if (snapshot?.target !== chosen || chosen.isConnected) return;
        clear();
        settle({ target: chosen, action: null, path });
      }, VANISH_MS);
    }
  }
  const events = ['pointerdown', 'mousedown', 'mouseup', 'keydown', 'keyup'];
  for (const type of events) document.addEventListener(type, remember, true);
  document.addEventListener('pointercancel', clear, true);
  return {
    read(event) {
      if (!event.isTrusted || event.type !== 'click' || event.button !== 0) return null;
      const path = eventPath(event);
      if (path.some(node => node?.nodeType === 1 && isTeacherUI(node))) { clear(); return null; }
      const saved = snapshot && event.timeStamp >= snapshot.time && event.timeStamp - snapshot.time <= 1500 ? snapshot : null;
      const current = find(target);
      const action = findAction(path) || (saved && pathHits(path, saved.action) && saved.action) || null;
      const hit = accept(path, current, action)?.target
        || (saved && (saved.chosen || pathHits(path, saved.target)) && saved.target) || null;
      clear();
      return { target: hit, action, path };
    },
    dispose() {
      clear();
      for (const type of events) document.removeEventListener(type, remember, true);
      document.removeEventListener('pointercancel', clear, true);
    },
  };
}
