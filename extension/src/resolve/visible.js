// [A] Apply before every match, at every tier.
// Tests CSS visibility and a usable box, not viewport intersection or occlusion:
// paint may need to scroll an offscreen target into view after resolution.

export function isVisible(el) {
  if (el?.nodeType !== 1 || !el.isConnected) return false;

  const view = el.ownerDocument?.defaultView;
  if (!view) return false;

  // Unlike offsetParent, this works for visible fixed-position controls.
  if (typeof el.checkVisibility === 'function') {
    if (!el.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      checkOpacity: true,
      checkVisibilityCSS: true,
    })) {
      return false;
    }
  } else {
    const visibility = view.getComputedStyle(el).visibility;
    if (visibility === 'hidden' || visibility === 'collapse') return false;

    // Opacity is not inherited, and shadow/slot ancestors can hide a control.
    // Check visibility only on el: a child can override visibility: hidden.
    for (let node = el; node; node = node.assignedSlot || node.parentElement || node.getRootNode().host) {
      const style = view.getComputedStyle(node);
      if (style.display === 'none' || style.opacity === '0') return false;
      if (node !== el && style.contentVisibility === 'hidden') return false;
    }
  }

  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
