// [A] PLAN.md §8.1 — two match strategies, because the toolbar and the menus
// use different label formats.

// TOOLBAR — aria-label, parenthesised shortcut: "Bold (⌘B)"
export function toolbarMatch(el, name) {
  if (el?.nodeType !== 1 || typeof name !== 'string') return false;

  const expected = name.trim();
  if (!expected) return false;

  const labelledBy = el.getAttribute('aria-labelledby');
  const label = el.getAttribute('aria-label') || (labelledBy && labelledBy.split(/\s+/)
    .map(id => el.getRootNode().getElementById?.(id)?.textContent || '').join(' '));
  if (!label) return false;

  return label.replace(/\s*\([^)]*\)\s*$/, '').trim() === expected;
}

// MENU — textContent, concatenated shortcut: "Find and replaceCtrl+H"
// Prefix match also handles "Paragraph styles►" and "Approvals(F2)".
// Deliberate: robust against shortcut format, platform, submenu arrows and
// accelerators, without a fragile regex.
export function menuMatch(el, name) {
  if (el?.nodeType !== 1 || typeof name !== 'string') return false;

  const expected = name.trim();
  if (!expected) return false;

  // Options may be icon-only or name themselves in aria-label rather than text.
  if (toolbarMatch(el, expected)) return true;
  // A listbox owns options; its concatenated option text is not its own name.
  if (el.getAttribute('role') === 'listbox') return false;

  const text = el.textContent?.trim();
  if (!text) return false;

  // Current Docs exposes style choices as "Heading 1►" menuitemradio rows,
  // while older Docs exposed their action as "Apply 'Heading 1'". Accept both
  // semantic forms so existing lessons survive that markup change.
  const applyPrefix = "Apply '";
  const radioExpected = el.getAttribute('role') === 'menuitemradio'
    && expected.startsWith(applyPrefix)
    && expected.endsWith("'")
    ? expected.slice(applyPrefix.length, -1)
    : expected;

  if (text === radioExpected) return true;
  if (!text.startsWith(radioExpected)) return false;

  // Docs glues shortcuts and submenu arrows directly to the label. A longer
  // semantic label starts with whitespace ("Table" vs "Table of contents")
  // and must not be treated as the same control.
  const suffix = text.slice(radioExpected.length).trim();
  return /^[►▸▶›»]$/.test(suffix)
    || /^(?:Updated|New)\s*[►▸▶›»]?$/i.test(suffix)
    || /^(?:\(?\s*(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|⌘|⌥|⇧|F\d{1,2})(?:\b|[+⌘⌥⇧]).*\)?)$/i.test(suffix);
}
