// What the pipeline needs to know about an app before it can explore one.
//
// Everything Docs-specific in this directory used to be a literal:
// `#docs-toolbar-wrapper` as the "app has loaded" signal, `#docs-menubar` as
// the place menus live, a block of validated Docs facts in the explorer's
// prompt. None of that was wrong — it was just the only app anyone had asked
// about. Collected here, it becomes one entry in a list instead of an
// assumption spread across six files.
//
// A host with no entry is not an error. GENERIC describes any app built out of
// ARIA-labelled controls, which is most of them, and an unknown site gets that
// profile with its hostname as the id. Adding an entry below buys sharper
// scope selectors and app-specific facts for the explorer; it is an
// optimisation, not a prerequisite.

/**
 * Controls that could plausibly be a lesson target. Mirrors CONTROL in
 * extension/src/teaching/resolution.js — the resolver that will later have to
 * find whatever this pipeline authors. If they drift, the pipeline emits
 * targets the runtime cannot resolve.
 */
const CONTROL = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, '
  + '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], '
  + '[role="switch"], [role="combobox"], [role="menuitem"], [aria-label]';

const GENERIC_FACTS = `You are exploring an ordinary web application. Nothing about its
structure is known in advance, so read the observation rather than assuming a layout.

- Controls are grouped for you by where they sit: TOOLBAR, MENU, DIALOG, and PAGE for
  everything else. PAGE is usually where the interesting controls are in an app that does
  not use an explicit toolbar or menu bar.
- A control that is not listed is not visible. If what you want is missing, click something
  that would reveal it — a menu, a tab, a disclosure button — rather than assuming it is there.
- Some apps navigate between pages instead of opening menus. That is fine and expected; the
  observation after the click will show the new page.
- Prefer the path an ordinary user would take through the visible interface. A learner is
  going to repeat every click you make.`;

const DOCS_FACTS = `Validated facts about Google Docs — do not re-derive these:

- The document body is CANVAS-RENDERED. No element exists for a paragraph, word, or cursor
  position. You cannot click text. Everything you can act on is in the chrome: the menu
  bar, the toolbar, sidebars, dialogs, the outline pane.
- Docs pre-renders every menu into the DOM on page load and hides them. Your observation
  is filtered to visible items only, so what you see is genuinely what is on screen.
- The toolbar Styles dropdown shows the style of the line the cursor is on, and is a
  2-click path to applying a heading. The menu path (Format > Paragraph styles > Heading 1
  > Apply 'Heading 1') is four levels deep and reaches the same result.
- Menu labels may carry their shortcut concatenated with no separator
  ("Find and replaceCtrl+H") — that is one label, not two controls.
- Confirmed paths: File > Version history > See version history. Insert > Table of contents.`;

const GMAIL_FACTS = `Facts about Gmail:

- Almost every control is an icon button whose only name is its aria-label ("Archive",
  "Report spam", "More email options"). Trust the observation's names over what you expect
  a mail client to call things.
- Settings open in a panel and then a full page; both are reachable by clicking, and the
  route changes as you go. That is expected.
- The message list is a table of rows, not a menu. Opening a message is a click on the row.`;

const GITHUB_FACTS = `Facts about GitHub:

- Navigating between Code, Issues, Pull requests and Settings changes the page's URL. That
  is ordinary navigation, not a failure.
- Tab labels carry a count badge ("Issues 12"). The count is not part of the control's name
  and changes constantly — the observation has already stripped it.
- Most actions are plain buttons and links with visible text rather than ARIA menus.`;

/**
 * @typedef {object} AppProfile
 * @property {string} id          lesson `app` value, and the key lessons scope on
 * @property {string} label       how to name it in a sentence
 * @property {string[]} hosts     hostnames this profile claims
 * @property {string|null} ready  selector meaning "the app has finished loading"
 * @property {object} selectors   where this app keeps its controls
 * @property {string} facts       app-specific briefing for the explorer
 * @property {number} minWidth    below this the app collapses its chrome
 * @property {boolean} generic    true when this was inferred, not registered
 */

/** The root a `label` verify is scoped to. See deriveVerify in emit.js. */
export const GENERIC_TOOLBAR_ROOT = '[role="toolbar"]';

export const GENERIC_SELECTORS = {
  // Real ARIA landmarks when the app provides them; otherwise these simply
  // return nothing and everything lands in the `any` bucket, which is correct.
  toolbar: '[role="toolbar"] [aria-label], [role="toolbar"] button, [role="toolbar"] a[href]',
  menubarRole: '[role="menubar"] [role="menuitem"]',
  menubarAria: '[role="menubar"] [aria-label]',
  control: CONTROL,
};

