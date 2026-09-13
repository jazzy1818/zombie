import { findSync } from './resolver.js';
import { createGestureTracker } from './gesture.js';

const MENU_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio']);
const MAX_FALLBACK_LABEL_LENGTH = 80;
let cancelActive = null;

function isElement(node) {
  return node?.nodeType === 1;
}

function cleanText(value) {
  return value?.replace(/\s+/g, ' ').trim() || '';
}

function cleanAriaLabel(value) {
  return cleanText(value?.replace(/\s*\([^)]*\)\s*$/, ''));
}

function menuItemLabel(item, target) {
  const labelledChild = [...(item.querySelectorAll?.('[aria-label]') || [])]
    .find(el => el.getAttribute('aria-hidden') !== 'true' && cleanText(el.textContent));
  const label = cleanText(labelledChild?.textContent || item.textContent);
  const hasSubmenu = /[►▶›]\s*$/.test(label);
  const bareLabel = label.replace(/\s*[►▶›]\s*$/, '').trim();

  return item.getAttribute('role') === 'menuitemradio' && hasSubmenu && /^Apply '.+'$/.test(target?.name || '')
    ? `Apply '${bareLabel}'`
    : bareLabel;
}

export function clickedLabel(path, target) {
  const menuItem = path.find(node =>
    isElement(node) && MENU_ROLES.has(node.getAttribute('role'))
  );
  const menuLabel = menuItem && menuItemLabel(menuItem, target);
  if (menuLabel) return menuLabel;

  for (const node of path) {
    if (!isElement(node)) continue;

    const label = cleanAriaLabel(node.getAttribute('aria-label'));
    if (label) return label;
  }

  for (const node of path) {
    if (!isElement(node)) continue;

    const role = node.getAttribute('role');
    if (node.tagName === 'BUTTON' || role === 'button') {
      const label = cleanText(node.textContent);
      if (label) return label;
    }
  }

  for (const node of path) {
    if (!isElement(node) || node === document.body || node === document.documentElement) {
      continue;
    }

    const label = cleanText(node.textContent);
    if (label && label.length <= MAX_FALLBACK_LABEL_LENGTH) return label;
  }

  return 'unknown';
}

// Listen in capture phase because Google Docs stops click propagation.
// Snapshot real gesture identity before a mouseup-activated menu disappears.
export function waitForClick(target, { signal } = {}) {
  cancelActive?.();
  return new Promise((resolve, reject) => {
    const tracker = createGestureTracker(target, findSync);
    function cleanup() {
      document.removeEventListener('click', handler, true);
      signal?.removeEventListener('abort', cancel);
      tracker.dispose();
      if (cancelActive === cancel) cancelActive = null;
    }
    function cancel() {
      cleanup();
      reject(signal?.reason || new DOMException('Click wait cancelled', 'AbortError'));
    }

    function handler(event) {
      const activation = tracker.read(event);
      if (!activation || (!activation.target && !activation.action)) return;
      cleanup();
      if (activation.target) {
        resolve('correct');
        return;
      }
      resolve({ wrong: clickedLabel(activation.path, target) });
    }

    cancelActive = cancel;
    signal?.addEventListener('abort', cancel, { once: true });
    document.addEventListener('click', handler, true);
    if (signal?.aborted) cancel();
  });
}
