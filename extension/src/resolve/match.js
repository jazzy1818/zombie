// [A] PLAN.md §8.1 — two match strategies, because the toolbar and the menus
// use different label formats.

// TOOLBAR — aria-label, parenthesised shortcut: "Bold (⌘B)"
export function toolbarMatch(el, name) {
  const label = el.getAttribute('aria-label')
    ?.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return label === name;
}

// MENU — textContent, concatenated shortcut: "Find and replaceCtrl+H"
// Prefix match also handles "Paragraph styles►" and "Approvals(F2)".
// Deliberate: robust against shortcut format, platform, submenu arrows and
// accelerators, without a fragile regex.
export function menuMatch(el, name) {
  const t = el.textContent.trim();
  return t === name || t.startsWith(name);
}
