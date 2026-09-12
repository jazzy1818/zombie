// [B] Drag-to-move and drag-to-resize for the lesson window.
//
// Pointer Events rather than mouse events so it survives trackpad and touch,
// and setPointerCapture so a fast drag that outruns the cursor doesn't drop the
// gesture the moment it leaves the handle.
//
// Every gesture starts with preventDefault(). That stops text selection, and
// more importantly stops focus moving — Docs menus dismiss on blur, so dragging
// the window must never close the menu the lesson is pointing at.

const MIN_W = 300;
const MIN_H = 240;
const EDGE = 8;   // keep at least this much of the window on screen

export function makeFloating(el, { handle, resizer }) {
  let x = 0, y = 0, w = 0, h = 0;

  function apply() {
    const maxX = Math.max(EDGE - w + 40, window.innerWidth - w - EDGE);
    const maxY = Math.max(EDGE, window.innerHeight - h - EDGE);
    x = Math.min(Math.max(x, EDGE), Math.max(EDGE, maxX));
    y = Math.min(Math.max(y, EDGE), maxY);

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }

  function place({ left, top, width, height }) {
    x = left; y = top; w = width; h = height;
    apply();
  }

  /** One gesture: track the delta from where the pointer went down. */
  function gesture(target, onMove) {
    target.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;

      // The header doubles as the drag handle and as a toolbar. Capturing the
      // pointer retargets the following `click` to the capturing element, so
      // starting a drag from a button swallows that button's click entirely.
      // Let controls have their clicks; drag from the bare header instead.
      if (e.target.closest?.('button, input, textarea, select, a')) return;

      e.preventDefault();       // no focus steal, no text selection
      e.stopPropagation();

      const startX = e.clientX, startY = e.clientY;
      const from = { x, y, w, h };
      target.setPointerCapture(e.pointerId);
      el.classList.add('is-dragging');

      const move = ev => {
        onMove(ev.clientX - startX, ev.clientY - startY, from);
        apply();
      };
      const up = () => {
        target.releasePointerCapture(e.pointerId);
        el.classList.remove('is-dragging');
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
      };

      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  }

  gesture(handle, (dx, dy, from) => {
    x = from.x + dx;
    y = from.y + dy;
  });

  gesture(resizer, (dx, dy, from) => {
    w = Math.max(MIN_W, from.w + dx);
    h = Math.max(MIN_H, from.h + dy);
  });

  // A window parked against the right edge shouldn't sail off-screen when the
  // browser is resized — which happens on stage more than you'd like.
  window.addEventListener('resize', apply);

  return { place, apply };
}
