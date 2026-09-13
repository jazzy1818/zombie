// [C] Stage 1 — Steel session at 1440×900 with a saved Google profile injected.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Steel } from 'steel-sdk';
import { chromium } from 'playwright-core';
import { VIEWPORT, STEEL_API_KEY, PROFILE_PATH } from './config.js';
import { probeSource } from './dom-probe.js';
import { appFor } from './apps.js';

const DEFAULT_TIMEOUT_MS = 300_000;   // Steel bills per session-minute
const CAPTURE_TIMEOUT_MS = 900_000;   // a human is typing a password in this one

function client() {
  if (!STEEL_API_KEY) throw new Error('STEEL_API_KEY is not set (pipeline/.env)');
  return new Steel({ steelAPIKey: STEEL_API_KEY });
}

// Auth rides on Steel's profileId, not Playwright's storageState: connectOverCDP forces
// you onto browser.contexts()[0] and storageState only applies at newContext().
export async function openSession(opts = {}) {
  const {
    profileId,
    persistProfile = false,
    sessionContext,
    timeout = DEFAULT_TIMEOUT_MS,
    injectProbe = true,
    // Which app this session is for. The probe's scope selectors are baked
    // into its source at injection time, so this has to be known before the
    // first page load — not worked out once we get there.
    app = appFor('https://docs.google.com/'),
  } = opts;

  const steel = client();
  const session = await steel.sessions.create({
    dimensions: { width: VIEWPORT.width, height: VIEWPORT.height },
    ...(profileId ? { profileId } : {}),
    ...(persistProfile ? { persistProfile: true } : {}),
    ...(sessionContext ? { sessionContext } : {}),
    timeout,
    blockAds: true,
  });

  let browser;
  try {
    browser = await chromium.connectOverCDP(
      `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`,
    );
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();

    const source = probeSource(app.selectors);
    if (injectProbe) await context.addInitScript(source);

    const handle = {
      steel, session, browser, context, page, app,
      viewerUrl: session.sessionViewerUrl ?? session.debugUrl,
      probe: (fn, ...args) => callProbe(page, fn, args, source),
    };

    await assertViewport(page, app);
    return handle;
  } catch (error) {
    // Initialization can fail before the caller receives a handle to release.
    try { await browser?.close(); } catch { /* connection already closed */ }
    try { await steel.sessions.release(session.id); } catch { /* release attempted */ }
    throw error;
  }
}

// Steel's `dimensions` sets the browser window; the page's layout width may not follow.
// Every responsive app has a width below which it hides controls behind an overflow
// menu, and a descriptor authored on the wrong side of that is wrong for the learner.
// The threshold is the app's, not the web's: 1400 for Docs (PLAN.md §3), less for
// apps that degrade more gracefully.
async function assertViewport(page, app) {
  const floor = app?.minWidth ?? 1400;
  const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  if (w >= floor) return;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  });
  const [w2] = await page.evaluate(() => [window.innerWidth]);
  if (w2 < floor) {
    throw new Error(
      `viewport is ${w2}×${h}, needs ≥${floor} wide for ${app?.label ?? 'this app'}. Its chrome ` +
      `will be collapsed into an overflow menu and every authored descriptor will be wrong.`,
    );
  }
  console.warn(`[session] window was ${w}px; forced ${w2}px via Emulation override`);
}

// Which Google account this browser is acting as. An anonymous session can still edit a
// link-shared doc, but every Drive-level menu item is greyed out, which reads as a broken
// lesson rather than a missing login.
export async function whoami(page) {
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label]')]
      .map(e => e.getAttribute('aria-label'))
      .filter(l => l && l.includes('@')));
  return labels[0] ?? null;
}

// Covers addInitScript not firing on the CDP default context.
async function ensureProbe(page, source) {
  const ok = await page.evaluate(() => typeof window.__PROBE === 'object');
  if (!ok) await page.evaluate(source);
}

async function callProbe(page, fn, args, source) {
  await ensureProbe(page, source);
  return page.evaluate(
    ([f, a]) => window.__PROBE[f](...a),
    [fn, args],
  );
}

