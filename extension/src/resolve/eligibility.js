// Shared action-candidate rules for A's resolver and the teaching fallback.
export const parentOf = element => element.assignedSlot || element.parentElement || element.getRootNode()?.host || null;

export function isEnabled(element) {
  if (element?.nodeType !== 1 || element.matches(':disabled')) return false;
  for (let node = element; node; node = parentOf(node)) {
    if (node.getAttribute('aria-disabled')?.trim().toLowerCase() === 'true') return false;
  }
  return true;
}

export function isStateReadout(element) {
  return /\b(?:list|menu)\.\s.+\sselected\.\s*$/i.test(element?.getAttribute?.('aria-label') || '');
}

export function isTeacherUI(element) {
  for (let node = element; node?.nodeType === 1; node = parentOf(node)) {
    if (node.id === 'browser-teacher-root' || node.getAttribute('data-browser-teacher') === 'ui'
      || node.hasAttribute('data-browser-teacher-paint')) return true;
  }
  return false;
}

export function roleOf(element) {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'option') return 'option';
  if (tag === 'dialog') return 'dialog';
  if (tag !== 'input') return '';
  const type = element.type;
  if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
  if (['checkbox', 'radio'].includes(type)) return type;
  if (type === 'range') return 'slider';
  if (type === 'number') return 'spinbutton';
  if (type === 'hidden') return '';
  return type === 'search' ? 'searchbox' : 'textbox';
}

export function collapseNested(matches) {
  const pool = new Set(matches);
  return matches.filter(element => {
    for (let node = parentOf(element); node; node = parentOf(node)) {
      if (pool.has(node)) return false;
    }
    return true;
  });
}
