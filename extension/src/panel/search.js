// [B] Matching a question to a lesson.
//
// The point of this file: a lesson library is only as useful as the range of
// phrasings that can find it. "how do I add a table of contents", "make my doc
// have chapters" and "get an outline of my sections" are three questions and
// one lesson. Hand-written keyword lists only ever catch the phrasings the
// author happened to think of.
//
// So instead of a keyword list, index the prose C already wrote — the goal, the
// preamble, every step's intent, every hint, the generalization. It's a lot of
// natural language describing the task in the words a person would use, and it
// arrives free with every lesson C ever generates. Adding lessons makes search
// better with no work from us.
//
// Everything here is local and synchronous: no model, no network, no bundle
// cost, and nothing to fail on stage. A remote scorer can be layered on top for
// the ambiguous tail — see scoreRemote in matchLesson's caller.

/* ------------------------------------------------------------- tokenising */

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with',
  'about', 'into', 'to', 'from', 'in', 'on', 'is', 'are', 'was', 'be', 'been',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'i', 'my', 'me', 'you',
  'your', 'it', 'its', 'this', 'that', 'these', 'those', 'can', 'could',
  'would', 'should', 'will', 'what', 'how', 'why', 'when', 'where', 'which',
  'want', 'need', 'please', 'help', 'google', 'doc', 'docs', 'document',
  'thing', 'something', 'anything', 'there', 'here', 'get', 'got',
]);

/**
 * Crude suffix stripping. Not linguistically correct and doesn't need to be —
 * it only has to make "headings", "heading" and "headed" collide.
 */
function stem(w) {
  if (w.length <= 3) return w;
  for (const [suffix, min, repl] of [
    ['ies', 4, 'y'], ['ing', 5, ''], ['ers', 5, ''], ['er', 5, ''],
    ['ed', 4, ''], ['es', 4, ''], ['ly', 4, ''], ['s', 4, ''],
  ]) {
    if (w.endsWith(suffix) && w.length >= min) return w.slice(0, -suffix.length) + repl;
  }
  return w;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOP.has(t))
    .map(stem);
}

/**
 * Words a user reaches for that a lesson's own prose may never contain. Kept
 * deliberately small — this is for vocabulary gaps, not for doing the matching.
 * Everything is stemmed on both sides, so list the plain form.
 */
const RAW_SYNONYMS = {
  chapter: ['heading', 'section', 'outline'],
  section: ['heading', 'outline'],
  toc: ['table', 'contents', 'outline'],
  index: ['table', 'contents'],
  summary: ['outline', 'contents'],
  navigate: ['outline', 'contents'],
  title: ['heading', 'style'],
  format: ['style'],
  undo: ['version', 'history', 'restore'],
  revert: ['version', 'history', 'restore'],
  recover: ['version', 'history', 'restore'],
  backup: ['version', 'history', 'saved'],
  snapshot: ['version', 'history'],
  yesterday: ['version', 'history', 'earlier'],
  older: ['version', 'history', 'earlier'],
  previous: ['version', 'history', 'earlier'],
  draft: ['version', 'history'],
};

// Both sides have to be stemmed or nothing ever matches: the query token is
// stemmed before lookup, so "chapters" arrives as "chapt" and would miss a key
// spelled "chapter". This cost me a test run — keep the stemming here.
const SYNONYMS = new Map(
  Object.entries(RAW_SYNONYMS).map(([k, v]) => [stem(k), v.map(stem)]),
);

/** @returns {{terms: Map<string, number>, origin: Map<string, string>}} */
function expand(tokens) {
  const terms = new Map();          // term -> weight (synonyms count for less)
  const origin = new Map();         // term -> the query word it came from
  const put = (term, weight, from) => {
    if ((terms.get(term) ?? 0) >= weight) return;
    terms.set(term, weight);
    origin.set(term, from);
  };

  for (const t of tokens) {
    put(t, 1, t);
    for (const s of SYNONYMS.get(t) || []) put(s, 0.55, t);
  }
  return { terms, origin };
}

