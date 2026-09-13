// Candidate-only counterpart of the DOM resolver. Observations retain state and
// disabled controls for verification, but authored actions cannot target them.
export const isStateName = name => /\b(?:list|menu)\.\s.+\sselected\.\s*$/i.test(String(name || ''));

export function matchesCandidate(candidate, name, scope) {
  const label = (candidate.label ?? (scope === 'toolbar' ? candidate.raw : '')).replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (label === name) return true;
  if (scope === 'toolbar' || candidate.role === 'listbox') return false;
  const text = String(candidate.raw || '').trim();
  if (text === name) return true;
  if (!text.startsWith(name)) return false;
  const rest = text.slice(name.length);
  const suffix = rest.trim();
  return /^(?:(?:Updated|New)\s*)?[►▸▶›»]$/.test(suffix) || /^(?:Updated|New)$/.test(suffix)
    || /^(?:\(?\s*(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|⌘|⌥|⇧|F\d{1,2})(?:\b|[+⌘⌥⇧]).*\)?)$/i.test(suffix)
    // Single-key accelerators, glued on with no separator: Docs ships "Text(S)",
    // "Details(B)", "Add shortcut to Drive(,)". Without this the bare label matches
    // nothing, and the accelerator ends up in the authored descriptor.
    || /^\([^\s()]\)$/.test(suffix)
    // Outside Docs the trailing noise is a count badge rather than a shortcut:
    // GitHub's "Issues 12", Gmail's "Inbox 1,203". Same rule as matchesName in
    // the runtime resolver — if these drift, the pipeline authors a target the
    // extension cannot resolve.
    //
    // Whitespace-separated, or "Heading 1" swallows "Heading 10": the suffix "0"
    // reads as a badge, the two collapse into one ambiguous match, and neither resolves.
    || (/^\s/.test(rest) && /^\(?\d[\d,.\u202f\u00a0]*\+?k?\)?$/i.test(suffix));
}

export function candidatePool(pool, name, scope, { actionable = true } = {}) {
  let matches = pool.filter(candidate => (!actionable || (!candidate.disabled && !candidate.state && !isStateName(candidate.raw)))
    && matchesCandidate(candidate, name, scope));
  // Semantic menu roles own the tier before the legacy menubar ARIA fallback.
  if (scope === 'menu') {
    const semantic = matches.filter(candidate => candidate.source !== 'menubar-aria');
    if (semantic.length) matches = semantic;
  }
  const ids = new Set(matches.map(candidate => candidate.id));
  return matches.filter(candidate => !(candidate.ancestors || []).some(id => ids.has(id)))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function canonicalTarget(matches, clicked) {
  return matches.find(candidate => candidate.id === clicked.id)
    || matches.find(candidate => (clicked.ancestors || []).includes(candidate.id)) || null;
}
