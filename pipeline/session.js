// [C] Stage 1 — Steel session at 1440×900 with a saved Google profile injected.
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Steel } from 'steel-sdk';
import { chromium } from 'playwright-core';
import { VIEWPORT, STEEL_API_KEY, PROFILE_PATH } from './config.js';
import { PROBE_SOURCE } from './dom-probe.js';
import { createSessionViewer } from './session-viewer.js';

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
    onViewer,
  } = opts;

  const viewer = createSessionViewer(onViewer);
  let steel;
  let session;
  try {
    steel = client();
    session = await steel.sessions.create({
      dimensions: { width: VIEWPORT.width, height: VIEWPORT.height },
      ...(profileId ? { profileId } : {}),
      ...(persistProfile ? { persistProfile: true } : {}),
      ...(sessionContext ? { sessionContext } : {}),
      timeout,
      blockAds: true,
    });
  } catch (error) {
    viewer.unavailable();
    throw error;
  }
  // Advertise the embed as soon as Steel creates it, while CDP is connecting.
  viewer.ready(session);

  let browser;
  try {
    browser = await chromium.connectOverCDP(
      `${session.websocketUrl}&apiKey=${STEEL_API_KEY}`,
    );
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();

    if (injectProbe) await context.addInitScript(PROBE_SOURCE);

    const handle = {
      steel, session, browser, context, page,
      viewer,
      viewerUrl: viewer.state.url,
      probe: (fn, ...args) => callProbe(page, fn, args),
    };

    await assertViewport(page);
    return handle;
  } catch (error) {
    // Initialization can fail before the caller receives a handle to release.
    try { await browser?.close(); } catch { /* connection already closed */ }
    try { await steel.sessions.release(session.id); } catch { /* release attempted */ }
    viewer.close();
    throw error;
  }
}

// Steel's `dimensions` sets the browser window; the page's layout width may not follow.
// Below 1400 the Docs toolbar collapses into More and authored descriptors go stale.
async function assertViewport(page) {
  const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  if (w >= 1400) return;

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

// Use a throwaway Google account — cloud browsers trip "this browser may not be secure".
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

export async function openAuthedSession(opts = {}) {
  const { profileId, sessionContext } = await loadProfile();
  return openSession({ ...opts, profileId, sessionContext });
}

// Drive a local Chrome started with --remote-debugging-port. Same probe, same verify
// logic, but it runs in the browser the demo actually uses — and without Steel's
// datacenter IP, which Google degrades Drive features on.
export async function openLocalSession(opts = {}) {
  const {
    cdpUrl = 'http://localhost:9222',
    injectProbe = true,
    onViewer,
  } = opts;
  const viewer = createSessionViewer(onViewer);
  viewer.unavailable();

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
  if (injectProbe) await context.addInitScript(PROBE_SOURCE);

  const handle = {
    steel: null, session: null, browser, context, page,
    local: true,
    viewer,
    viewerUrl: '(local Chrome)',
    probe: (fn, ...args) => callProbe(page, fn, args),
  };

  await assertViewport(page);
  return handle;
}

// Always in a finally — a leaked session runs to its timeout and bills for it.
// A local handle owns no session and the browser is the user's, so only disconnect.
export async function closeSession(handle) {
  if (!handle) return;
  if (handle.local) {
    try { await handle.browser?.close(); } catch { /* already gone */ }
    handle.viewer?.close();
    return;
  }
  try { await handle.browser?.close(); } catch { /* already gone */ }
  try { await handle.steel?.sessions.release(handle.session.id); } catch { /* already released */ }
  handle.viewer?.close();
}
