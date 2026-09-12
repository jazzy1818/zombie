// [B] Lesson loading + question matching.
//
// Lesson JSON is READ-ONLY input. The schema is frozen (PLAN.md §5) and
// extension/lessons/ belongs to C — if a lesson looks wrong, message them.

import { buildIndex, search, isConfident } from './search.js';

/** Bundled lessons. Add an id here when C ships a new one. */
export const LESSONS = [
  { id: 'styles-toc' },
  { id: 'version-history' },
];

/**
 * Vocabulary a lesson's own prose genuinely lacks — abbreviations, mostly.
 * Deliberately tiny: matching runs off the lesson text C wrote, and anything
 * long in here is a sign the lesson's own words need improving instead.
 */
const EXTRA_TERMS = {
  'styles-toc': ['toc', 'table of contents'],
  'version-history': ['version history', 'undo', 'revert'],
};

const cache = new Map();

export async function loadLesson(id) {
  if (cache.has(id)) return cache.get(id);
  const url = chrome.runtime.getURL(`lessons/${id}.json`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load lesson "${id}" (HTTP ${res.status}).`);
  const lesson = await res.json();
  validateLesson(lesson, id);
  cache.set(id, lesson);
  return lesson;
}

const MODES = new Set(['demo', 'guided', 'solo']);
const VERIFY_KINDS = new Set(['label', 'dom', 'visible', 'none']);

/**
 * Check a lesson against the frozen schema (PLAN.md §5) before we try to run it.
 *
 * C is still authoring these, and an emitter bug or a hand-editing slip should
 * name itself rather than surfacing as `undefined is not an object` somewhere in
 * the middle of step 4 on stage.
 *
 * Throws on anything that would break the runner. Warns on the softer stuff —
 * a missing hint degrades gracefully and isn't worth refusing to teach over.
 */
export function validateLesson(lesson, id = lesson?.id) {
  const bad = msg => { throw new Error(`Lesson "${id}" is malformed: ${msg}`); };

  if (!lesson || typeof lesson !== 'object') bad('not an object.');
  for (const key of ['id', 'goal', 'preamble', 'generalization']) {
    if (typeof lesson[key] !== 'string' || !lesson[key]) bad(`missing "${key}".`);
  }
  if (!Array.isArray(lesson.steps) || !lesson.steps.length) bad('no steps.');

  lesson.steps.forEach((step, i) => {
    const at = `step ${i + 1} (${step?.id ?? 'no id'})`;
    if (!step || typeof step !== 'object') bad(`${at} is not an object.`);
    if (typeof step.intent !== 'string' || !step.intent) bad(`${at} has no intent — nothing to narrate.`);
    if (!MODES.has(step.mode)) bad(`${at} has mode "${step.mode}", expected demo/guided/solo.`);

    if (step.target !== null && step.target !== undefined) {
      if (typeof step.target.name !== 'string' || !step.target.name) {
        bad(`${at} has a target with no name.`);
      }
      // These are authoring rules from §5 — they don't crash anything, they
      // just quietly stop the resolver matching. Worth shouting about.
      if (/[►]/.test(step.target.name)) {
        console.warn(`[browser-teacher] ${at}: target name contains "►" — should be the bare label`);
      }
      if (/Ctrl\+|⌘|\(.*\)$/.test(step.target.name)) {
        console.warn(`[browser-teacher] ${at}: target name looks like it includes a shortcut`);
      }
    } else if (step.mode === 'demo') {
      bad(`${at} is mode "demo" but has no target — there's nothing to demonstrate.`);
    }

    const kind = step.verify?.kind;
    if (!VERIFY_KINDS.has(kind)) bad(`${at} has verify kind "${kind}".`);
    if ((kind === 'label' || kind === 'dom') && !step.verify.selector) bad(`${at} verify "${kind}" needs a selector.`);
    if (kind === 'label' && !step.verify.match) bad(`${at} verify "label" needs a match.`);
    if (kind === 'visible' && !step.verify.name) bad(`${at} verify "visible" needs a name.`);

    if (!Array.isArray(step.hints) || step.hints.length < 2) {
      console.warn(`[browser-teacher] ${at}: expected two hints (conceptual, spatial)`);
    }
  });

  return lesson;
}

export function loadAll() {
  return Promise.all(LESSONS.map(l => loadLesson(l.id)));
}

let index = null;

/** Built once from the lesson prose. Cheap — a few hundred tokens per lesson. */
async function getIndex() {
  if (!index) index = buildIndex(await loadAll(), EXTRA_TERMS);
  return index;
}

/** Ranked lessons for a question, best first. Exported for the dev console. */
export async function scoreLessons(question) {
  return search(question, await getIndex());
}

/**
 * Pick a lesson for a question.
 *
 * `confident` false -> the panel shows the lessons and lets the user choose,
 * rather than confidently teaching the wrong thing on stage.
 *
 * Async because matching reads the lessons themselves. They're cached after the
 * first call, so this is a map lookup from then on.
 */
export async function matchLesson(question) {
  const ranked = await scoreLessons(question);
  const best = ranked[0];
  return {
    id: best?.id ?? LESSONS[0].id,
    score: best?.score ?? 0,
    confident: isConfident(ranked),
    ranked,
  };
}
