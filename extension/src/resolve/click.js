import { findSync } from './resolver.js';
import { menuMatch, toolbarMatch } from './match.js';

const PANEL_HOST_ID = 'browser-teacher-root';
const MENU_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio']);
const MAX_FALLBACK_LABEL_LENGTH = 80;
let activeHandler = null;

function isElement(node) {
  return node?.nodeType === 1;
}

function cleanText(value) {
  return value?.replace(/\s+/g, ' ').trim() || '';
}

function cleanAriaLabel(value) {
  return cleanText(value?.replace(/\s*\([^)]*\)\s*$/, ''));
}

function eventPath(event) {
  if (typeof event.composedPath === 'function') {
    return event.composedPath();
  }

  const path = [];
  for (let node = event.target; node; node = node.parentNode || node.host) {
    path.push(node);
  }
  return path;
}

function menuItemLabel(item) {
  const labelledChild = [...(item.querySelectorAll?.('[aria-label]') || [])]
    .find(el => el.getAttribute('aria-hidden') !== 'true' && cleanText(el.textContent));
  const label = cleanText(labelledChild?.textContent || item.textContent);
  const hasSubmenu = /[►▶›]\s*$/.test(label);
  const bareLabel = label.replace(/\s*[►▶›]\s*$/, '').trim();

  return item.getAttribute('role') === 'menuitemradio' && hasSubmenu
    ? `Apply '${bareLabel}'`
    : bareLabel;
}

function clickedLabel(path) {
  const menuItem = path.find(node =>
    isElement(node) && MENU_ROLES.has(node.getAttribute('role'))
  );
  const menuLabel = menuItem && menuItemLabel(menuItem);
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

function pathMatchesTarget(path, target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  if (typeof target.name !== 'string' || !target.name.trim()) return false;
  if (target.nth !== undefined) return false;

  const scope = target.scope === undefined ? 'any' : target.scope;
  if (!['toolbar', 'menu', 'any'].includes(scope)) return false;

  const name = target.name.trim();
  if (scope === 'menu' || scope === 'any') {
    const menuItem = path.find(node =>
      isElement(node) && MENU_ROLES.has(node.getAttribute('role'))
    );
    if (menuItem && menuMatch(menuItem, name)) return true;
  }

  if (scope === 'toolbar' || scope === 'any') {
    const inToolbar = path.some(node => isElement(node) && node.id === 'docs-toolbar-wrapper');
    if (scope === 'toolbar' && !inToolbar) return false;

    return path.some(node =>
      isElement(node)
      && node.getAttribute('aria-label')
      && toolbarMatch(node, name)
    );
  }

  return false;
}

// Listen in capture phase because Google Docs stops click propagation.
// Resolve the target at click time so controls in newly opened menus can match.
export function waitForClick(target) {
  return new Promise(resolve => {
    if (activeHandler) document.removeEventListener('click', activeHandler, true);

    function handler(event) {
      const path = eventPath(event);
      if (path.some(node => isElement(node) && node.id === PANEL_HOST_ID)) return;

      document.removeEventListener('click', handler, true);
      if (activeHandler === handler) activeHandler = null;

      const intended = findSync(target);
      const hitTarget = intended && (
        path.includes(intended) || intended.contains?.(event.target)
      );

      if (hitTarget || pathMatchesTarget(path, target)) {
        resolve('correct');
        return;
      }

      resolve({ wrong: clickedLabel(path) });
    }

    activeHandler = handler;
    document.addEventListener('click', handler, true);
  });
}
