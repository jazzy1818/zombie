// The browser exposes a pointer location only while it is inside this document.
// Keep that location independently of the overlay, so clear/remount do not lose
// the real mouse origin. These passive listeners live once per module/document.
let position = null;

function isRealPointer(event) {
  return event.isTrusted && (event.pointerType === 'mouse' || event.pointerType === 'pen');
}

function remember(event) {
  if (!isRealPointer(event)) return;
  const { clientX: x, clientY: y } = event;
  position = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function forget() {
  position = null;
}

function leave(event) {
  if (isRealPointer(event) && event.relatedTarget === null) forget();
}

const passiveCapture = { capture: true, passive: true };
document.addEventListener('pointermove', remember, passiveCapture);
document.addEventListener('pointerdown', remember, passiveCapture);
document.addEventListener('pointerout', leave, passiveCapture);
window.addEventListener('pagehide', forget);
window.addEventListener('blur', forget);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') forget();
});

export function getPointerPosition() {
  if (!position) return null;
  const { x, y } = position;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
  return { x, y };
}