/**
 * Log the cloud browser into an app, once, and keep the session.
 *
 * One profile holds every cookie the browser collects, so signing into Google
 * and GitHub in the same capture leaves one profile that can explore both.
 * Nothing here is Google-specific any more except the warning, which still
 * applies: use a throwaway account, because cloud browsers trip Google's
 * "this browser may not be secure" check.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.sites]  what to tell the operator to sign into
 */
export async function openCaptureSession({ sites = [] } = {}) {
  const handle = await openSession({
    persistProfile: true,
    timeout: CAPTURE_TIMEOUT_MS,
    injectProbe: false,
  });

  const interactive = `${handle.session.debugUrl}${handle.session.debugUrl.includes('?') ? '&' : '?'}interactive=true`;
  const what = sites.length ? sites.join(', ') : 'every app you want to generate lessons for';
  console.log(`\n  Open this and sign into ${what}:\n`);
  console.log(`    ${interactive}\n`);
  console.log('  One profile holds them all — sign into as many as you like in this one window.');
  console.log('  Use throwaway accounts: cloud browsers trip Google\'s "browser may not be secure" check.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('  Press ENTER once you are signed in... ');
  rl.close();
  return handle;
}

// sessionContext can only be read from a live session; the profile only finishes
// uploading after release. Hence fetch → write → release → poll → rewrite.
export async function saveProfile(handle, path = PROFILE_PATH) {
  const { steel, session } = handle;

  let sessionContext = null;
  try {
    sessionContext = await steel.sessions.context(session.id);
  } catch (err) {
    console.warn(`[session] could not capture sessionContext: ${err.message}`);
  }

  const record = {
    profileId: session.profileId ?? session.profile?.id ?? null,
    profileStatus: 'unconfirmed',
    sessionId: session.id,
    sessionContext,
    capturedAt: new Date().toISOString(),
    viewport: VIEWPORT,
  };

  // Write before releasing — nothing after this point is worth a second hand login.
  await writeFile(path, JSON.stringify(record, null, 2));

  await closeSession(handle);

  if (!record.profileId) record.profileId = await findRecentProfile(steel, record.capturedAt);

  if (record.profileId) {
    try {
      await waitForProfile(steel, record.profileId);
      record.profileStatus = 'READY';
    } catch (err) {
      record.profileStatus = `unconfirmed (${err.message})`;
      console.warn(`[session] ${err.message}`);
    }
    await writeFile(path, JSON.stringify(record, null, 2));
  }

  console.log(`\n  Saved profile to ${path}`);
  console.log(`    profileId:      ${record.profileId ?? '(none — falling back to sessionContext)'}`);
  console.log(`    status:         ${record.profileStatus}`);
  console.log(`    sessionContext: ${sessionContext ? 'captured' : 'MISSING'}`);
  if (!record.profileId && !sessionContext) {
    throw new Error('captured neither a profileId nor a sessionContext — auth will not persist');
  }
  return record;
}

// For when Steel's create response doesn't name the profile it produced.
export async function findRecentProfile(steel, since) {
  try {
    const res = await steel.profiles.list();
    const all = Array.isArray(res) ? res : (res.data ?? res.profiles ?? []);
    const cutoff = since ? new Date(since).getTime() - 600_000 : 0;
    const recent = all
      .filter(p => new Date(p.createdAt ?? p.created_at ?? 0).getTime() >= cutoff)
      .sort((a, b) => new Date(b.createdAt ?? b.created_at ?? 0) - new Date(a.createdAt ?? a.created_at ?? 0));
    return recent[0]?.id ?? null;
  } catch (err) {
    console.warn(`[session] could not list profiles: ${err.message}`);
    return null;
  }
}

export async function listProfiles() {
  const steel = client();
  const res = await steel.profiles.list();
  return Array.isArray(res) ? res : (res.data ?? res.profiles ?? []);
}

// Recover profile.json from a profile that uploaded but never got recorded locally.
export async function adoptProfile(profileId, path = PROFILE_PATH) {
  const steel = client();
  const p = await steel.profiles.get(profileId);
  const record = {
    profileId,
    profileStatus: String(p.status ?? 'unknown').toUpperCase(),
    sessionContext: null,
    capturedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    adopted: true,
  };
  await writeFile(path, JSON.stringify(record, null, 2));
  console.log(`\n  Wrote ${path} using profile ${profileId} (status ${record.profileStatus})\n`);
  return record;
}

async function waitForProfile(steel, profileId, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await steel.profiles.get(profileId);
    const status = String(p.status ?? '').toUpperCase();
    if (status === 'READY') return p;
    if (status === 'FAILED') throw new Error(`profile ${profileId} upload FAILED`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`profile ${profileId} still uploading after ${timeoutMs}ms`);
}

export async function loadProfile(path = PROFILE_PATH) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(
      `no saved profile at ${path}. Run: npm run capture-profile`,
    );
  }
}