const REGISTRY = [
  {
    id: 'google-docs',
    label: 'Google Docs',
    hosts: ['docs.google.com'],
    ready: '#docs-toolbar-wrapper',
    toolbarRoot: '#docs-toolbar-wrapper',
    selectors: {
      toolbar: '#docs-toolbar-wrapper [aria-label]',
      // Unresolved at authoring time: the menubar may not carry role="menuitem".
      // Both are queried and the hit is recorded in `source`.
      menubarRole: '#docs-menubar [role="menuitem"]',
      menubarAria: '#docs-menubar [aria-label]',
      control: CONTROL,
    },
    facts: DOCS_FACTS,
    // Below this Docs collapses its toolbar into More and every authored
    // descriptor goes stale (PLAN.md §3).
    minWidth: 1400,
  },
  {
    id: 'gmail',
    label: 'Gmail',
    hosts: ['mail.google.com'],
    ready: '[role="main"]',
    toolbarRoot: GENERIC_TOOLBAR_ROOT,
    selectors: { ...GENERIC_SELECTORS },
    facts: GMAIL_FACTS,
    minWidth: 1100,
  },
  {
    id: 'github',
    label: 'GitHub',
    hosts: ['github.com'],
    ready: 'main, [role="main"]',
    toolbarRoot: GENERIC_TOOLBAR_ROOT,
    selectors: { ...GENERIC_SELECTORS },
    facts: GITHUB_FACTS,
    minWidth: 1000,
  },
];

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The profile for a URL. Never null — an unregistered host gets GENERIC with
 * its own hostname as the id, which is exactly what makes "generate a lesson
 * for whatever page I'm on" possible without a code change per site.
 */
export function appFor(url) {
  const host = hostOf(url);
  const known = REGISTRY.find(app => app.hosts.some(h => host === h || host.endsWith(`.${h}`)));
  if (known) return { ...known, generic: false };
  return {
    id: host || 'unknown',
    label: host || 'this app',
    hosts: host ? [host] : [],
    // No selector to wait for, so explore waits for the probe to report
    // controls instead — see waitForApp.
    ready: null,
    toolbarRoot: GENERIC_TOOLBAR_ROOT,
    selectors: { ...GENERIC_SELECTORS },
    facts: GENERIC_FACTS,
    minWidth: 1000,
    generic: true,
  };
}

export function appById(id) {
  const known = REGISTRY.find(app => app.id === id);
  return known ? { ...known, generic: false } : null;
}

export const listApps = () => REGISTRY.map(({ id, label, hosts }) => ({ id, label, hosts }));

// Hosts and paths that mean "sign in first". Deliberately a short list of
// unambiguous ones: a false positive aborts a run that would have worked.
const LOGIN_URL = /(^|\.)accounts\.google\.com$|(^|\.)login\.microsoftonline\.com$/;
const LOGIN_PATH = /^\/(login|signin|sign_in|sign-in|auth\/login|users\/sign_in|session\/new)(\/|$)/i;

/**
 * Did we land on a sign-in page instead of the app?
 *
 * Worth checking explicitly because the failure is otherwise silent and
 * confusing: the explorer gets a page full of nameable controls, spends its
 * whole budget clicking around a login form, and reports "stuck" without ever
 * saying the obvious thing. A logged-out visit to a private page is a normal
 * outcome of exploring anonymously, not a bug — it just has to be named.
 *
 * @returns {Promise<string|null>} a reason, or null when the app loaded fine
 */
export async function detectLoginWall(page) {
  let url;
  try { url = new URL(page.url()); } catch { return null; }

  if (LOGIN_URL.test(url.hostname) || LOGIN_PATH.test(url.pathname)) {
    return `the browser was redirected to a sign-in page (${url.hostname}${url.pathname})`;
  }

  // A visible password field is the other unambiguous tell, and catches apps
  // that show a login form in place without changing the URL.
  const password = await page.evaluate(() => {
    const field = [...document.querySelectorAll('input[type="password"]')]
      .find(el => el.getBoundingClientRect().width > 0);
    return Boolean(field);
  }).catch(() => false);

  return password ? 'this page is showing a sign-in form' : null;
}

/**
 * Wait until the app is usable.
 *
 * A registered app names a selector that means "loaded". An unregistered one
 * cannot, so wait for the probe to see enough named controls to be worth
 * exploring — which is the same question the extension's support probe asks,
 * and a better signal than any fixed timeout.
 */