/* ---------------------------------------------------------------- indexing */

// A lesson's own words are worth more the closer they are to naming the task.
const WEIGHTS = {
  goal: 6,
  target: 2.5,
  intent: 2,
  hint: 1.5,
  prose: 1,
};

/** Every piece of text in a lesson, tagged with how much it should count. */
function fields(lesson) {
  const out = [[lesson.goal, WEIGHTS.goal]];
  out.push([lesson.preamble, WEIGHTS.prose]);
  out.push([lesson.generalization, WEIGHTS.prose]);
  for (const step of lesson.steps || []) {
    out.push([step.intent, WEIGHTS.intent]);
    if (step.target?.name) out.push([step.target.name, WEIGHTS.target]);
    for (const h of step.hints || []) out.push([h, WEIGHTS.hint]);
    for (const w of Object.values(step.wrongHints || {})) out.push([w, WEIGHTS.hint * 0.6]);
  }
  return out;
}

/**
 * @param {Array} lessons  full lesson objects
 * @param {Object} extra   optional per-id array of hand-added terms, for
 *                         vocabulary the prose genuinely lacks ("toc")
 */
/** Adjacent token pairs. "table of contents" -> "table content" once stopped. */
function bigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function buildIndex(lessons, extra = {}) {
  const docs = lessons.map(lesson => {
    const tf = new Map();
    const bg = new Map();
    const add = (term, weight) => tf.set(term, (tf.get(term) ?? 0) + weight);
    const addBg = (pair, weight) => bg.set(pair, (bg.get(pair) ?? 0) + weight);

    for (const [text, weight] of fields(lesson)) {
      const toks = tokenize(text);
      for (const t of toks) add(t, weight);
      // Word pairs are what separate "a table" from "a table of contents".
      // Single words can't: both lessons legitimately contain "table".
      for (const p of bigrams(toks)) addBg(p, weight);
    }
    for (const term of extra[lesson.id] || []) {
      const toks = tokenize(term);
      for (const t of toks) add(t, WEIGHTS.goal);
      for (const p of bigrams(toks)) addBg(p, WEIGHTS.goal);
    }

    // Long lessons have more words and would otherwise always win. Square root
    // rather than linear so length still counts for something.
    const norm = Math.sqrt([...tf.values()].reduce((a, b) => a + b, 0)) || 1;
    return { id: lesson.id, tf, bg, norm };
  });

  // Words in every lesson carry no signal. With a small library this matters
  // more, not less — "click", "menu" and "toolbar" are in all of them.
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + docs.length / n));

  const vocab = [...df.keys()];
  return { docs, idf, vocab };
}

/* ----------------------------------------------------------------- search */

/**
 * One typo shouldn't lose the lesson. Cheap because the vocabulary is tiny.
 * Requires a shared first letter — without it, short words find spurious
 * neighbours and drag in lessons that have nothing to do with the question.
 */
function nearest(term, vocab) {
  if (term.length < 5) return null;
  for (const v of vocab) {
    if (v[0] !== term[0]) continue;
    if (Math.abs(v.length - term.length) > 1) continue;
    if (withinOneEdit(term, v)) return v;
  }
  return null;
}

/**
 * One substitution, insertion, deletion — or one transposition of adjacent
 * characters, which is the typo people actually make ("verison", "histroy").
 * Damerau rather than plain Levenshtein for exactly that reason.
 */
function withinOneEdit(a, b) {
  if (a === b) return true;

  if (a.length === b.length) {
    const diffs = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length === 1) return true;                       // substitution
    if (diffs.length !== 2 || diffs[1] !== diffs[0] + 1) return false;
    const [i, j] = diffs;                                      // transposition
    return a[i] === b[j] && a[j] === b[i];
  }

  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length - s.length !== 1) return false;
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;                                                       // insert/delete
  }
  return true;
}

/**
 * Ranked lessons, best first. Pure function of the index.
 *
 * Each result also carries `hits` — how many distinct words of the question
 * actually contributed — because the score alone can't tell "two words matched
 * weakly" from "one common word matched hard", and those deserve very
 * different amounts of trust.
 */
