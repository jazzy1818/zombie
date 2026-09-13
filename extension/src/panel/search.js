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
// cost, and nothing to fail on stage. The authoring bridge's /match route is
// layered on top for the ambiguous tail — see start() in panel.js.

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
 *
 * Deliberately no "er" rule: it made "header" and "heading" the same word, so
 * a question about headers and footers confidently launched the headings
 * lesson. It also mangled "paper", "number" and "border". The plural comes off
 * first so "headings" reaches the same stem as "heading".
 */
function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length >= 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('s') && !w.endsWith('ss') && w.length >= 4) w = w.slice(0, -1);
  for (const [suffix, min] of [['ing', 5], ['ed', 4], ['ly', 4]]) {
    if (w.endsWith(suffix) && w.length >= min) return w.slice(0, -suffix.length);
  }
  return w;
}

/** The question's own words, stop words removed, not yet stemmed. */
function rawTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOP.has(t))
    .map(t => t.replace(/^colour/, 'color'));
}

function tokenize(text) {
  return rawTokens(text).map(stem);
}

// These describe performing a task, not which task. They may contribute to
// prose ranking, but cannot make an unrelated lesson worth suggesting.
const GENERIC = new Set(tokenize('add insert change make set apply use open close select choose click press find show create adjust increase decrease turn enable disable option menu toolbar control button current wanna'));
const subjectTerms = text => tokenize(text).filter(term => !GENERIC.has(term));

