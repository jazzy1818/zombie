// [C] Canned pipeline run for the live demo segment, in case the network, Steel, or the
// model is having a bad day at the worst possible moment. PLAN.md §14: keep the live task
// trivially shallow (2–3 steps, ~40s).
//
// The default path is CACHED, and that is what runs on stage. A real Steel cloud browser
// really is driving a real Google Doc on screen, at real speed, and the real emitted JSON
// is printed at the end. The only thing cached is the model's decisions. That is a fair
// thing to show and a fair thing to say out loud — say it.
//
// --live runs explore → prune → emit for real. §14's timing warning applies: a full lesson
// takes 2–4 minutes to generate, which kills a 5-minute demo. Keep the task shallow, or
// kick it off at the START of the demo and return to it as a callback.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openAuthedSession, closeSession } from './session.js';
import { explore } from './explore.js';
import { prune } from './prune.js';
import { emit } from './emit.js';

const CACHE_DIR = new URL('./cache/', import.meta.url);

export const SHALLOW_GOAL = {
  id: 'word-count',
  goal: 'Show the word count for this document',
  // Deliberately 2 clicks: Tools → Word count. ~40 seconds, per §14.
  goalCheck: { kind: 'visible', name: 'Word count', scope: 'menu' },
};

/**
 * @param {{live?: boolean, spec?: object, docUrl?: string, dwellMs?: number}} opts
 */
export async function fallbackDemo(opts = {}) {
  const {
    live = false,
    spec = SHALLOW_GOAL,
    docUrl = process.env.DEMO_DOC_URL,
    dwellMs = 1200,
  } = opts;

  if (!docUrl) throw new Error('no doc URL — pass { docUrl } or set DEMO_DOC_URL');

  const handle = await openAuthedSession();
  console.log(`\n  Watch it here:  ${handle.viewerUrl}\n`);

  try {
    if (live) {
      const trace = await explore(handle, { ...spec, docUrl });
      if (!trace.ok) throw new Error(`exploration failed: ${trace.reason}`);
      const pruned = prune(trace);
      const lesson = await emit(pruned, { id: spec.id, goal: spec.goal });
      await cache(spec.id, { trace, lesson });
      console.log(JSON.stringify(lesson, null, 2));
      return { lesson, viewerUrl: handle.viewerUrl };
    }

    const cached = await loadCache(spec.id);

    // Replay the cached decisions at presentation pace. Every click is real; only the
    // choice of which control to click was made earlier.
    await handle.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
    await handle.page.waitForSelector('#docs-toolbar-wrapper', { timeout: 30_000 });
    await handle.page.waitForTimeout(1500);

    for (const step of cached.trace.steps) {
      console.log(`\n  → ${step.target.name}`);
      console.log(`    ${step.action.reasoning}`);
      await handle.page.waitForTimeout(dwellMs);

      const hit = await handle.probe('resolve', {
        scope: step.target.scope, name: step.target.name,
      });
      if (!hit) {
        console.warn(`    (could not resolve "${step.target.name}" — skipping)`);
        continue;
      }
      await handle.page.click(`[data-bt-id="${hit.id}"]`, { timeout: 5000 });
    }

    console.log('\n  ...and here is the file it wrote:\n');
    console.log(JSON.stringify(cached.lesson, null, 2));
    return { lesson: cached.lesson, viewerUrl: handle.viewerUrl };
  } finally {
    await closeSession(handle);
  }
}

async function cache(id, payload) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(new URL(`${id}.json`, CACHE_DIR), JSON.stringify(payload, null, 2));
}

async function loadCache(id) {
  try {
    return JSON.parse(await readFile(new URL(`${id}.json`, CACHE_DIR), 'utf8'));
  } catch {
    throw new Error(
      `no cached run for "${id}". Record one first:  npm run demo -- --live`,
    );
  }
}