export function search(question, index) {
  const tokens = tokenize(question);
  const { terms, origin } = expand(tokens);

  // Rescue typos by mapping unknown terms onto the closest known one.
  for (const [t, w] of [...terms]) {
    if (index.idf.has(t)) continue;
    const near = nearest(t, index.vocab);
    if (near && !terms.has(near)) {
      terms.set(near, w * 0.8);
      origin.set(near, origin.get(t) ?? t);
    }
  }

  // A question full of words we've never seen is a question about something we
  // don't teach — however well its one familiar word happens to score. Short
  // words are too generic to count as evidence either way.
  const contributed = new Set();
  for (const [term] of terms) {
    if (index.idf.has(term)) contributed.add(origin.get(term));
  }
  const unknown = tokens.filter(t => !contributed.has(t) && t.length >= 5).length;

  const qBigrams = bigrams(tokens);

  const ranked = index.docs
    .map(doc => {
      let score = 0;
      const hits = new Set();
      for (const [term, qWeight] of terms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        score += qWeight * tf * (index.idf.get(term) ?? 1);
        hits.add(origin.get(term) ?? term);
      }

      // A matched phrase is far stronger evidence than the same words apart:
      // "table contents" means this lesson, "insert table" means a feature we
      // don't teach. Worth several times a lone word.
      let phrase = 0;
      for (const p of qBigrams) phrase += doc.bg.get(p) ?? 0;
      score += phrase * BIGRAM_BOOST;

      return { id: doc.id, score: score / doc.norm, hits: hits.size, phrase: phrase > 0 };
    })
    .sort((a, b) => b.score - a.score);

  ranked.unknown = unknown;
  return ranked;
}

const BIGRAM_BOOST = 3;   // a matched phrase counts for several loose words
const FLOOR = 0.5;        // below this we're reading tea leaves
const MARGIN = 1.35;      // how far clear of the runner-up before we commit
const SOLO_STRONG = 1.6;  // a single word can carry it, but it has to be emphatic

/**
 * Enough signal to commit, or should we ask?
 *
 * Getting this wrong in the safe direction costs one extra click. Getting it
 * wrong in the other direction means confidently teaching a judge the wrong
 * lesson, so the bar is deliberately set high.
 */
export function isConfident(ranked) {
  const [best, next] = ranked;
  if (!best || best.score < FLOOR) return false;
  if (best.score < (next?.score ?? 0) * MARGIN) return false;

  // "how do I insert a pivot table" matches the contents lesson on `insert` and
  // `table` alone. Both words really are in it; the question still isn't about
  // it. An unrecognised, specific word is the tell.
  if (ranked.unknown > 0 && best.score < SOLO_STRONG) return false;

  // One matching word is only enough when it matched emphatically.
  return best.hits >= 2 || best.score >= SOLO_STRONG;
}

const RELEVANT_FLOOR = 0.35;   // below this the question didn't really match
const RELEVANT_RATIO = 0.25;   // and a long way behind the leader is noise too

/**
 * The lessons a question actually matched, best first.
 *
 * `search` scores every lesson, so a question about something we don't teach
 * still comes back as a full ranking — a lesson that shares one incidental word
 * sits at 0.06 above five zeroes. Offering that list is worse than offering
 * nothing: it reads as "here is your answer" when the honest answer is "I don't
 * know that one", and the picker is where the user decides whether to spend a
 * cloud browser on it.
 *
 * Two cuts, because one isn't enough. The floor drops questions where even the
 * best lesson barely registered. The ratio drops the tail of a question that
 * did match something — once the leader is clear, the ones trailing it are
 * sharing a common word, not answering the question.
 */
export function relevant(ranked) {
  const best = ranked?.[0]?.score ?? 0;
  if (best < RELEVANT_FLOOR) return [];
  const cutoff = Math.max(RELEVANT_FLOOR, best * RELEVANT_RATIO);
  return ranked.filter(r => r.hits > 0 && r.score >= cutoff);
}
