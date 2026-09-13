// [D] Passive, site-independent rendering surface. No host-page focus or clicks.
import { OVERLAY_Z, ACCENT, SPOT_RADIUS, SCRIM } from '../constants.js';
import { watchNavigation } from './navigation.js';

let surface = null;
let stopNavigation = null;
const disposers = new Set();
const raisedListeners = new Set();

// Other extension UI can stay readable above this passive rendering surface.
export function onRaise(listener) {
  raisedListeners.add(listener);
  return () => raisedListeners.delete(listener);
}

function notifyRaised() {
  for (const listener of raisedListeners) listener();
}

export function onUnmount(dispose) {
  disposers.add(dispose);
  return () => disposers.delete(dispose);
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function currentHost() {
  return surface?.host.isConnected ? surface : null;
}

export function raiseHost() {
  const current = currentHost();
  if (!current) return;
  // A page may have opened a dialog/popover after our host. Raise only when
  // starting new guidance, never each frame (which would churn the top layer).
  try {
    if (current.host.hasAttribute('popover')) {
      if (current.host.matches(':popover-open')) current.host.hidePopover();
      current.host.showPopover();
    }
  } catch { /* The fixed-position fallback remains usable outside the top layer. */ }
  notifyRaised();
}

export function mountHost() {
  if (currentHost()) return surface;
  if (surface) unmountHost();

  const host = document.createElement('div');
  host.dataset.browserTeacherPaint = '';
  host.setAttribute('aria-hidden', 'true');
  // Inline !important protects the host itself; Shadow DOM protects its children.
  const styles = {
    all: 'initial', display: 'block', position: 'fixed', inset: '0', width: '100%', height: '100%',
    margin: '0', padding: '0', border: '0', overflow: 'hidden',
    'box-sizing': 'border-box', 'pointer-events': 'none', 'z-index': String(OVERLAY_Z),
    background: 'transparent', opacity: '1', visibility: 'visible',
    transform: 'none', filter: 'none', animation: 'none', transition: 'none',
    'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
    'color-scheme': 'light', direction: 'ltr',
  };
  for (const [key, value] of Object.entries(styles)) host.style.setProperty(key, value, 'important');

  const root = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('style');
  sheet.textContent = `
    :host::backdrop { background: transparent !important; pointer-events: none !important; }
    *, *::before, *::after { box-sizing: border-box; pointer-events: none !important; }
    [hidden] { display: none !important; }
    .scrim { position: absolute; inset: 0; background: ${SCRIM}; }
    .spot, .feedback { position: absolute; left: 0; top: 0; border-radius: ${SPOT_RADIUS}px; }
    .spot { outline: 2px solid ${ACCENT}; background: transparent; }
    .feedback { border: 3px solid; }
    .cursor { position: absolute; left: 0; top: 0; width: 28px; height: 34px;
      filter: drop-shadow(0 2px 3px #0006); transform-origin: 2px 2px; }
    .cursor svg { display: block; width: 28px; height: 34px; overflow: visible; }
    .ripple { position: absolute; width: 30px; height: 30px; border-radius: 50%;
      border: 2px solid ${ACCENT}; background: #4f9cf933; }
  `;
  root.append(sheet);
  const node = (className) => {
    const element = document.createElement('div');
    element.className = className;
    element.hidden = true;
    root.append(element);
    return element;
  };
  const scrim = node('scrim');
  const spot = node('spot');
  const feedback = node('feedback');
  const ripple = node('ripple');
  const cursor = node('cursor');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 28 34');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M2 2 L2 25 L8 19 L13 31 L18 29 L13 17 L23 17 Z');
  path.setAttribute('fill', ACCENT);
  path.setAttribute('stroke', 'white');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  cursor.append(svg);

  (document.body || document.documentElement).append(host);
  // A manual popover enters the top layer without modal behavior/light dismissal.
  // It avoids transformed ancestors and ordinary page stacking contexts.
  if (typeof host.showPopover === 'function') {
    host.setAttribute('popover', 'manual');
    try { host.showPopover(); } catch { host.removeAttribute('popover'); }
  }
  surface = { host, root, scrim, spot, cursor, ripple, feedback };
  notifyRaised();
  stopNavigation = watchNavigation(unmountHost);
  return surface;
}

export function unmountHost() {
  stopNavigation?.();
  stopNavigation = null;
  for (const dispose of disposers) dispose();
  surface?.host.remove();
  surface = null;
}
