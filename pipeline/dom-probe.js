// [C] In-page probe, transcribed from PLAN.md §8.0-8.2 and §8.6 — the spec, not A's
// resolve/. Don't replace this with an import from A's directory: different world,
// different globals, and two implementations of one spec is a deliberate cross-check.
//
// Self-contained so it can be addInitScript'd or pasted into DevTools. No imports,
// no module scope, no Node.

export function installProbe() {
  function isVisible(el) {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isEnabled(el) {
    return el.getAttribute('aria-disabled') !== 'true';
  }

  // toolbar: aria-label with the shortcut in parens, "Bold (⌘B)"
  function toolbarMatch(el, name) {
    const label = el.getAttribute('aria-label')
      ?.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return label === name;
  }

  // menu: textContent with the shortcut concatenated, "Find and replaceCtrl+H".
  // Prefix, not regex — survives platform, submenu arrows and accelerators.
  function menuMatch(el, name) {
    const t = el.textContent.trim();
    return t === name || t.startsWith(name);
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
    return t
      .replace(/[▶▸►‣]\s*$/, '')
      .replace(/\s*\([A-Za-z0-9]{1,3}\)\s*$/, '')
      .replace(/(?:Ctrl|Alt|Shift|Cmd|⌘|⌥|⇧|⌃)[^\s]*$/, '')
      .trim();
  }

  const qsa = sel => Array.from(document.querySelectorAll(sel));

  function cand(el, scope, source) {
    const raw = scope === 'toolbar' || scope === 'dialog'
      ? (el.getAttribute('aria-label') ?? el.textContent.trim())
      : el.textContent.trim();
    const c = {
      id: stamp(el),
      name: bare(raw, scope === 'menu' ? 'menu' : 'toolbar'),
      raw,
      scope,
      source,
    };
    if (/[▶▸►‣]\s*$/.test(raw)) c.submenu = true;
    if (el.getAttribute('aria-disabled') === 'true') c.disabled = true;
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
      ...collect('[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"]',
        'menu', 'option', seen),
    ];
    const dialog = collect(
      '[role="dialog"] [aria-label], [role="dialog"] button', 'dialog', 'dialog', seen,
    );

    return { url: location.href, toolbar, menu, dialog, ts: Date.now() };
  }

  // Never tier on CSS classes — Docs minifies them (gb_Je) and they change between deploys.
  function tiers(scope) {
    const toolbar = { sel: '#docs-toolbar-wrapper [aria-label]', match: toolbarMatch };
    const menuitem = { sel: '[role="menuitem"]', match: menuMatch };
    const menubarRole = { sel: '#docs-menubar [role="menuitem"]', match: menuMatch };
    const menubarAria = { sel: '#docs-menubar [aria-label]', match: toolbarMatch };
    const option = {
      sel: '[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"]',
      match: menuMatch,
    };
    const any = { sel: '[aria-label]', match: toolbarMatch };

    if (scope === 'toolbar') return [toolbar];
    if (scope === 'menu') return [menubarRole, menuitem, option, menubarAria];
    return [toolbar, menuitem, option, menubarRole, any];
  }

  /** → { id, count, tier } | null. `count` is visible matches; emit needs it for nth. */
  function resolve(target) {
    if (!target || !target.name) return null;
    for (const tier of tiers(target.scope)) {
      // Disabled items still resolve — §5's `visible` verify means visible, not clickable.
      // Callers about to click check `disabled` themselves.
      const hits = qsa(tier.sel).filter(el => isVisible(el) && tier.match(el, target.name));
      if (!hits.length) continue;
      const el = hits[target.nth ?? 0];
      if (!el) continue;
      return { id: stamp(el), count: hits.length, tier: tier.sel, disabled: !isEnabled(el) };
    }
    return null;
  }

  function check(v) {
    if (!v || v.kind === 'none') return true;
    if (v.kind === 'label') {
      const el = document.querySelector(v.selector);
      return !!el && el.textContent.includes(v.match);
    }
    if (v.kind === 'dom') return isVisible(document.querySelector(v.selector));
    if (v.kind === 'visible') return resolve({ name: v.name, scope: v.scope }) !== null;
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
