// Document exits and SPA route changes invalidate local element references.
// Fragment-only scrolling is still the same page and keeps guidance active.
export function pageKey(value = location.href) {
  const url = new URL(value, location.href);
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