/**
 * Words a user reaches for that a lesson's own prose may never contain. Kept
 * deliberately small — this is for vocabulary gaps, not for doing the matching.
 * Everything is stemmed on both sides, so list the plain form.
 *
 * Synonyms count for relevance but never for confidence on their own (see
 * isConfident): "draft" used to sit here pointing at version history, and
 * "add an email draft" confidently opened the version-history lesson.
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
};

// Both sides have to be stemmed or nothing ever matches: the query token is
// stemmed before lookup, so "chapters" arrives as "chapter" and would miss a
// key that stemmed differently. Keep the stemming here.
const SYNONYMS = new Map(
  Object.entries(RAW_SYNONYMS).map(([k, v]) => [stem(k), v.map(stem)]),
);

/** @returns {{terms: Map<string, number>, origin: Map<string, string>, direct: Set<string>}} */
function expand(tokens) {
  const terms = new Map();          // term -> weight (synonyms count for less)
  const origin = new Map();         // term -> the query word it came from
  const direct = new Set(tokens);   // terms the user actually typed
  const put = (term, weight, from) => {
    if ((terms.get(term) ?? 0) >= weight) return;
    terms.set(term, weight);
    origin.set(term, from);
  };

  for (const t of tokens) {
    put(t, 1, t);
    for (const s of SYNONYMS.get(t) || []) put(s, 0.55, t);
  }
  return { terms, origin, direct };
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

/** Adjacent token pairs. "table of contents" -> "table content" once stopped. */
function bigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/**
 * @param {Array} lessons  full lesson objects
 * @param {Object} extra   optional per-id array of hand-added terms, for
 *                         vocabulary the prose genuinely lacks ("toc")
 */
export function buildIndex(lessons, extra = {}) {
  const docs = lessons.map(lesson => {
    const tf = new Map();
    const bg = new Map();
    const subjects = new Set([
      ...subjectTerms(lesson.goal),
      ...(lesson.steps || []).flatMap(step => subjectTerms(step.target?.name)),
      ...(extra[lesson.id] || []).flatMap(subjectTerms),
    ]);
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
    return { id: lesson.id, tf, bg, norm, subjects };
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
 * Each result also carries:
 *   hits      how many distinct question words contributed (synonyms included)
 *   direct    how many of those were words the user actually typed
 *   phrase    whether a two-word phrase from the question matched
 *   coverage  the share of the question's words we recognised at all
 * because the score alone can't tell "two generic words matched weakly" from
 * "the goal was named", and those deserve very different amounts of trust.
 */
export function search(question, index) {
  const raw = rawTokens(question);
  const tokens = raw.map(stem);
  const { terms, origin, direct } = expand(tokens);
  const subjects = new Set(tokens.filter(term => !GENERIC.has(term)));

  // Rescue typos by mapping unknown terms onto the closest known one.
  for (const [t, w] of [...terms]) {
    if (index.idf.has(t)) continue;
    const near = nearest(t, index.vocab);
    if (near && !terms.has(near)) {
      terms.set(near, w * 0.8);
      origin.set(near, origin.get(t) ?? t);
      if (direct.has(t)) direct.add(near);
    }
  }

  // A question full of words we've never seen is a question about something we
  // don't teach — however well its one familiar word happens to score. Judged
  // on the word as typed: "footer" is a real, specific word even though its
  // stem is short.
  const contributed = new Set();
  for (const [term] of terms) {
    if (index.idf.has(term)) contributed.add(origin.get(term));
  }
  const unknown = raw.filter((word, i) => !contributed.has(tokens[i]) && word.length >= 4).length;
  const coverage = tokens.length ? (tokens.length - unknown) / tokens.length : 0;

  // "Change font" alone must not outweigh the requested subject in "change
  // font colour". Subject phrases such as "font size" keep their bonus.
  const qBigrams = bigrams(tokens).filter(pair => pair.split(' ').every(term => !GENERIC.has(term)));

  const ranked = index.docs
    .map(doc => {
      let score = 0;
      const hits = new Set();
      const subjectHits = new Set();
      const directHits = new Set();
      for (const [term, qWeight] of terms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        score += qWeight * tf * (index.idf.get(term) ?? 1);
        const from = origin.get(term) ?? term;
        if (direct.has(term)) directHits.add(from);
        if (subjects.has(from) && doc.subjects.has(term)) subjectHits.add(from);
        hits.add(from);
      }

      // A matched phrase is far stronger evidence than the same words apart:
      // "table contents" means this lesson, "insert table" means a feature we
      // don't teach. Worth several times a lone word.
      let phrase = 0;
      for (const p of qBigrams) phrase += doc.bg.get(p) ?? 0;
      score += phrase * BIGRAM_BOOST;

      return {
        id: doc.id, score: score / doc.norm, hits: hits.size,
        direct: directHits.size, phrase: phrase > 0, coverage,
        subjectHits: subjectHits.size,
        subjectCoverage: subjects.size ? subjectHits.size / subjects.size : 0,
      };
    })
    .sort((a, b) => b.score - a.score);

  ranked.unknown = unknown;
  return ranked;
}

const BIGRAM_BOOST = 3;   // a matched phrase counts for several loose words
const FLOOR = 0.5;        // below this we're reading tea leaves
const OFFER = 0.8;        // below this a lesson isn't even worth offering
const MARGIN = 1.5;       // how far clear of the runner-up before we commit
const STRONG = 2.5;       // loose words can carry it only when they score this high
const MIN_COVERAGE = 0.6; // most of the question has to be words we recognise
const BAND = 0.35;        // and a near miss has to be near the best answer, too
export const SUGGESTION_LIMIT = 3;

/**
 * The lessons worth putting in front of the user when we're not sure. A
 * question about something we don't teach should get an honest "I don't know
 * that", not four unrelated guesses dressed up as near misses.
 *
 * Require a subject match in the goal or target names before applying the
 * score floor and relative band. Mentions in hints alone cannot qualify a
 * lesson. Return at most three without padding a shorter result set.
 */
export function relevant(ranked) {
  const candidates = ranked.filter(r => r.score >= OFFER && r.subjectHits > 0);
  const best = candidates[0]?.score ?? 0;
  return candidates.filter(r => r.score >= best * BAND).slice(0, SUGGESTION_LIMIT);
}

/**
 * Enough signal to commit, or should we ask?
 *
 * Getting this wrong in the safe direction costs one extra click. Getting it
 * wrong in the other direction means confidently teaching the wrong lesson,
 * so the bar is deliberately high:
 *
 *   - a matched phrase, or a score no loose word overlap reaches
 *   - most of the question recognised ("add an email draft" is not about
 *     anything we teach just because "add" is)
 *   - at least one of the matching words typed by the user, not supplied by
 *     the synonym table
 *
 * "insert a table" shares two real words with the contents lesson and none of
 * them is a phrase; "add a header" used to share one stem with "headings".
 * Neither is the lesson, and neither passes this.
 */
export function isConfident(ranked) {
  const [best, next] = ranked;
  if (!best || best.score < FLOOR) return false;
  if (best.score < (next?.score ?? 0) * MARGIN) return false;
  if (best.coverage < MIN_COVERAGE || best.direct < 1) return false;
  if (best.subjectCoverage < 1) return false;
  return best.phrase || best.score >= STRONG;
}
