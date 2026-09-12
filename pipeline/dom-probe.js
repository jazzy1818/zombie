// [C] The in-page probe. Injected via addInitScript; used by explore.js, verify.js
// and fallback-demo.js.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// verify.js has to resolve lesson descriptors against a live page — which is exactly
// what A's `extension/src/resolve/` does. But §4 ownership is strict: C never edits, and
// never depends on, another person's directory. Importing A's modules from here would
// couple C's ability to run anything to A's in-flight code, and `resolve/index.js` builds
// `window.__RESOLVE` for a content-script world with different globals anyway.
//
// So this is transcribed from PLAN.md §8.0–8.2 and §8.6 — the SPEC, not A's code.
// Two independent implementations of one written spec is a cross-check, not duplication.
// If they disagree, the spec is ambiguous and we want to know at hour five, not on stage.
// The conformance diff against A's resolver is task T10.
//
// The whole probe is one self-contained function so it can be:
//   - injected:  context.addInitScript(PROBE_SOURCE)
//   - pasted:    straight into DevTools on a live Doc, for console-first development
// Nothing in here may reference an import, a module scope variable, or Node.

export function installProbe() {
  // ---------------------------------------------------------------- §8.0 visibility
  // Apply before every match, at every tier. Docs pre-renders ~200 menu items on load
  // and hides them; an invisible element is never a valid target — it means the user
  // hasn't opened the right menu yet, which is exactly the state a guided step waits on.
  function isVisible(el) {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------------------------------------------------------------- §8.1 two matchers
  // TOOLBAR — aria-label, shortcut in PARENTHESES: "Bold (⌘B)"
  function toolbarMatch(el, name) {
    const label = el.getAttribute('aria-label')
      ?.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return label === name;
  }

  // MENU — textContent, shortcut CONCATENATED with no separator: "Find and replaceCtrl+H"
  // Prefix match also handles "Paragraph styles►" and "Approvals(F2)". Deliberately not
  // a regex: robust against shortcut format, platform, submenu arrows and accelerators.
  function menuMatch(el, name) {
    const t = el.textContent.trim();
    return t === name || t.startsWith(name);
  }

  // ---------------------------------------------------------------- element identity
  // Every candidate gets an integer. The model addresses elements ONLY by that integer,
  // which makes it structurally incapable of picking one of the ~200 hidden menu items:
  // hidden items never get stamped. Stronger than prompting it to prefer visible things.
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

  // ---------------------------------------------------------------- name derivation
  // Turn a raw label into the BARE name the Lesson schema wants (§5 authoring rules).
  // Kept in the probe so `observe()` hands the model names that already look like
  // lesson descriptors — emit.js re-derives independently and validates against these.
  function bare(raw, scope) {
    if (raw == null) return '';
    let t = String(raw).trim();
    if (scope === 'toolbar') return t.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return t
      .replace(/[▶▸►‣]\s*$/, '')        // "Paragraph styles►"
      .replace(/\s*\([A-Za-z0-9]{1,3}\)\s*$/, '')            // "Approvals(F2)"
      .replace(/(?:Ctrl|Alt|Shift|Cmd|⌘|⌥|⇧|⌃)[^\s]*$/, '')  // "Find and replaceCtrl+H"
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

  // Dedupe by element, keeping the first (highest-priority) bucket that claimed it.
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

  // ---------------------------------------------------------------- observe
  function observe() {
    const seen = new Set();
    const toolbar = collect('#docs-toolbar-wrapper [aria-label]', 'toolbar', 'toolbar', seen);

    // The menubar (File, Edit, View...) is an OPEN QUESTION — docs/findings.md flags that
    // it may not carry role="menuitem". Query both shapes and record which one hit in
    // `source`, so T0 answers the question from real output instead of a guess.
    const menubar = [
      ...collect('#docs-menubar [role="menuitem"]', 'menu', 'menubar-role', seen),
      ...collect('#docs-menubar [aria-label]', 'menu', 'menubar-aria', seen),
    ];
    const menu = [...menubar, ...collect('[role="menuitem"]', 'menu', 'menuitem', seen)];
    const dialog = collect(
      '[role="dialog"] [aria-label], [role="dialog"] button', 'dialog', 'dialog', seen,
    );

    return { url: location.href, toolbar, menu, dialog, ts: Date.now() };
  }

  // ---------------------------------------------------------------- §8.2 ladder
  // Every tier filters through isVisible() FIRST. `scope` skips to the relevant tier.
  // Never tier on CSS class names — Docs classes are minified (gb_Je) and change between
  // deploys.
  function tiers(scope) {
    const toolbar = { sel: '#docs-toolbar-wrapper [aria-label]', match: toolbarMatch };
    const menuitem = { sel: '[role="menuitem"]', match: menuMatch };
    const menubarRole = { sel: '#docs-menubar [role="menuitem"]', match: menuMatch };
    const menubarAria = { sel: '#docs-menubar [aria-label]', match: toolbarMatch };
    const any = { sel: '[aria-label]', match: toolbarMatch };

    if (scope === 'toolbar') return [toolbar];
    if (scope === 'menu') return [menubarRole, menuitem, menubarAria];
    return [toolbar, menuitem, menubarRole, any];
  }

  /**
   * Resolve a target to a stamped element id.
   * Returns { id, count, tier } or null. `count` is how many VISIBLE elements matched —
   * emit.js needs it to decide whether `nth` is required.
   */
  function resolve(target) {
    if (!target || !target.name) return null;
    for (const tier of tiers(target.scope)) {
      const hits = qsa(tier.sel).filter(el => isVisible(el) && tier.match(el, target.name));
      if (!hits.length) continue;
      const el = hits[target.nth ?? 0];
      if (!el) continue;      // nth out of range at this tier — try the next one
      return { id: stamp(el), count: hits.length, tier: tier.sel };
    }
    return null;
  }

  // ---------------------------------------------------------------- §8.6 verification
  // Prefer outcome over click. This is what gives alternate correct paths for free: if
  // the user hits Ctrl+Alt+1 instead of navigating the menu, the outcome is identical
  // and the step passes.
  function check(v) {
    if (!v || v.kind === 'none') return true;
    if (v.kind === 'label') {
      const el = document.querySelector(v.selector);
      return !!el && el.textContent.includes(v.match);
    }
    if (v.kind === 'dom') {
      const el = document.querySelector(v.selector);
      return isVisible(el);
    }
    if (v.kind === 'visible') return resolve({ name: v.name, scope: v.scope }) !== null;
    return false;
  }

  window.__PROBE = {
    observe,
    resolve,
    check,
    isVisible,
    bare,
    el: id => byId.get(Number(id)) ?? document.querySelector(`[data-bt-id="${id}"]`),
    // Escape hatch only. explore/verify click through Playwright so Docs sees a real
    // pointer sequence — it listens on capture phase and its menus dismiss on blur.
    click(id) {
      const el = this.el(id);
      if (!el) return { ok: false };
      el.click();
      return { ok: true, name: bare(el.getAttribute('aria-label') ?? el.textContent, 'menu') };
    },
  };
  return true;
}

/** Injectable / pasteable source. `context.addInitScript(PROBE_SOURCE)`. */
export const PROBE_SOURCE = `(${installProbe.toString()})();`;
