// Document exits and SPA route changes invalidate local element references.
// Fragment-only scrolling is still the same page and keeps guidance active.

// Editors own their own query string — Docs rewrites ?tab=t.0 as you work, with no
// navigation behind it. Keying on `search` there made an ordinary click read as leaving
// the page, which cancelled the lesson and closed the panel under the learner. The
// document id is the identity that actually matters; moving to a different document
// still changes it.
const EDITOR_DOC = /^\/(document|spreadsheets|presentation|forms)\/d\/([^/]+)/;

export function pageKey(value = location.href) {
  const url = new URL(value, location.href);
  const doc = url.hostname === 'docs.google.com' && url.pathname.match(EDITOR_DOC);
  if (doc) return `${url.origin}/${doc[1]}/d/${doc[2]}`;
  return `${url.origin}${url.pathname}${url.search}`;
}

export function watchNavigation(onLeave) {
  const initial = pageKey();
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
  function check() { if (pageKey() !== initial) leave(); }
  function navigate(event) {
    if (event.downloadRequest !== null && event.downloadRequest !== undefined) return;
    if (!event.destination.sameDocument || pageKey(event.destination.url) !== initial) leave();
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
