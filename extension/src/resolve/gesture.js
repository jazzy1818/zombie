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

export function createGestureTracker(target, find, findAction = actionable) {
  let snapshot = null;
  const clear = () => { snapshot = null; };
  function remember(event) {
    if (!event.isTrusted) return;
    const keyboard = event.type === 'keydown' || event.type === 'keyup';
    if (keyboard ? !['Enter', ' '].includes(event.key) || event.repeat : event.button !== 0) return;
    const path = eventPath(event);
    if (path.some(node => node?.nodeType === 1 && isTeacherUI(node))) { clear(); return; }
    const previous = !['pointerdown', 'keydown'].includes(event.type) && snapshot
      && (pathHits(path, snapshot.target) || pathHits(path, snapshot.action)) ? snapshot : null;
    const current = find(target);
    snapshot = {
      target: (pathHits(path, current) && current) || previous?.target || null,
      action: findAction(path) || previous?.action || null,
      time: event.timeStamp,
    };
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
      const hit = (pathHits(path, current) && current)
        || (saved && pathHits(path, saved.target) && saved.target) || null;
      const action = findAction(path) || (saved && pathHits(path, saved.action) && saved.action) || null;
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
