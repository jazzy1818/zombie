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
    /* Presentation only. The spot's own box-shadow is the scrim cut-out and its
       outline is what feedback.js recolours, so the finish lives on two
       pseudo-elements: a hairline of light just inside the ring keeps the edge
       crisp against the dim, and a soft halo outside it breathes so the eye
       finds the target. The halo follows the outline to green on a correct
       click by matching the inline colour feedback.js writes. */
    .spot::before { content: ''; position: absolute; inset: 0; border-radius: inherit;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.38); }
    .spot::after { content: ''; position: absolute; inset: -2px; border-radius: ${SPOT_RADIUS + 2}px;
      --halo: 79, 156, 249;
      box-shadow: 0 0 0 4px rgba(var(--halo), 0.22), 0 0 30px 6px rgba(var(--halo), 0.38);
      animation: bt-halo 2.2s ease-in-out infinite; }
    .spot[style*="rgb(52, 168, 83)"]::after { --halo: 52, 168, 83; animation: none; }
    @keyframes bt-halo {
      0%, 100% { opacity: 0.55; box-shadow: 0 0 0 4px rgba(var(--halo), 0.22), 0 0 30px 6px rgba(var(--halo), 0.38); }
      50%      { opacity: 1;    box-shadow: 0 0 0 6px rgba(var(--halo), 0.26), 0 0 40px 10px rgba(var(--halo), 0.42); }
    }
    .feedback { border: 2px solid; box-shadow: 0 0 0 4px rgba(234, 67, 53, 0.16), 0 0 28px 4px rgba(234, 67, 53, 0.4); }
    .cursor { position: absolute; left: 0; top: 0; width: 28px; height: 34px;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.3)) drop-shadow(0 6px 10px rgba(0, 0, 0, 0.35));
      transform-origin: 2px 2px; }
    .cursor svg { display: block; width: 28px; height: 34px; overflow: visible; }
    .ripple { position: absolute; width: 30px; height: 30px; border-radius: 50%;
      border: 1.5px solid rgba(79, 156, 249, 0.95); background: rgba(79, 156, 249, 0.16);
      box-shadow: 0 0 22px rgba(79, 156, 249, 0.5); }
    @media (prefers-reduced-motion: reduce) { .spot::after { animation: none; } }
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
