// [C] Stage 5 — replay a lesson in a fresh session using only its emitted descriptors.
// Completes → ship. Fails → descriptors too fragile, re-run.
import { openExploreSession, closeSession, whoami } from './session.js';
import { RESOLVE_TIMEOUT_MS, VERIFY_TIMEOUT_MS } from './config.js';
import { appById, appFor, waitForApp } from './apps.js';

export async function verifyLesson(lesson, opts = {}, overrides = {}) {
  const { docUrl = process.env.DEMO_DOC_URL, keepOpen = false, local = false, auth = 'auto', onViewer, signal, onHandle } = opts;
  // Service overrides keep lifecycle tests offline; normal callers use the
  // same session/app functions as authoring.
  const services = { openExploreSession, closeSession, whoami, waitForApp, ...overrides };
  const checkCancelled = () => signal?.throwIfAborted();
  checkCancelled();
  if (!docUrl) throw new Error('no page URL — pass { docUrl } or set DEMO_DOC_URL');

  // Replay in the same app the lesson was authored for. The lesson's own `app`
  // wins over the URL: a lesson replayed against the wrong app should fail
  // loudly on its first descriptor, not quietly against a mismatched probe.
  const app = opts.app ?? appById(lesson.app) ?? appFor(docUrl);
  const handle = await services.openExploreSession({ app, local, auth, onViewer });
  let releasePromise;
  const release = () => releasePromise ??= Promise.resolve().then(() => (opts.releaseHandle ?? services.closeSession)(handle));
  const onAbort = () => { release().catch(() => {}); };
  signal?.addEventListener('abort', onAbort);
  const steps = [];
  let failedAt;

  console.log(`\n  ${lesson.id} — watch: ${handle.viewerUrl}`);

  let skipped = false;
  let viewport = '?';

  try {
    onHandle?.(handle);
    checkCancelled(); // an opener may finish after cancellation
    await handle.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
    checkCancelled();
    await services.waitForApp(handle, app);
    viewport = await handle.page.evaluate(() => `${innerWidth}x${innerHeight}`);
    await handle.page.waitForTimeout(1500);   // apps wire their menus after first paint

    checkCancelled();
    const account = await services.whoami(handle.page);
    console.log(account
      ? `  signed in as ${account}`
      : `  no signed-in account detected — anything in ${app.label} that needs one will be disabled`);

    for (const step of lesson.steps) {
      checkCancelled();
      const t0 = Date.now();

      // Instruct-only: the doc body is canvas, so there's nothing to resolve or replay.
      // The learner's click would also dismiss any open menu — this replay's won't, so
      // every later step runs against state a real user would never be in.
      if (!step.target) {
        // Escape is the closest stand-in for the learner's click: it dismisses whatever
        // menu the previous step opened. It does NOT move the caret, so a later
        // verify reading the current style can still diverge.
        skipped = true;
        await handle.page.keyboard.press('Escape');
        await handle.page.waitForTimeout(300);
        steps.push({
          id: step.id, status: 'skipped', ms: Date.now() - t0,
          note: 'instruct-only (target: null) — sent Escape; caret position not reproduced',
        });
        continue;
      }

      const hit = await pollResolve(handle, step.target, RESOLVE_TIMEOUT_MS, signal);
      checkCancelled();

      // Resolved but greyed out. Clicking would just time out, and a learner could not
      // complete the step either — the lesson is wrong for this document.
      if (hit?.disabled) {
        steps.push({
          id: step.id, status: 'disabled', name: step.target.name, ms: Date.now() - t0,
          note: `"${step.target.name}" is present but disabled on this document`,
          visible: await dumpScope(handle, step.target.scope),
          afterSkip: skipped,
        });
        failedAt = step.id;
        break;
      }

      if (!hit) {
        steps.push({
          id: step.id, status: 'unresolved', name: step.target.name, ms: Date.now() - t0,
          note: `no visible match for ${JSON.stringify(step.target)}`,
          visible: await dumpScope(handle, step.target.scope),
          roles: await roleCensus(handle),
          afterSkip: skipped,
        });
        failedAt = step.id;
        break;
      }

      // Playwright, not el.click() — Docs listens on capture phase and its menus dismiss
      // on blur, so the real pointer sequence matters.
      await handle.page.click(`[data-bt-id="${hit.id}"]`, { timeout: 5000 });

      if (step.verify && step.verify.kind !== 'none') {
        const passed = await pollCheck(handle, step.verify, VERIFY_TIMEOUT_MS, signal);
        checkCancelled();
        if (!passed) {
          steps.push({
            id: step.id, status: 'verify-failed', name: step.target.name,
            count: hit.count, ms: Date.now() - t0,
            note: `clicked, but ${JSON.stringify(step.verify)} never passed`,
            visible: await dumpScope(handle, step.verify.scope ?? 'menu'),
            roles: await roleCensus(handle),
            afterSkip: skipped,
          });
          failedAt = step.id;
          break;
        }
      }

      steps.push({
        id: step.id, status: 'ok', name: step.target.name,
        count: hit.count, ms: Date.now() - t0,
        ...(step.verify?.kind === 'none' ? { note: 'click only (verify: none)' } : {}),
      });
    }
    checkCancelled();
  } finally {
    try {
      if (!keepOpen || signal?.aborted) await release();
    } finally {
      signal?.removeEventListener('abort', onAbort);
      onHandle?.(null);
    }
  }

  checkCancelled();
  return {
    ok: !failedAt && !skipped,
    incomplete: skipped,
    steps,
    ...(failedAt ? { failedAt } : {}),
    viewerUrl: handle.viewerUrl,
    viewport,
    local,
  };
}

