// [C] Stage 1 — a session with a body. PLAN.md §10.
// Steel session at 1440×900 with a saved profile (cookies + localStorage from a Google
// account logged in by hand, once, ahead of time) injected. The browser wakes up past
// the login wall. This is why auth isn't a problem.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Steel } from 'steel-sdk';
import { chromium } from 'playwright-core';
import { VIEWPORT, STEEL_API_KEY, PROFILE_PATH } from './config.js';
import { PROBE_SOURCE } from './dom-probe.js';

const DEFAULT_TIMEOUT_MS = 300_000;   // 5 min. Steel bills per session-minute.
const CAPTURE_TIMEOUT_MS = 900_000;   // 15 min — a human is typing a password in this one.

/**
 * @typedef {object} Handle
 * @property {import('steel-sdk').Steel} steel
 * @property {object} session
 * @property {import('playwright-core').Browser} browser
 * @property {import('playwright-core').BrowserContext} context
 * @property {import('playwright-core').Page} page
 * @property {string} viewerUrl   paste into a browser to watch the session live
 * @property {(fn: string, ...args: any[]) => Promise<any>} probe
 */

function client() {
  if (!STEEL_API_KEY) throw new Error('STEEL_API_KEY is not set (pipeline/.env)');
  return new Steel({ steelAPIKey: STEEL_API_KEY });
}

/**
 * Open a Steel session and attach Playwright over CDP.
 *
 * NOTE on auth mechanisms, because this is the easiest thing to get wrong:
 * Playwright's `storageState` is NOT usable here. Over connectOverCDP you must drive
 * `browser.contexts()[0]` — Steel's stealth config, proxy and live viewer are bound to
 * that existing context — and `storageState` only applies at `newContext()`. Steel's own
 * `profileId` (a snapshot of the whole Chrome user-data-dir) is the primary mechanism;
 * `sessionContext` (cookies + local/session storage) is the fallback.
 */
export async function openSession(opts = {}) {
  const {
    profileId,
    persistProfile = false,
    sessionContext,
    timeout = DEFAULT_TIMEOUT_MS,
    injectProbe = true,
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

  const browser = await chromium.connectOverCDP(
    `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`,
  );
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();

  // Context-level, so it survives navigation. If this turns out not to fire on the CDP
  // default context, the fallback is page.evaluate(PROBE_SOURCE) after every navigation —
  // ensureProbe() below covers that case automatically.
  if (injectProbe) await context.addInitScript(PROBE_SOURCE);

  const handle = {
    steel, session, browser, context, page,
    viewerUrl: session.sessionViewerUrl ?? session.debugUrl,
    probe: (fn, ...args) => callProbe(page, fn, args),
  };

  await assertViewport(page);
  return handle;
}

/**
 * The single highest-risk assumption C owns. `dimensions` sets the Steel browser WINDOW;
 * the page's layout width is a different number and may not follow. PLAN.md §3: the Docs
 * toolbar collapses controls into `More` as width shrinks, so a button present at 1440px
 * is ABSENT FROM THE DOM at 1000px. If this is wrong, every descriptor we author is
 * poisoned and it will look like a resolver bug.
 */
async function assertViewport(page) {
  const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  if (w >= 1400) return;

  // Fall back to a CDP metrics override rather than failing the run outright.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
  });
  const [w2] = await page.evaluate(() => [window.innerWidth]);
  if (w2 < 1400) {
    throw new Error(
      `viewport is ${w2}×${h}, needs ≥1400 wide (PLAN.md §3). The Docs toolbar will be ` +
      `collapsed into More and every authored descriptor will be wrong.`,
    );
  }
  console.warn(`[session] window was ${w}px; forced ${w2}px via Emulation override`);
}

/** Re-inject the probe if addInitScript didn't take. Cheap, idempotent, called per-use. */
async function ensureProbe(page) {
  const ok = await page.evaluate(() => typeof window.__PROBE === 'object');
  if (!ok) await page.evaluate(PROBE_SOURCE);
}

async function callProbe(page, fn, args) {
  await ensureProbe(page);
  return page.evaluate(
    ([f, a]) => window.__PROBE[f](...a),
    [fn, args],
  );
}

/**
 * Open a long-lived session for a human to log into Google by hand, then snapshot it.
 * Prints the interactive viewer URL and blocks on stdin.
 *
 * Use a THROWAWAY Google account. A cloud browser frequently trips "This browser or app
 * may not be secure" on a personal account, and that is a hard blocker for the pipeline.
 */
export async function openCaptureSession() {
  const handle = await openSession({
    persistProfile: true,
    timeout: CAPTURE_TIMEOUT_MS,
    injectProbe: false,
  });

  const interactive = `${handle.session.debugUrl}${handle.session.debugUrl.includes('?') ? '&' : '?'}interactive=true`;
  console.log('\n  Open this, log into Google, then open any Doc:\n');
  console.log(`    ${interactive}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('  Press ENTER once you are logged in and looking at a Doc... ');
  rl.close();
  return handle;
}

/**
 * Snapshot the live session's auth and write it to PROFILE_PATH.
 *
 * Order matters: sessionContext can ONLY be captured from a LIVE session, so it must be
 * fetched before release. The profile upload is asynchronous — the profile is UPLOADING
 * while the session runs and only READY after release, so we poll. Reusing a profileId
 * that is still uploading silently gives you a logged-out browser.
 */
export async function saveProfile(handle, path = PROFILE_PATH) {
  const { steel, session } = handle;

  let sessionContext = null;
  try {
    sessionContext = await steel.sessions.context(session.id);
  } catch (err) {
    console.warn(`[session] could not capture sessionContext: ${err.message}`);
  }

  await closeSession(handle);

  const profileId = session.profileId ?? session.profile?.id ?? null;
  if (profileId) await waitForProfile(steel, profileId);

  const record = {
    profileId,
    sessionContext,
    capturedAt: new Date().toISOString(),
    viewport: VIEWPORT,
  };
  await writeFile(path, JSON.stringify(record, null, 2));
  console.log(`\n  Saved profile to ${path}`);
  console.log(`    profileId:      ${profileId ?? '(none — will fall back to sessionContext)'}`);
  console.log(`    sessionContext: ${sessionContext ? 'captured' : 'MISSING'}`);
  if (!profileId && !sessionContext) {
    throw new Error('captured neither a profileId nor a sessionContext — auth will not persist');
  }
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

/** Open a session using the saved profile. The normal entry point for explore/verify. */
export async function openAuthedSession(opts = {}) {
  const { profileId, sessionContext } = await loadProfile();
  return openSession({ ...opts, profileId, sessionContext });
}

/** Always call this in a finally. A leaked session runs to its timeout and bills for it. */
export async function closeSession(handle) {
  if (!handle) return;
  try { await handle.browser?.close(); } catch { /* already gone */ }
  try { await handle.steel.sessions.release(handle.session.id); } catch { /* already released */ }
}
