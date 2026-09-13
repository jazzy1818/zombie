// [C] The live demo segment. Cached by default; --live generates for real, which takes
// 2-4 minutes and will not fit inside a 5-minute demo.
//
// Cached still drives a real cloud browser through a real Doc — only the model's
// decisions are replayed. Say that out loud on stage.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openExploreSession, closeSession } from './session.js';
import { explore } from './explore.js';
import { prune } from './prune.js';
import { emit } from './emit.js';
import { validatePublishable } from './publish.js';
import { RESOLVE_TIMEOUT_MS, VERIFY_TIMEOUT_MS } from './config.js';
import { appFor, waitForApp } from './apps.js';

const CACHE_DIR = new URL('./cache/', import.meta.url);

// Word count was the obvious shallow goal and it does not work: its dialog carries no
// aria-label, no id and no roles on its children, so no Verify kind can see the end state.
export const SHALLOW_GOAL = {
  id: 'zoom-150',
  goal: 'Set the page zoom to 150%',
  // 2 clicks, ~40s: Zoom → 150%. Docs writes the selection into the list's aria-label.
  goalCheck: { kind: 'dom', selector: '[aria-label="Zoom list. 150% selected."]' },
};

export async function fallbackDemo(opts = {}) {
  const {
    live = false,
    local = false,
    spec = SHALLOW_GOAL,
    docUrl = process.env.DEMO_DOC_URL,
    dwellMs = 1200,
  } = opts;

  if (!docUrl) throw new Error('no doc URL — pass { docUrl } or set DEMO_DOC_URL');

  // Validate the local recording before allocating a billed cloud session.
  const cached = live ? null : await loadCache(spec.id);
  if (cached) validatePublishable(cached.lesson);
  const handle = await openExploreSession({ app: appFor(docUrl), local, auth: spec.auth ?? 'auto' });
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

    await handle.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
    await waitForApp(handle, handle.app ?? appFor(docUrl));
    await handle.page.waitForTimeout(1500);

    for (const step of cached.lesson.steps) {
      if (!step.target) throw new Error('Cached replay cannot perform an instruct-only step. Rehearse this lesson with a learner.');
      console.log(`\n  → ${step.target.name}`);
      console.log(`    ${step.intent}`);
      await handle.page.waitForTimeout(dwellMs);

      const hit = await poll(handle, 'resolve', step.target, RESOLVE_TIMEOUT_MS,
        value => value && !value.disabled);
      if (!hit) throw new Error(`Cached replay could not resolve enabled target ${JSON.stringify(step.target)}.`);
      await handle.page.click(`[data-bt-id="${hit.id}"]`, { timeout: 5000 });
      if (!await poll(handle, 'check', step.verify, VERIFY_TIMEOUT_MS)) {
        throw new Error(`Cached replay failed outcome verification at ${step.id}.`);
      }
    }

    if (!await poll(handle, 'check', spec.goalCheck, VERIFY_TIMEOUT_MS)) throw new Error('Cached replay did not reach the requested goal.');

    console.log('\n  ...and here is the file it wrote:\n');
    console.log(JSON.stringify(cached.lesson, null, 2));
    return { lesson: cached.lesson, viewerUrl: handle.viewerUrl };
  } finally {
    await closeSession(handle);
  }
}

async function poll(handle, method, argument, timeout, accepts = Boolean) {
  const deadline = Date.now() + timeout;
  do {
    const value = await handle.probe(method, argument);
    if (accepts(value)) return value;
    await handle.page.waitForTimeout(80);
  } while (Date.now() < deadline);
  return null;
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
