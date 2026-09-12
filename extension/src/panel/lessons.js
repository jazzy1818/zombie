// [B] Lesson loading + question matching.
//
// Lesson JSON is READ-ONLY input. The schema is frozen (PLAN.md §5) and
// extension/lessons/ belongs to C — if a lesson looks wrong, message them.

/** Bundled lessons. `keywords` are B's matching aid only — never read by anything else. */
export const LESSONS = [
  {
    id: 'styles-toc',
    keywords: [
      'table of contents', 'contents', 'toc', 'table of content',
      'outline', 'headings', 'heading', 'styles', 'style', 'chapters', 'sections',
    ],
  },
  {
    id: 'version-history',
    keywords: [
      'version history', 'version', 'versions', 'history', 'revision', 'revisions',
      'restore', 'revert', 'undo', 'previous', 'earlier', 'backup', 'saved', 'recover',
    ],
  },
];

const cache = new Map();

export async function loadLesson(id) {
  if (cache.has(id)) return cache.get(id);
  const url = chrome.runtime.getURL(`lessons/${id}.json`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lesson ${id}: ${res.status}`);
  const lesson = await res.json();
  cache.set(id, lesson);
  return lesson;
}

export function loadAll() {
  return Promise.all(LESSONS.map(l => loadLesson(l.id)));
}

const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Words too common to carry signal — "how do I add a table" shouldn't match on "add".
const STOP = new Set([
  'how', 'do', 'i', 'a', 'an', 'the', 'to', 'in', 'my', 'me', 'can', 'you',
  'what', 'is', 'this', 'that', 'of', 'on', 'for', 'and', 'it', 'with', 'get',
  'make', 'add', 'put', 'want', 'need', 'please', 'docs', 'document', 'google',
]);

/**
 * Score a question against every bundled lesson.
 * Returns { id, score } sorted best-first. Caller decides whether to trust it.
 */
export function scoreLessons(question) {
  const q = normalize(question);
  const tokens = q.split(' ').filter(t => t && !STOP.has(t));

  return LESSONS
    .map(({ id, keywords }) => {
      let score = 0;

      // Phrase hits are worth much more than single words: "table of contents"
      // appearing whole is near-certain intent, "history" alone is a guess.
      for (const kw of keywords) {
        if (!q.includes(kw)) continue;
        score += kw.includes(' ') ? 10 * kw.split(' ').length : 4;
      }

      // Loose token overlap, so a phrasing we didn't anticipate still lands somewhere.
      for (const t of tokens) {
        if (keywords.some(kw => kw.includes(t))) score += 1;
      }

      return { id, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Pick a lesson for a question.
 * `confident` false → the panel shows both lessons and lets the user choose,
 * rather than confidently teaching the wrong thing on stage.
 */
export function matchLesson(question) {
  const [best, next] = scoreLessons(question);
  // One solid keyword hit (4) is enough to commit. Below that we're guessing,
  // and guessing wrong in front of a judge is worse than asking.
  const confident = best.score >= 4 && best.score > (next?.score ?? 0);
  return { id: best.id, score: best.score, confident };
}
