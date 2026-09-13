// Document exits and SPA route changes invalidate local element references.
// Fragment-only scrolling is still the same page and keeps guidance active.
import { siteKey } from '../sites.js';

const siteOf = (value = location.href) => siteKey(value);

export function pageKey(value = location.href) {
  const url = new URL(value, location.href);
  return `${url.origin}${url.pathname}${url.search}`;
}

/**
 * @param {() => void} onLeave
 * @param {object} [options]
 * @param {boolean} [options.site]  Treat a route change inside the same app as
 *   staying put, and only leave when the host changes.
 *
 *   Docs lessons never navigate, so cancelling on any route change was free.
 *   Everywhere else it is fatal: GitHub swaps the whole path to open Issues,
 *   Gmail does the same to open Settings, and a lesson that says "click
 *   Issues" would cancel itself on the click it just asked for. Opt-in per
 *   lesson (`"navigates": true`) so nothing that works today changes.
 */
export function watchNavigation(onLeave, { site = false } = {}) {
  const key = site ? siteOf : pageKey;
  const initial = key();
  let stopped = false;
  let interval = null;
  const navigation = window.navigation;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('pagehide', leave);
    window.removeEventListener('popstate', check);
    window.removeEventListener('hashchange', check);
    navigation?.removeEventListener('navigate', navigate);
    navigation?.removeEventListener('currententrychange', check);
    if (interval !== null) clearInterval(interval);
  };
  function leave() { stop(); onLeave(); }
  function check() { if (key() !== initial) leave(); }
  function navigate(event) {
    if (event.downloadRequest !== null && event.downloadRequest !== undefined) return;
    if (!event.destination.sameDocument || key(event.destination.url) !== initial) leave();
  }
  window.addEventListener('pagehide', leave);
  window.addEventListener('popstate', check);
  window.addEventListener('hashchange', check);
  navigation?.addEventListener('navigate', navigate);
  navigation?.addEventListener('currententrychange', check);
  // Older browsers do not emit popstate for pushState/replaceState. Poll only
  // while this watcher is owned, without patching a website's history methods.
  if (!navigation) interval = setInterval(check, 100);
  return stop;
}
