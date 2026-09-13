// Which app a lesson belongs to.
//
// The teaching runtime is already app-agnostic: teaching/resolution.js matches
// on accessible names and ARIA roles, never on anything Google-specific, and
// the manifest injects on every http(s) page. Lessons are NOT app-agnostic.
// "Insert a table of contents" is a Google Docs lesson, and offering it on
// GitHub is exactly how a picker loses the user's trust — it resolves nothing,
// the spotlight never appears, and the product looks broken on a page it was
// never asked to teach.
//
// A site key is just a hostname. Nothing has to be registered for a site to
// work — the table below only supplies a human-readable label for panel copy,
// so a lesson can be authored for any host without editing this file.

export const ANY_SITE = '*';

/**
 * Lessons written before lessons named an app were all authored against Google
 * Docs (PLAN.md §3 pinned it as the only target). Treat a lesson with neither
 * `app` nor `sites` as one of those rather than as "runs anywhere": a wrong
 * default here puts eight Docs lessons in front of someone on GitHub, which is
 * the failure this whole module exists to prevent.
 */
export const LEGACY_SITE = 'docs.google.com';

/** How to name a host in a sentence. Purely cosmetic. */
const LABELS = new Map([
  ['docs.google.com', 'Google Docs'],
  ['mail.google.com', 'Gmail'],
  ['drive.google.com', 'Google Drive'],
  ['calendar.google.com', 'Google Calendar'],
  ['sheets.google.com', 'Google Sheets'],
  ['github.com', 'GitHub'],
  ['gitlab.com', 'GitLab'],
]);

const here = () => globalThis.location?.href;

/**
 * Stable key for the app in the address bar. '' when there isn't one.
 *
 * Absolute URLs ONLY — deliberately no base. Resolving against the current
 * page is what broke this: `siteKey('docs.google.com')` with the page as base
 * produced `https://<whatever-page-you-are-on>/docs.google.com`, so every
 * lesson's declared host silently became the host you were looking at and
 * every lesson matched every site. A relative string is not a site; it returns
 * '' and the caller decides what to do with it.
 */
export function siteKey(url = here()) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * A host out of whatever an author wrote: a bare hostname, a hostname with a
 * path, a protocol-relative URL, or a full one.
 */
function toHost(entry) {
  if (entry === ANY_SITE) return entry;
  const absolute = siteKey(entry);
  if (absolute) return absolute;
  return entry
    .replace(/^\/\//, '')       // //github.com/x
    .split(/[/?#]/)[0]          // github.com/x -> github.com
    .replace(/^www\./, '')
    .trim();
}

/** What to call this site in a sentence. Falls back to the bare hostname. */
export function siteLabel(key = siteKey()) {
  if (!key || key === ANY_SITE) return 'this page';
  return LABELS.get(key) || key;
}

/**
 * App ids the pipeline emits, mapped to the hosts they run on.
 *
 * `app` is not a hostname — it is the id from pipeline/apps.js, which is a
 * readable slug for a registered app ("google-docs") and a bare hostname for
 * everything else ("notion.so"). Both have to resolve to a host here, so this
 * table only needs an entry where the two differ.
 */
const APP_HOSTS = new Map([
  ['google-docs', ['docs.google.com']],
  ['gmail', ['mail.google.com']],
  ['github', ['github.com']],
  ['gitlab', ['gitlab.com']],
]);

/**
 * The sites a lesson claims to teach.
 *
 * `app` is the normal answer and every lesson already carries one — the
 * emitter has written it since before this module existed. `sites` is the
 * explicit override, for the rare lesson that spans hosts an app id can't
 * express.
 *
 * Accepted shapes, so a hand-authored lesson is hard to get wrong:
 *   "app": "github"                  the usual case
 *   "sites": ["github.com"]          explicit hosts
 *   "sites": "github.com"
 *   "sites": ["*"]                   genuinely app-independent (rare)
 *   (neither)                        legacy, see LEGACY_SITE
 */
export function lessonSites(lesson) {
  const raw = lesson?.sites ?? lesson?.site ?? appHosts(lesson?.app);
  if (raw === undefined || raw === null) return [LEGACY_SITE];
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(entry => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
    .filter(Boolean)
    // Authors paste URLs. Take the host out of one rather than refusing it.
    .map(toHost)
    .filter(Boolean);
  return list.length ? list : [LEGACY_SITE];
}

/** Hosts for a pipeline app id, or the id itself when it is already a host. */
function appHosts(app) {
  if (typeof app !== 'string' || !app.trim()) return undefined;
  const id = app.trim().toLowerCase();
  return APP_HOSTS.get(id) ?? [id];
}

/**
 * A local fixture is standing in for whichever app it imitates, so scoping it
 * would hide the entire library from every harness in docs/ — all of which
 * serve from 127.0.0.1 and then type questions at the chat bar.
 */
export function isDevHost(key = siteKey()) {
  return key === 'localhost' || key === '127.0.0.1' || key === '[::1]' || key === '0.0.0.0'
    || key.endsWith('.localhost');
}

/** Would this lesson's steps have anything to point at on the current page? */
export function lessonRunsHere(lesson, here = siteKey()) {
  if (!here) return false;
  if (isDevHost(here)) return true;
  return lessonSites(lesson).some(site => site === ANY_SITE || site === here
    // docs.google.com should satisfy a lesson authored for google.com, but
    // never the reverse — a subdomain is more specific, not less.
    || here.endsWith(`.${site}`));
}
