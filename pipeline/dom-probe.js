// [C] In-page probe, transcribed from PLAN.md §8.0-8.2 and §8.6 — the spec, not A's
// resolve/. Don't replace this with an import from A's directory: different world,
// different globals, and two implementations of one spec is a deliberate cross-check.
//
// Self-contained so it can be addInitScript'd or pasted into DevTools. No imports,
// no module scope, no Node.

export function installProbe() {
  function isVisible(el) {
    if (!el?.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    for (let node = el; node; node = node.assignedSlot || node.parentElement || node.getRootNode()?.host) {
      if (node.inert || node.getAttribute('aria-hidden') === 'true' || node.id === 'browser-teacher-root'
        || node.getAttribute('data-browser-teacher') === 'ui' || node.hasAttribute('data-browser-teacher-paint')) return false;
      const css = getComputedStyle(node);
      if (css.display === 'none' || css.opacity === '0' || css.contentVisibility === 'hidden') return false;
      if (node === el && ['hidden', 'collapse'].includes(css.visibility)) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isEnabled(el) {
    if (el.matches(':disabled')) return false;
    for (let node = el; node; node = node.assignedSlot || node.parentElement || node.getRootNode()?.host) {
      if (node.getAttribute('aria-disabled')?.trim().toLowerCase() === 'true') return false;
    }
    return true;
  }
  const isStateName = name => /\b(?:list|menu)\.\s.+\sselected\.\s*$/i.test(String(name || ''));
  const collapseNested = matches => matches.filter(el => !matches.some(other => other !== el && other.contains(el)));

  // toolbar: aria-label with the shortcut in parens, "Bold (⌘B)"
  function toolbarMatch(el, name) {
    const labelledBy = el.getAttribute('aria-labelledby');
    const label = (el.getAttribute('aria-label') || (labelledBy && labelledBy.split(/\s+/)
      .map(id => el.getRootNode().getElementById?.(id)?.textContent || '').join(' ')))
      ?.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return label === name;
  }

  // menu: textContent with the shortcut concatenated, "Find and replaceCtrl+H".
  // Prefix, not regex — survives platform, submenu arrows and accelerators.
  function menuMatch(el, name) {
    if (toolbarMatch(el, name)) return true;
    if (el.getAttribute('role') === 'listbox') return false;
    const t = el.textContent.trim();
    if (t === name) return true;
    if (!t.startsWith(name)) return false;
    const suffix = t.slice(name.length).trim();
    return /^(?:(?:Updated|New)\s*)?[►▸▶›»]$/.test(suffix) || /^(?:Updated|New)$/.test(suffix)
      || /^(?:\(?\s*(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|⌘|⌥|⇧|F\d{1,2})(?:\b|[+⌘⌥⇧]).*\)?)$/i.test(suffix);
  }

  // Only visible elements get stamped, so a model addressing elements by id cannot
  // reach the ~200 hidden menu items Docs pre-renders.
  let seq = 0;
  const byId = new Map();
  function stamp(el) {
    let id = el.getAttribute('data-bt-id');
    if (id !== null && byId.get(Number(id)) === el) return Number(id);
    id = seq++;
    el.setAttribute('data-bt-id', String(id));
    byId.set(id, el);
    return id;
  }

  function bare(raw, scope) {
    if (raw == null) return '';
    const t = String(raw).trim();
    if (scope === 'toolbar') return t.replace(/\s*\([^)]*\)\s*$/, '').trim();
    // A shortcut is one or two chords glued to the label ("Find and replaceCtrl+H",
    // "HeaderCtrl+Alt+O, Ctrl+Alt+H"). Match from the first modifier that is
    // followed by "+"/glyph to the end, over shortcut chars and separators, so
    // both chords go. Requiring the "+"/glyph spares words like "Alternative".
    // Keep this identical to stripShortcut in emit.js.
    return t
      .replace(/[▶▸►‣]\s*$/, '')
      .replace(/\s*\([A-Za-z0-9]{1,3}\)\s*$/, '')
      .replace(/(?:(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|Fn)\s*\+|[⌘⌥⇧⌃])[A-Za-z0-9+\s,⌘⌥⇧⌃]*$/, '')
      .replace(/[\s,]+$/, '')
      .trim();
  }

  const qsa = sel => Array.from(document.querySelectorAll(sel));

  function cand(el, scope, source) {
    const raw = scope === 'toolbar' || scope === 'dialog'
      ? (el.getAttribute('aria-label') ?? el.textContent.trim())
      : (el.textContent.trim() || el.getAttribute('aria-label') || '');
    const c = {
      id: stamp(el),
      name: bare(raw, scope === 'menu' ? 'menu' : 'toolbar'),
      raw,
      scope,
      source,
      label: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
    };
    // "Zoom list. 100% selected." — Docs writes the current value into these aria-labels.
    // Great verify signal, fatal as a descriptor: the name changes when the value does.
    if (isStateName(raw)) c.state = true;
    if (/[▶▸►‣]\s*$/.test(raw)) c.submenu = true;
    if (!isEnabled(el)) c.disabled = true;
    if (el.getAttribute('aria-checked') === 'true') c.checked = true;
    return c;
  }

  function collect(sel, scope, source, seen) {
    const out = [];
    for (const el of qsa(sel)) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      const c = cand(el, scope, source);
      if (c.name) out.push(c);
    }
    return out;
  }

  function observe() {
    const seen = new Set();
    const toolbar = collect('#docs-toolbar-wrapper [aria-label]', 'toolbar', 'toolbar', seen);

    // Unresolved: the menubar may not carry role="menuitem". Query both and record which
    // hit in `source` so the answer comes from output rather than a guess.
    const menubar = [
      ...collect('#docs-menubar [role="menuitem"]', 'menu', 'menubar-role', seen),
      ...collect('#docs-menubar [aria-label]', 'menu', 'menubar-aria', seen),
    ];
    // Docs' toolbar dropdowns (Styles, Font, Zoom) are listboxes whose children are
    // role=option, not menuitem. Both count as "menu" for a lesson descriptor.
    const menu = [
      ...menubar,
      ...collect('[role="menuitem"]', 'menu', 'menuitem', seen),
      ...collect('[role="option"], [role="listbox"], [role="menuitemradio"], [role="menuitemcheckbox"]',
        'menu', 'option', seen),
    ];
    const dialog = collect(
      '[role="dialog"] [aria-label], [role="dialog"] button', 'dialog', 'dialog', seen,
    );

    const all = [...toolbar, ...menu, ...dialog].sort((a, b) => {
      const position = byId.get(a.id).compareDocumentPosition(byId.get(b.id));
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    all.forEach((candidate, order) => {
      candidate.order = order;
      candidate.ancestors = all.filter(other => other.id !== candidate.id && byId.get(other.id).contains(byId.get(candidate.id))).map(other => other.id);
    });
    menu.sort((a, b) => a.order - b.order);
    return { url: location.href, toolbar, menu, dialog, ts: Date.now() };
  }

  // Never tier on CSS classes — Docs minifies them (gb_Je) and they change between deploys.
  function tiers(scope) {
    const toolbar = { sel: '#docs-toolbar-wrapper [aria-label]', match: toolbarMatch };
    const menuitem = { sel: '[role="menuitem"], [role="option"], [role="listbox"], [role="menuitemradio"], [role="menuitemcheckbox"]', match: menuMatch };
    const menubarAria = { sel: '#docs-menubar [aria-label]', match: toolbarMatch };
    const any = { sel: '[aria-label]', match: toolbarMatch };

    if (scope === 'toolbar') return [toolbar];
    if (scope === 'menu') return [menuitem, menubarAria];
    return [toolbar, menuitem, any];
  }

  /** → { id, count, tier } | null. `count` is visible matches; emit needs it for nth. */
  function resolve(target, { actionable = true } = {}) {
    if (!target || !target.name) return null;
    if (actionable && isStateName(target.name)) return null;
    if (target.nth !== undefined && (!Number.isInteger(target.nth) || target.nth < 0)) return null;
    for (const tier of tiers(target.scope)) {
      // A visibility-only outcome may inspect disabled/state readouts. Action
      // resolution filters them before canonicalizing nested hits and nth.
      const visible = qsa(tier.sel).filter(el => isVisible(el) && tier.match(el, target.name));
      const eligible = visible.filter(el => !actionable || (isEnabled(el) && !isStateName(el.getAttribute('aria-label'))));
      const hits = collapseNested(eligible);
      if (!hits.length) continue;
      if (target.nth === undefined && hits.length !== 1) return null;
      const el = hits[target.nth ?? 0];
      if (!el) return null;
      return { id: stamp(el), count: hits.length, tier: tier.sel, disabled: !isEnabled(el) };
    }
    return null;
  }

  function check(v) {
    if (!v || v.kind === 'none') return true;
    if (v.kind === 'label') {
      const expected = typeof v.match === 'string' ? v.match.trim() : '';
      if (!expected) return false;
      return qsa(v.selector).some(el => isVisible(el)
        && [el.textContent, el.getAttribute('aria-label') || ''].some(value => value.includes(expected)));
    }
    if (v.kind === 'dom') return isVisible(document.querySelector(v.selector));
    if (v.kind === 'visible') return resolve({ name: v.name, scope: v.scope }, { actionable: false }) !== null;
    return false;
  }

  window.__PROBE = {
    observe,
    resolve,
    check,
    isVisible,
    isEnabled,
    bare,
    el: id => byId.get(Number(id)) ?? document.querySelector(`[data-bt-id="${id}"]`),
    // Escape hatch. explore/verify click through Playwright so Docs sees a real pointer
    // sequence — it listens on capture phase and its menus dismiss on blur.
    click(id) {
      const el = this.el(id);
      if (!el) return { ok: false };
      el.click();
      return { ok: true, name: bare(el.getAttribute('aria-label') ?? el.textContent, 'menu') };
    },
  };
  return true;
}

export const PROBE_SOURCE = `(${installProbe.toString()})();`;