export async function waitForApp(handle, app, { timeout = 30_000, minControls = 6 } = {}) {
  const { page } = handle;

  // `ready` is a fast path, not a precondition.
  //
  // It names one screen of the app — for Docs, the editor's toolbar. The
  // pipeline used to only ever open a prepared document, so that screen was
  // guaranteed. Now it opens whatever page the question was asked from, and
  // plenty of perfectly teachable pages in the same app are not that screen:
  // the Docs document list, Drive, a GitHub settings page. Failing those with
  // a raw selector timeout would be wrong — they have controls, they just
  // don't have THAT control.
  if (app.ready) {
    const quick = Math.max(2000, Math.round(timeout / 2));
    try {
      await page.waitForSelector(app.ready, { timeout: quick });
      return;
    } catch {
      // Not this app's main screen. Fall through and judge the page the same
      // way an unregistered host is judged: does it have anything to point at?
    }
  }

  const end = Date.now() + (app.ready ? Math.max(5000, timeout / 2) : timeout);
  let seen = 0;
  for (;;) {
    const obs = await handle.probe('observe').catch(() => null);
    seen = obs
      ? obs.toolbar.length + obs.menu.length + obs.dialog.length + (obs.any?.length ?? 0)
      : 0;
    if (seen >= minControls) return;
    if (Date.now() >= end) throw new Error(await diagnoseEmptyPage(handle, app, seen));
    await page.waitForTimeout(500);
  }
}

// What an auth interstitial calls its buttons. Only ever consulted on a page
// that turned out to have almost nothing on it — plenty of perfectly good
// pages carry a "Sign in" link in the corner, and that is not a wall.
// Anchored at BOTH ends: a prefix match makes "Login history" look like a
// login wall, and wrongly telling someone their saved profile has expired is
// worse than missing an interstitial we would have described anyway.
const AUTH_NAMES = /^(sign in( to continue)?|log ?in|request access|you need access|ask for access|choose an account|use another account|verify it'?s you)[\s.!?]*$/i;

/**
 * Why a page came back nearly empty, in words the panel can show a person.
 *
 * Reached only when the readiness check gave up, and the honest answer is
 * usually not "canvas or iframe" — it is that the browser is looking at a
 * sign-in or request-access screen. Google serves those at the document's own
 * URL, rendered after `domcontentloaded`, so the pre-flight check cannot see
 * them: the URL never changes and there is no password field.
 *
 * The few control names that ARE on the page are the most useful thing we can
 * report, so they go in the message either way.
 */
export async function diagnoseEmptyPage(handle, app, seen) {
  const names = await visibleNames(handle);
  const wall = (await detectLoginWall(handle.page))
    || (names.some(n => AUTH_NAMES.test(n)) ? 'this page is asking you to sign in or request access' : null);
  const saw = names.length
    ? `\n  What is on the page: ${names.slice(0, 8).map(n => JSON.stringify(n)).join(', ')}`
    : '';

  if (wall) {
    return `${wall}.${saw}\n  ${handle.page.url()}\n`
      + (handle.anonymous
        ? '  The cloud browser is signed out. Run `node author.js capture-profile` and sign in.'
        : '  The saved profile is signed in to the wrong account, or its session has expired. '
          + 'Re-run `node author.js capture-profile`.');
  }

  return `Nothing on this ${app.label} page could be pointed at — ${seen} nameable `
    + `control${seen === 1 ? '' : 's'} after waiting.${saw}\n  ${handle.page.url()}\n`
    + '  Either it is still loading, or its interface is drawn on a canvas or inside an '
    + 'iframe and cannot be taught.';
}

async function visibleNames(handle) {
  try {
    const obs = await handle.probe('observe');
    return [...obs.toolbar, ...obs.menu, ...obs.dialog, ...(obs.any ?? [])]
      .map(c => c.name).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Which page the cloud browser should actually open.
 *
 * The cloud browser is a different identity from yours. It signs in with a
 * throwaway account, so it can open DEMO_DOC_URL — a page prepared for exactly
 * this — but not your personal documents. Following your URL unconditionally
 * put it in front of a "Request access" screen and looked, from the outside,
 * like a broken login.
 *
 * The rule: if this app has a prepared page configured, use it; otherwise
 * follow the page you asked from. Since DEMO_DOC_URL is a Google Doc, that
 * means Docs questions go to the demo document exactly as they did before, and
 * public sites — GitHub, docs sites, anything the cloud browser can just open
 * — follow your URL. That is what makes generating for other sites work.
 *
 * PLAN.md §17.5 is about how much the authoring page's state matters, so using
 * the prepared page where one exists is the better answer anyway, not just the
 * backwards-compatible one.
 *
 * Set BT_PREFER_PAGE=1 to always follow your page, if the cloud browser shares
 * your identity or the pages you ask from are public.
 */
export function choosePage(pageUrl, prepared = process.env.DEMO_DOC_URL, preferPage = process.env.BT_PREFER_PAGE === '1') {
  if (!pageUrl) return prepared || null;
  if (!prepared || preferPage) return pageUrl;
  // Same app as the prepared page means there IS a prepared page for it, so
  // use that. Today DEMO_DOC_URL is a Google Doc, so in practice: Docs uses the
  // demo document, everything else follows the page you asked from.
  const havePreparedPage = appFor(prepared).id === appFor(pageUrl).id;
  return havePreparedPage ? prepared : pageUrl;
}
