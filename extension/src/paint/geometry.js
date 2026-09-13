// [D] All boxes use this document's viewport CSS pixels, including SVG/shadow DOM.
export function isElement(box) {
  return box?.nodeType === 1 && typeof box.getBoundingClientRect === 'function';
}

export function normalizeBox(box) {
  if (isElement(box)) {
    if (box.ownerDocument !== document) {
      throw new TypeError('Paint needs an Element from this document. Run paint in the target frame or pass a translated viewport rectangle.');
    }
    return box;
  }
  const keys = ['top', 'left', 'width', 'height'];
  if (!box || !keys.every(key => typeof box[key] === 'number' && Number.isFinite(box[key]))) {
    throw new TypeError('Paint expects an Element or finite {top,left,width,height} rectangle.');
  }
  if (box.width < 0 || box.height < 0) throw new RangeError('Paint rectangle dimensions cannot be negative.');
  return Object.fromEntries(keys.map(key => [key, box[key]]));
}

export function parentOf(element) {
  return element.assignedSlot || element.parentElement || element.getRootNode()?.host || null;
}

export function isRendered(element) {
  if (!element.isConnected || !element.getClientRects().length) return false;
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({
    checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true,
  })) return false;
  // Fallback also checks opacity on ancestors (including across shadow roots).
  for (let current = element; current; current = parentOf(current)) {
    const css = getComputedStyle(current);
    if (css.display === 'none' || css.contentVisibility === 'hidden' || Number(css.opacity) === 0) return false;
    if (current === element && (css.visibility === 'hidden' || css.visibility === 'collapse')) return false;
  }
  return true;
}

function intersect(a, b, clipX = true, clipY = true) {
  const left = clipX ? Math.max(a.left, b.left) : a.left;
  const top = clipY ? Math.max(a.top, b.top) : a.top;
  const right = clipX ? Math.min(a.left + a.width, b.left + b.width) : a.left + a.width;
  const bottom = clipY ? Math.min(a.top + a.height, b.top + b.height) : a.top + a.height;
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function readRect(box, clipped = true) {
  if (isElement(box) && !isRendered(box)) return null;
  const raw = isElement(box) ? box.getBoundingClientRect() : box;
  let rect = { top: raw.top, left: raw.left, width: raw.width, height: raw.height };
  if (!clipped) return rect.width > 0 && rect.height > 0 ? rect : null;
  // Most site controls are clipped by ordinary scroll containers. Out-of-flow
  // descendants can escape intermediate containers; start at their containing block.
  if (isElement(box)) {
    let positioned = box;
    let position = getComputedStyle(box).position;
    let clipActive = position !== 'fixed' && position !== 'absolute';
    for (let parent = parentOf(box); parent; parent = parentOf(parent)) {
      const css = getComputedStyle(parent);
      const containingBlock = css.transform !== 'none' || css.perspective !== 'none'
        || css.filter !== 'none' || (css.backdropFilter && css.backdropFilter !== 'none')
        || ['translate', 'rotate', 'scale'].some(property => css[property] && css[property] !== 'none')
        || /paint|layout|strict|content/.test(css.contain)
        || /transform|perspective|filter|contain|translate|rotate|scale/.test(css.willChange)
        || css.contentVisibility === 'auto';
      if (containingBlock || (position === 'absolute' && parent === positioned.offsetParent)) clipActive = true;
      const paintContained = /paint|strict|content/.test(css.contain) || css.contentVisibility === 'auto';
      const clipX = paintContained || /hidden|clip|scroll|auto/.test(css.overflowX);
      const clipY = paintContained || /hidden|clip|scroll|auto/.test(css.overflowY);
      if (clipActive && parent !== document.body && parent !== document.documentElement && (clipX || clipY)) {
        const bounds = parent.getBoundingClientRect();
        const scaleX = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
        const scaleY = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
        rect = intersect(rect, {
          left: bounds.left + parent.clientLeft * scaleX,
          top: bounds.top + parent.clientTop * scaleY,
          width: parent.clientWidth * scaleX, height: parent.clientHeight * scaleY,
        }, clipX, clipY);
      }
      // A static target can live inside a fixed/absolute wrapper. That wrapper's
      // own overflow clips its children; ancestors it escapes must not clip them.
      if (css.position === 'fixed' || css.position === 'absolute') {
        positioned = parent;
        position = css.position;
        clipActive = false;
      }
    }
  }
  rect = intersect(rect, { top: 0, left: 0, width: document.documentElement.clientWidth, height: window.innerHeight });
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

export function sameRect(a, b) {
  return a && b && ['top', 'left', 'width', 'height'].every(key => a[key] === b[key]);
}

export function placeRect(element, rect, padding = 0) {
  Object.assign(element.style, {
    left: `${rect.left - padding}px`, top: `${rect.top - padding}px`,
    width: `${rect.width + padding * 2}px`, height: `${rect.height + padding * 2}px`,
  });
}
