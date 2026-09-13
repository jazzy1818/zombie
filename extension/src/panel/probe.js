// Authoring aid: what can this page actually be taught to do?
//
// Writing a lesson for a new site is guesswork until you know the exact
// accessible names the resolver will see, and guessing is how you ship a
// lesson whose every step silently resolves nothing. `Insert` in the DOM might
// be `Insert menu`; GitHub's Issues tab reads as `Issues 12`; a button you can
// see might have no name at all.
//
// So don't guess — open the target app, open the extension's console, and ask:
//
//   __BT_DEV.probe()                    every nameable control, by scope
//   __BT_DEV.probe('new')               only the ones matching a substring
//   __BT_DEV.probe({ scope: 'menu' })   only what a menu-scoped target can hit
//
// Each row is the exact `target` a lesson step should carry. `count` above 1
// means the name is ambiguous and the step needs `nth` — which is the single
// most common reason a hand-written lesson fails on the day.
//
// This reads through the same functions the runner uses, so what it prints is
// what findTarget() will find, not a second opinion that can drift from it.

import { CONTROL, ACTION_ROLES, queryDeep, usable, accessibleName, roleOf, withinScope } from '../teaching/resolution.js';
import { siteKey } from '../sites.js';

const SCOPES = ['toolbar', 'menu', 'dialog'];

/**
 * @param {string|object} [filter]  substring to match, or { scope, role, match }
 * @returns {Array<{name, scope, role, count, nth}>} one row per distinct target
 */
export function probe(filter = {}) {
  const { match = '', scope: wantScope, role: wantRole } =
    typeof filter === 'string' ? { match: filter } : filter;
  const needle = String(match).toLowerCase();

  const byKey = new Map();
  for (const element of queryDeep(CONTROL)) {
    if (!usable(element)) continue;
    const role = roleOf(element);
    // findTarget only accepts an unroled or action-roled element unless the
    // target names a role explicitly. Mirror that, or the list promises
    // targets the runner would refuse.
    if (role && !ACTION_ROLES.has(role)) continue;
    const name = accessibleName(element);
    if (!name) continue;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    if (wantRole && role !== wantRole) continue;

    // The narrowest scope that still contains it — that's what a lesson should
    // say, because a narrow scope is what stops `Insert` in a dialog matching
    // `Insert` in the menu bar.
    const scope = SCOPES.find(s => withinScope(element, s)) ?? 'any';
    if (wantScope && wantScope !== 'any' && scope !== wantScope) continue;

    const key = [scope, role, name].join(' | ');
    const row = byKey.get(key) ?? { name, scope, role: role || '(none)', count: 0 };
    row.count += 1;
    byKey.set(key, row);
  }

  const rows = [...byKey.values()].sort((a, b) => a.scope.localeCompare(b.scope)
    || a.name.localeCompare(b.name));
  // A unique name needs no nth; an ambiguous one cannot be taught without it.
  for (const row of rows) row.nth = row.count > 1 ? 'needs nth' : '';

  console.log(`%c[bt-probe] ${rows.length} nameable controls on ${siteKey() || 'this page'}`,
    'color:#4F9CF9;font-weight:bold');
  console.table(rows, ['name', 'scope', 'role', 'count', 'nth']);
  console.log('Open the menu or dialog you want to teach, then run this again — '
    + 'a control that is not on screen is not resolvable and will not be listed.');
  return rows;
}

/**
 * Does this exact target resolve, right now? The other half of authoring:
 * probe() tells you what exists, this tells you whether the descriptor you
 * wrote picks out one control or none.
 *
 *   __BT_DEV.check({ name: 'New issue' })
 *   __BT_DEV.check({ name: 'Insert', scope: 'menu' })
 */
export function check(target, findTarget) {
  const element = findTarget(target);
  if (element) {
    console.log('%c[bt-probe] resolves', 'color:#34A853;font-weight:bold', element);
    element.scrollIntoView({ block: 'center' });
  } else {
    console.log('%c[bt-probe] no match', 'color:#EA4335;font-weight:bold',
      '- try probe(name) to see how the page actually spells it');
  }
  return element;
}