// Visible elements by ARIA role. Separates "nothing opened" from "something opened but
// the probe's tiers don't query that role".
async function roleCensus(handle) {
  try {
    return await handle.page.evaluate(() => {
      const counts = {};
      for (const el of document.querySelectorAll('[role]')) {
        if (el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const role = el.getAttribute('role');
        counts[role] = (counts[role] ?? 0) + 1;
      }
      return counts;
    });
  } catch {
    return {};
  }
}

// What the probe can actually see right now, so a failing step says why.
async function dumpScope(handle, scope) {
  try {
    const obs = await handle.probe('observe');
    const pool = scope && obs[scope] ? obs[scope] : [...obs.toolbar, ...obs.menu, ...obs.dialog, ...(obs.any ?? [])];
    return pool.map(c => c.raw + (c.disabled ? '   [disabled]' : ''));
  } catch {
    return [];
  }
}

// Prefer an enabled match, but keep a disabled one so the caller can say which it was.
// Docs ships its menubar disabled during load, so the wait matters.
async function pollResolve(handle, target, timeoutMs, signal) {
  const start = Date.now();
  let fallback = null;
  do {
    signal?.throwIfAborted();
    const hit = await handle.probe('resolve', target);
    signal?.throwIfAborted();
    if (hit && !hit.disabled) return hit;
    const visible = hit || await handle.probe('resolve', target, { actionable: false });
    if (visible?.disabled) fallback = visible;
    await handle.page.waitForTimeout(100);
  } while (Date.now() - start < timeoutMs);
  return fallback;
}

async function pollCheck(handle, verify, timeoutMs, signal) {
  const start = Date.now();
  do {
    signal?.throwIfAborted();
    const passed = await handle.probe('check', verify);
    signal?.throwIfAborted();
    if (passed) return true;
    await handle.page.waitForTimeout(100);
  } while (Date.now() - start < timeoutMs);
  return false;
}

const MARK = {
  ok: '  ok  ', unresolved: ' FAIL ', 'verify-failed': ' FAIL ',
  disabled: ' FAIL ', skipped: ' skip ',
};

export function printReport(lesson, report) {
  console.log(`\n  ${lesson.id} — ${lesson.goal}`);
  for (const s of report.steps) {
    const nth = s.count > 1 ? `  (${s.count} visible matches — nth matters)` : '';
    console.log(`   [${MARK[s.status]}] ${s.id.padEnd(4)} ${(s.name ?? '').padEnd(28)} ${String(s.ms).padStart(5)}ms${nth}`);
    if (s.note) console.log(`            ${s.note}`);
    if (s.afterSkip) {
      console.log('            a step was skipped earlier — the page may be in a state a learner never reaches');
    }
    if (s.roles && Object.keys(s.roles).length) {
      const top = Object.entries(s.roles).sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`            visible roles: ${top.map(([r, n]) => `${r}=${n}`).join('  ')}`);
    }
    if (s.visible?.length) {
      console.log(`            visible in that scope (${s.visible.length}):`);
      for (const v of s.visible.slice(0, 25)) console.log(`              ${JSON.stringify(v)}`);
      if (s.visible.length > 25) console.log(`              … ${s.visible.length - 25} more`);
    } else if (s.visible) {
      console.log('            nothing visible in that scope at all');
    }
  }
  console.log(report.ok
    ? `\n  PASS — replays clean at ${report.viewport} in ${report.local ? 'local Chrome' : 'a fresh cloud Chrome'}.\n`
    : report.incomplete && !report.failedAt
      ? '\n  INCOMPLETE — instruct-only actions were skipped; this is not a complete verified lesson.\n'
      : `\n  FAIL at ${report.failedAt}. Watch it: ${report.viewerUrl}\n`);
  return report.ok;
}
