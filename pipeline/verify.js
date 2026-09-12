// [C] Stage 5 — verification replay. The highest-value thing Steel does.
// Fresh session, clean state, replay using ONLY the emitted descriptors — not the
// original trace, the actual JSON you're about to ship.
//
//   completes → valid, ship
//   fails     → descriptors too fragile, discard and re-run
//
// You can't test a lesson against a user's real account. Here you can test it a hundred
// times against throwaway ones.
//
// Pointed at the two HAND-WRITTEN lessons this is also the machine check that closes the
// open questions in docs/findings.md — which is why it gets built before explore.js. The
// demo has to be safe before the agent loop exists; §16 makes live generation cut item #1.
import { openAuthedSession, closeSession } from './session.js';
import { RESOLVE_TIMEOUT_MS, VERIFY_TIMEOUT_MS } from './config.js';

/**
 * @typedef {object} StepReport
 * @property {string} id
 * @property {'ok'|'unresolved'|'verify-failed'|'skipped'} status
 * @property {string} [name]     the bare name we tried to resolve
 * @property {number} [count]    how many VISIBLE elements matched — >1 means nth mattered
 * @property {number} ms
 * @property {string} [note]
 */

/**
 * Replay a Lesson against a fresh cloud browser.
 * @returns {Promise<{ok: boolean, steps: StepReport[], failedAt?: string, viewerUrl: string}>}
 */
export async function verifyLesson(lesson, opts = {}) {
  const { docUrl = process.env.DEMO_DOC_URL, keepOpen = false } = opts;
  if (!docUrl) throw new Error('no doc URL — pass { docUrl } or set DEMO_DOC_URL');

  const handle = await openAuthedSession();
  const steps = [];
  let failedAt;

  // Up front, not just on failure — a replay takes long enough to open this and watch it.
  console.log(`\n  ${lesson.id} — watch: ${handle.viewerUrl}`);

  try {
    await handle.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
    await handle.page.waitForSelector('#docs-toolbar-wrapper', { timeout: 30_000 });
    // Docs finishes wiring its menus a beat after the toolbar paints.
    await handle.page.waitForTimeout(1500);

    for (const step of lesson.steps) {
      const t0 = Date.now();

      // target: null is an instruct-only step — "click on the title line". The document
      // body is canvas-rendered, so there is no DOM element to resolve and nothing to
      // replay. Not a failure; just outside what this can check.
      if (!step.target) {
        steps.push({
          id: step.id, status: 'skipped', ms: Date.now() - t0,
          note: 'instruct-only (target: null) — canvas, nothing to resolve',
        });
        continue;
      }

      const hit = await pollResolve(handle, step.target, RESOLVE_TIMEOUT_MS);
      if (!hit) {
        steps.push({
          id: step.id, status: 'unresolved', name: step.target.name,
          ms: Date.now() - t0,
          note: `no visible match for ${JSON.stringify(step.target)}`,
        });
        failedAt = step.id;
        break;                       // descriptors-too-fragile signal. Stop here.
      }

      // Click through Playwright, not el.click(). Docs listens on the capture phase and
      // its menus dismiss on blur; a synthetic HTMLElement.click() skips the pointer
      // sequence and can behave differently from the real user click the extension waits
      // for. Replay the thing the user will actually do.
      await handle.page.click(`[data-bt-id="${hit.id}"]`, { timeout: 5000 });

      if (step.verify && step.verify.kind !== 'none') {
        const passed = await pollCheck(handle, step.verify, VERIFY_TIMEOUT_MS);
        if (!passed) {
          steps.push({
            id: step.id, status: 'verify-failed', name: step.target.name,
            count: hit.count, ms: Date.now() - t0,
            note: `clicked, but ${JSON.stringify(step.verify)} never passed`,
          });
          failedAt = step.id;
          break;
        }
      }

      steps.push({
        id: step.id, status: 'ok', name: step.target.name,
        count: hit.count, ms: Date.now() - t0,
        // A `none` verify only asserts resolution + a successful click. That's the honest
        // limit of what `none` can check.
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

async function pollResolve(handle, target, timeoutMs) {
  const start = Date.now();
  do {
    const hit = await handle.probe('resolve', target);
    if (hit) return hit;
    await handle.page.waitForTimeout(100);
  } while (Date.now() - start < timeoutMs);
  return null;
}

async function pollCheck(handle, verify, timeoutMs) {
  const start = Date.now();
  do {
    if (await handle.probe('check', verify)) return true;
    await handle.page.waitForTimeout(100);
  } while (Date.now() - start < timeoutMs);
  return false;
}

const MARK = { ok: '  ok  ', unresolved: ' FAIL ', 'verify-failed': ' FAIL ', skipped: ' skip ' };

/** Human-readable report. Returns true if the lesson is shippable. */
export function printReport(lesson, report) {
  console.log(`\n  ${lesson.id} — ${lesson.goal}`);
  for (const s of report.steps) {
    const nth = s.count > 1 ? `  (${s.count} visible matches — nth matters)` : '';
    console.log(`   [${MARK[s.status]}] ${s.id.padEnd(4)} ${(s.name ?? '').padEnd(28)} ${String(s.ms).padStart(5)}ms${nth}`);
    if (s.note) console.log(`            ${s.note}`);
  }
  console.log(report.ok
    ? `\n  PASS — replays clean in a fresh 1440×900 cloud Chrome.\n`
    : `\n  FAIL at ${report.failedAt}. Watch it: ${report.viewerUrl}\n`);
  return report.ok;
}