/** The saved profile, or null. For callers that can work without one. */
export async function tryLoadProfile(path = PROFILE_PATH) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function openAuthedSession(opts = {}) {
  const { profileId, sessionContext } = await loadProfile();
  return openSession({ ...opts, profileId, sessionContext });
}

/**
 * A cloud browser signed into nothing.
 *
 * A public page needs no account, and requiring one anyway was a real barrier:
 * a public GitHub repo is readable by anybody, and refusing to explore it until
 * someone had hand-captured a Google login made no sense. Most of the web is
 * readable like this.
 */
export function openAnonSession(opts = {}) {
  return openSession(opts);
}

/**
 * Open whatever session this exploration can actually get.
 *
 * @param {object} opts
 * @param {object} [opts.app]      app profile, for the probe's selectors
 * @param {boolean} [opts.local]   drive the local Chrome over CDP instead
 * @param {'auto'|'none'|'required'} [opts.auth]
 *   - `auto` (default): use the saved profile if there is one, otherwise go
 *     anonymous and say so. Public pages then work out of the box.
 *   - `none`: ignore any saved profile. Useful for checking that a lesson is
 *     genuinely reachable by a logged-out visitor.
 *   - `required`: fail loudly rather than silently exploring a logged-out view
 *     of an app whose interesting parts need an account.
 */
export async function openExploreSession({ app, local = false, auth = 'auto', ...rest } = {}) {
  if (local) return openLocalSession({ ...rest, app });
  if (auth === 'required') return openAuthedSession({ ...rest, app });
  if (auth === 'none') return markAnonymous(await openAnonSession({ ...rest, app }));

  const profile = await tryLoadProfile();
  if (profile?.profileId || profile?.sessionContext) {
    return openSession({ ...rest, app, profileId: profile.profileId, sessionContext: profile.sessionContext });
  }
  console.warn('[session] no saved profile — exploring signed out. '
    + 'Public pages are fine; anything behind a login will not be reachable. '
    + 'Run `node author.js capture-profile` if you need one.');
  return markAnonymous(await openAnonSession({ ...rest, app }));
}

function markAnonymous(handle) {
  handle.anonymous = true;
  return handle;
}

// Drive a local Chrome started with --remote-debugging-port. Same probe, same verify
// logic, but it runs in the browser the demo actually uses — and without Steel's
// datacenter IP, which Google degrades Drive features on.
export async function openLocalSession(opts = {}) {
  const {
    cdpUrl = 'http://localhost:9222',
    injectProbe = true,
    app = appFor('https://docs.google.com/'),
  } = opts;

  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    throw new Error(
      `no Chrome listening on ${cdpUrl} (${err.message}).\n\n  Start one with:\n` +
      `    chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\\bt-chrome"\n\n` +
      `  Then sign into Google in that window and open the demo doc.`,
    );
  }

  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();
  const source = probeSource(app.selectors);
  if (injectProbe) await context.addInitScript(source);

  const handle = {
    steel: null, session: null, browser, context, page, app,
    local: true,
    viewerUrl: '(local Chrome)',
    probe: (fn, ...args) => callProbe(page, fn, args, source),
  };

  await assertViewport(page, app);
  return handle;
}

// Always in a finally — a leaked session runs to its timeout and bills for it.
// A local handle owns no session and the browser is the user's, so only disconnect.
export async function closeSession(handle) {
  if (!handle) return;
  if (handle.local) {
    try { await handle.browser?.close(); } catch { /* already gone */ }
    return;
  }
  try { await handle.browser?.close(); } catch { /* already gone */ }
  try { await handle.steel?.sessions.release(handle.session.id); } catch { /* already released */ }
}
