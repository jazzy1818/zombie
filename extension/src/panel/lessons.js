// [B] Lesson loading + question matching.
//
// Lesson JSON is READ-ONLY input. The schema is frozen (PLAN.md §5) and
// extension/lessons/ belongs to C — if a lesson looks wrong, message them.

import { buildIndex, search, isConfident, relevant } from './search.js';
import { lessonRunsHere, siteKey } from '../sites.js';

/**
 * Which lessons exist.
 *
 * A Chrome extension can't list a directory, so a batch that drops fifty
 * generated lessons into extension/lessons/ would be completely invisible to
 * us. C's emitter therefore also writes `lessons/index.json` and we read that.
 *
 * Accepted shapes, so a hand-edited file is hard to get wrong:
 *   ["styles-toc", "version-history"]
 *   { "lessons": ["styles-toc", ...] }
 *   [{ "id": "styles-toc" }, ...]
 *
 * No index yet -> fall back to the two hand-written lessons, so nothing breaks
 * before C's batch runner exists.
 */
const FALLBACK_IDS = ['styles-toc', 'version-history'];

function readIndex(data) {
  const raw = Array.isArray(data) ? data : data?.lessons;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(entry => (typeof entry === 'string' ? entry : entry?.id))
    .filter(id => typeof id === 'string' && id);
}

let idsPromise = null;

export function listLessons() {
  idsPromise ??= (async () => {
    try {
      const res = await fetch(chrome.runtime.getURL('lessons/index.json'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ids = readIndex(await res.json());
      if (!ids.length) throw new Error('index lists no lessons');
      return ids;
    } catch (err) {
      console.info(
        `[browser-teacher] lessons/index.json unavailable (${err.message}) — using the built-in list`,
      );
      return FALLBACK_IDS;
    }
  })();
  return idsPromise;
}

/**
 * Vocabulary a lesson's own prose genuinely lacks — abbreviations, mostly.
 * Deliberately tiny: matching runs off the lesson text C wrote, and anything
 * long in here is a sign the lesson's own words need improving instead.
 */
const EXTRA_TERMS = {
  'styles-toc': ['toc', 'table of contents'],
  'version-history': ['version history', 'undo', 'revert'],
  // Since search gates suggestions on a subject word from the goal or a target
  // name, the everyday synonyms a lesson's prose uses but its goal does not
  // have to be listed here or the lesson can never be offered for them.
  'change-font-style': ['typeface', 'font family'],
  'add-image': ['picture', 'photo'],
  'wanna-increase-font-size': ['bigger', 'larger', 'text size'],
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
      // `any` is a free choice: true for any row in the list, or a pattern the
      // chosen row's label must match ("any heading level").
      const { any } = step.target;
      if (any !== undefined && typeof any !== 'boolean' && typeof any !== 'string') bad(`${at} has an "any" that is neither true nor a pattern.`);
      if (typeof any === 'string') {
        try { new RegExp(any); } catch { bad(`${at} has an "any" pattern that is not a valid regular expression.`); }
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

/**
 * Every lesson we can actually run.
 *
 * Skips ones that fail to load or validate rather than rejecting, because a
 * single bad file out of an overnight batch must not take the whole library
 * down. The one the user explicitly asked for still throws — see loadLesson —
 * so a direct failure is still visible rather than silently missing.
 */
export async function loadAll() {
  const ids = await listLessons();
  const results = await Promise.all(ids.map(async id => {
    try {
      return await loadLesson(id);
    } catch (err) {
      console.warn(`[browser-teacher] skipping lesson "${id}": ${err.message}`);
      return null;
    }
  }));
  return results.filter(Boolean);
}

/**
 * The lessons that could actually run on the page we're on.
 *
 * Everything downstream — the index, the picker, the "I don't know that one"
 * copy — works off this rather than off loadAll(). A Google Docs lesson on
 * GitHub isn't a weak match to be ranked low, it's a lesson whose every step
 * points at a control that does not exist, and ranking can't tell the
 * difference because the prose still says "click Insert".
 */
export async function loadHere(site = siteKey()) {
  return (await loadAll()).filter(lesson => lessonRunsHere(lesson, site));
}

let index = null;
let indexedSite = null;

/**
 * Built once per site from the lesson prose. Cheap — a few hundred tokens per
 * lesson. Keyed on the site because a single-page app can carry us from one
 * host to another without ever reloading the extension.
 */
async function getIndex() {
  const site = siteKey();
  if (!index || indexedSite !== site) {
    index = buildIndex(await loadHere(site), EXTRA_TERMS);
    indexedSite = site;
  }
  return index;
}

/**
 * Fold a freshly generated lesson into the running panel.
 *
 * The bridge has already written it to lessons/ and added it to index.json, so
 * it's there permanently after a reload. This makes it findable *now* — the
 * user just waited three minutes for it, and asking a near-identical question
 * a minute later should hit the index rather than build it a second time.
 */
export function addLesson(lesson, site = siteKey()) {
  validateLesson(lesson);
  // The emitter stamps `app` from the page it explored, so this is a safety
  // net for a lesson that arrived without one. Without it such a lesson is
  // filtered out of the very library it was just built for, and the user, who
  // waited three minutes, is told we don't know how to do what we just learned.
  const claimsApp = lesson.app !== undefined || lesson.sites !== undefined || lesson.site !== undefined;
  if (!claimsApp && site) lesson.sites = [site];
  cache.set(lesson.id, lesson);
  const known = listLessons();
  idsPromise = known.then(ids => (ids.includes(lesson.id) ? ids : [...ids, lesson.id]));
  index = null;   // rebuilt on the next search, with this lesson in it
  indexedSite = null;
  return lesson;
}

/** Ranked lessons for a question, best first. Exported for the dev console. */
export async function scoreLessons(question) {
  return search(question, await getIndex());
}

/**
 * Score a question against the library.
 *
 * `matches` is the part of the ranking the question actually earned — often
 * empty, and that emptiness is the answer: we don't teach this yet, so the
 * panel should say so rather than pad the screen with the whole library.
 * `ranked` is still the full scoring, for the dev console.
 *
 * `confident` says the top match is a strong one. The panel still asks — it
 * never launches a lesson the user didn't choose — but it words the question
 * differently when it has a real answer to offer.
 *
 * Async because matching reads the lessons themselves. They're cached after the
 * first call, so this is a map lookup from then on.
 */
export async function matchLesson(question) {
  const ranked = await scoreLessons(question);
  const best = ranked[0];
  return {
    // No id rather than a Docs id: on a site we have no lessons for, the
    // ranking is empty and inventing a default here would hand the picker a
    // lesson the user never matched and the page can't run.
    id: best?.id ?? null,
    score: best?.score ?? 0,
    confident: isConfident(ranked),
    matches: relevant(ranked),
    ranked,
  };
}
