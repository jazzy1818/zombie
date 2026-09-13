// [C] Stage 5 — replay a lesson in a fresh session using only its emitted descriptors.
// Completes → ship. Fails → descriptors too fragile, re-run.
import { openAuthedSession, openLocalSession, closeSession } from './session.js';
import { RESOLVE_TIMEOUT_MS, VERIFY_TIMEOUT_MS } from './config.js';

export async function verifyLesson(lesson, opts = {}) {
  const { docUrl = process.env.DEMO_DOC_URL, keepOpen = false, local = false } = opts;
  if (!docUrl) throw new Error('no doc URL — pass { docUrl } or set DEMO_DOC_URL');

  const handle = local ? await openLocalSession() : await openAuthedSession();
  const steps = [];
  let failedAt;

  console.log(`\n  ${lesson.id} — watch: ${handle.viewerUrl}`);

  let skipped = false;

  try {
    await handle.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
    await handle.page.waitForSelector('#docs-toolbar-wrapper', { timeout: 30_000 });
    await handle.page.waitForTimeout(1500);   // Docs wires its menus after the toolbar paints

    for (const step of lesson.steps) {
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

      const hit = await pollResolve(handle, step.target, RESOLVE_TIMEOUT_MS);

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
          afterSkip: skipped,
        });
        failedAt = step.id;
        break;
      }

      // Playwright, not el.click() — Docs listens on capture phase and its menus dismiss
      // on blur, so the real pointer sequence matters.
      await handle.page.click(`[data-bt-id="${hit.id}"]`, { timeout: 5000 });

      if (step.verify && step.verify.kind !== 'none') {
        const passed = await pollCheck(handle, step.verify, VERIFY_TIMEOUT_MS);
        if (!passed) {
          steps.push({
            id: step.id, status: 'verify-failed', name: step.target.name,
            count: hit.count, ms: Date.now() - t0,
            note: `clicked, but ${JSON.stringify(step.verify)} never passed`,
            visible: await dumpScope(handle, step.verify.scope ?? 'menu'),
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
  } finally {
    if (!keepOpen) await closeSession(handle);
  }

  return {
    ok: !failedAt,
    steps,
    ...(failedAt ? { failedAt } : {}),
    viewerUrl: handle.viewerUrl,
  };
}

// What the probe can actually see right now, so a failing step says why.
async function dumpScope(handle, scope) {
  try {
    const obs = await handle.probe('observe');
    const pool = scope && obs[scope] ? obs[scope] : [...obs.toolbar, ...obs.menu, ...obs.dialog];
    return pool.map(c => c.raw + (c.disabled ? '   [disabled]' : ''));
  } catch {
    return [];
  }
}

// Prefer an enabled match, but keep a disabled one so the caller can say which it was.
// Docs ships its menubar disabled during load, so the wait matters.
async function pollResolve(handle, target, timeoutMs) {
  const start = Date.now();
  let fallback = null;
  do {
    const hit = await handle.probe('resolve', target);
    if (hit && !hit.disabled) return hit;
    fallback ??= hit;
    await handle.page.waitForTimeout(100);
  } while (Date.now() - start < timeoutMs);
  return fallback;
}

async function pollCheck(handle, verify, timeoutMs) {
  const start = Date.now();
  do {
    if (await handle.probe('check', verify)) return true;
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
    if (s.visible?.length) {
      console.log(`            visible in that scope (${s.visible.length}):`);
      for (const v of s.visible.slice(0, 25)) console.log(`              ${JSON.stringify(v)}`);
      if (s.visible.length > 25) console.log(`              … ${s.visible.length - 25} more`);
    } else if (s.visible) {
      console.log('            nothing visible in that scope at all');
    }
  }
  console.log(report.ok
    ? `\n  PASS — replays clean in a fresh 1440×900 cloud Chrome.\n`
    : `\n  FAIL at ${report.failedAt}. Watch it: ${report.viewerUrl}\n`);
  return report.ok;
}
