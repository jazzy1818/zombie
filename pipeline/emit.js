// [C] Stage 4 — pruned trace → a Lesson matching PLAN.md §5.
//
// Two halves, kept apart on purpose: the skeleton never calls the model, and the
// narration call never touches a descriptor.
import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { candidatePool, canonicalTarget, isStateName } from './target-policy.js';
import { appFor, appById } from './apps.js';

// A trailing keyboard-shortcut run. A chord begins at a modifier word followed
// by "+" (Ctrl+, Alt+…) or a lone glyph (⌘⌥⇧⌃), and the run reaches the end
// over shortcut characters and chord separators. Requiring the "+"/glyph is
// what stops real words like "Alternative" or "Align" from reading as Alt.
// Docs glues one or two chords to the label: "Find and replaceCtrl+H",
// "HeaderCtrl+Alt+O, Ctrl+Alt+H". The old `[^\s]*$` stripped only the last
// space-delimited run and left "HeaderCtrl+Alt+O," behind, which the shortcut
// guard in validate() then rejected — that is the "name still carries a
// shortcut" failure. Mirrored in dom-probe.js bare(); keep them identical.
const SHORTCUT = /(?:(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|Fn)\s*\+|[⌘⌥⇧⌃])[A-Za-z0-9+\s,⌘⌥⇧⌃]*$/;
const stripShortcut = s => s.replace(SHORTCUT, '').replace(/[\s,]+$/, '').trim();

// A name that still carries a shortcut chord or a submenu arrow is never a real
// control name — the ladder must not emit one even as a last resort.
const DIRTY = /(?:Ctrl|Control|Alt|Option|Shift|Meta|Cmd|Command|⌘|⌥|⇧|⌃)\s*\+|[▶▸►‣]/;

// Progressively gentler strips, so an over-trimmed name can back off instead of failing.
function stripLadder(raw, scope) {
  const t = String(raw).trim();
  if (scope === 'toolbar') {
    return [t.replace(/\s*\([^)]*\)\s*$/, '').trim(), t];
  }
  const noArrow = t.replace(/[▶▸►‣]\s*$/, '').trim();
  // "Page elementsUpdated" — Docs appends promo badges to menu labels. Outside
  // Docs the equivalent is a count: "Issues 12", "Inbox 1,203".
  const noBadge = noArrow
    .replace(/(?:Updated|New)$/, '')
    .replace(/\s+\(?\d[\d,.\u202f\u00a0]*\+?k?\)?$/i, '')
    .trim();
  const noShortcut = stripShortcut(noBadge);
  const noAccel = noShortcut.replace(/\s*\([A-Za-z0-9]{1,3}\)\s*$/, '').trim();
  // Cleanest first, then gentler fallbacks. deriveTarget skips any that a
  // shortcut or arrow survived into, so these can safely include noisy forms.
  return [noAccel, noShortcut, noBadge, noArrow, t];
}

function matchesIn(pool, name, scope, options) {
  return candidatePool(pool, name, scope, options);
}

// Proven, not just derived: replay §8.1's matcher against step.pre, the visible set at
// click time, so nth counts what the resolver will actually match.
export function deriveTarget(step) {
  const { target } = step;
  if (target.disabled || target.state || isStateName(target.raw)) throw new Error('Cannot author a disabled control or changing state readout as an action target.');
  const scope = target.scope === 'dialog' ? 'any' : target.scope;
  const pool = step.pre[target.scope] ?? [];

  for (const name of stripLadder(target.raw, target.scope)) {
    if (!name || DIRTY.test(name)) continue;          // never emit a shortcut/arrow name
    const hits = matchesIn(pool, name, target.scope);
    if (!hits.length) continue;                       // over-stripped — back off
    const clicked = pool.find(candidate => candidate.id === target.id) || target;
    const canonical = canonicalTarget(hits, clicked);
    if (!canonical) continue;

    const out = { scope, name };
    if (hits.length > 1) {
      const nth = hits.findIndex(h => h.id === canonical.id);
      if (nth < 0) continue;                          // ambiguous AND unfindable — back off
      out.nth = nth;
    }
    return out;
  }

  throw new Error(
    `cannot derive a provable bare name for ${JSON.stringify(target.raw)} ` +
    `(scope ${target.scope}, step ${step.n}). Refusing to ship a guess.`,
  );
}

// An id, an aria-label, or a role scope followed by an aria-label. Deliberately
// narrow: a verify selector is written into shipped lesson data and evaluated
// against a live page, so anything it cannot express is better lost than guessed.
const SAFE_SELECTOR = /^(#[A-Za-z][\w-]*|\[role="[a-z]+"\]|\[aria-label="[^"]+"\])(\s\[aria-label="[^"]+"\])?$/;

// Decision table over step.delta, first match wins.
export function deriveVerify(step, nextStep, app) {
  if (nextStep) {
    const want = nextStep.target;
    if (step.delta.appeared.some(c => c.raw === want.raw && c.scope === want.scope)) {
      const name = stripLadder(want.raw, want.scope)
        .find(n => matchesIn(step.post[want.scope] ?? [], n, want.scope, { actionable: false }).length);
      if (name) return { kind: 'visible', name, scope: want.scope };
    }
  }

  const changed = step.delta.changed[0];
  if (changed) {
    // `label` reads textContent. A state readout holds its value in aria-label and its
    // textContent is empty, so the only kind that can see it is `dom`.
    if (changed.state) {
      const selector = `[aria-label="${changed.to}"]`;
      if (SAFE_SELECTOR.test(selector)) return { kind: 'dom', selector };
    } else {
      // Scoped to wherever this app keeps its toolbar, because a bare
      // [aria-label] can collide with a sidebar or a dialog that happens to
      // reuse the name. An app with no toolbar root falls back to the bare
      // label, which is still far better than losing the check.
      const root = app?.toolbarRoot;
      const selector = root
        ? `${root} [aria-label="${changed.name}"]`
        : `[aria-label="${changed.name}"]`;
      if (SAFE_SELECTOR.test(selector)) return { kind: 'label', selector, match: changed.to };
    }
  }

  const dialog = step.delta.appeared.find(c => c.scope === 'dialog');
  if (dialog) {
    const selector = `[aria-label="${dialog.raw}"]`;
    if (SAFE_SELECTOR.test(selector)) return { kind: 'dom', selector };
  }

  // `none` over a CSS-class selector: Docs minifies classes and they turn over between
  // deploys. Losing alternate-path detection beats losing the lesson.
  return { kind: 'none' };
}

// A terminal step that lands on one of many interchangeable options — a font, a
// heading level, a line-spacing value — can only record whichever one the
// explorer happened to click. Shipping that as the target turns every other
// legitimate choice into a wrong click: pick Georgia when the trace clicked
// Arial and the lesson tells you you're wrong. Mark the target `any` instead
// and the runtime widens to the whole list — see findTarget in
// extension/src/teaching/resolution.js.
//
// Selection roles only. "Upload from computer" and "Search the web" sit side by
// side in one menu but are not the same move; option, radio and checkbox items
// mean the page itself presents these as values of one setting. Checkbox items
// are in because Docs draws its font rows that way, and the runtime already
// treats them as choices — an emitter that did not would pin the explorer's
// font again on every regeneration.
const SELECTION_ROLES = new Set(['option', 'menuitemradio', 'menuitemcheckbox', 'radio']);
const MIN_PEERS = 3;

const words = value => String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];

// "how do I change the page zoom to 200%" asked for 200% specifically, so that
// step is not a free choice however many other percentages are on offer.
function goalNamesChoice(goal, name) {
  const asked = new Set(words(goal));
  const chosen = words(name);
  return chosen.length > 0 && chosen.every(word => asked.has(word));
}

/** The clicked control and the other options it sits among, or null when it is not one of a set. */
export function choiceGroup(step) {
  const clicked = step.target;
  const pool = step.pre[clicked.scope] ?? [];
  const self = pool.find(candidate => candidate.id === clicked.id) || clicked;
  const ancestors = self.ancestors ?? [];
  // Candidates are document-ordered, so the innermost containing one is last.
  const container = pool.find(candidate => candidate.id === ancestors[ancestors.length - 1]);
  if (!SELECTION_ROLES.has(self.role) && !(self.role === 'menuitem' && container?.role === 'listbox')) return null;
  const signature = ancestors.join(',');
  const peers = pool.filter(candidate => candidate.id !== self.id && candidate.role === self.role
    && (candidate.ancestors ?? []).join(',') === signature);
  return { self, peers };
}

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const label = candidate => candidate.name || candidate.raw;

/**
 * What the last step's free choice accepts: false for a pinned value, true for
 * any row in the list, or a pattern naming the rows that are the kind of thing
 * the goal asked for. "Change the heading" among Normal text, Title and
 * Heading 1–3 accepts the headings — the goal names the kind, and only some
 * rows are that kind — so Heading 2 is right while Title keeps its correction.
 * Nothing here knows Docs: the kind comes from the goal's own words.
 */
export function freeChoice(step, goal) {
  if (!goal) return false;              // nothing to rule the choice in or out
  const group = choiceGroup(step);
  if (!group || group.peers.length < MIN_PEERS) return false;
  const all = [group.self, ...group.peers];
  if (all.some(candidate => goalNamesChoice(goal, label(candidate)))) return false;
  const asked = new Set(words(goal).filter(word => word.length >= 4));
  const ofKind = candidate => words(label(candidate)).some(word => asked.has(word));
  const kind = all.filter(ofKind);
  if (kind.length >= 2 && kind.length < all.length && ofKind(group.self)) {
    return `^(?:${[...new Set(kind.map(label))].map(escapeRe).join('|')})$`;
  }
  return true;
}

export const isFreeChoice = (step, goal) => Boolean(freeChoice(step, goal));

/** The peer names a free choice accepts — the ones no wrongHint may name. */
export function acceptedPeers(any, step) {
  const peers = choiceGroup(step)?.peers ?? [];
  if (any === true) return new Set(peers.map(label));
  if (typeof any !== 'string') return new Set();
  const pattern = new RegExp(any);
  return new Set(peers.map(label).filter(name => pattern.test(name)));
}

function deriveMode(i, total) {
  if (i === 0) return 'demo';                 // step 1 establishes the pattern
  if (total > 2 && i === total - 1) return 'solo';   // never end a 2-step lesson on solo
  return 'guided';
}

/**
 * @param {object} meta  `app` — the explored app, for app-scoped verify
 *                       selectors; `goal` — what was asked, which decides
 *                       whether the last step is a free choice.
 */
export function skeleton(kept, meta = {}) {
  return kept.map((step, i) => {
    // Never null here — instruct-only steps need a human, the doc body is canvas.
    const target = deriveTarget(step);
    const free = i === kept.length - 1 ? freeChoice(step, meta.goal) : false;
    if (free) target.any = free;
    return {
      id: `s${i + 1}`,
      mode: deriveMode(i, kept.length),
      target,
      action: 'click',
      // Whatever changed on a free choice named the value that was chosen
      // ("Font list. Georgia selected."), so it cannot be the outcome a
      // different, equally correct choice has to produce.
      verify: free ? { kind: 'none' } : deriveVerify(step, kept[i + 1], meta.app),
      _trace: {
        reasoning: step.action.reasoning,
        expectation: step.action.expectation,
        accepted: free ? [target.name, ...acceptedPeers(free, step)] : [],
        observed: [
          step.delta.appeared.length && `${step.delta.appeared.length} controls appeared`,
          ...step.delta.changed.map(c => `${c.name} now reads "${c.to}"`),
        ].filter(Boolean).join('; ') || 'no visible change',
      },
    };
  });
}

// Flat types only. Structured outputs rejects tuples and records — they emit JSON Schema
// without a `type`. The lesson's [conceptual, spatial] pair and wrongHints map are
// rebuilt in the merge below.
const Narration = z.object({
  preamble: z.string(),
  generalization: z.string(),
  steps: z.array(z.object({
    id: z.string(),
    intent: z.string(),
    hintConceptual: z.string(),
    hintSpatial: z.string(),
    wrongHints: z.array(z.object({ name: z.string(), message: z.string() })),
  })),
});

const NARRATION_RULES = `You write the prose for a Browser Teacher lesson. The click path is
already fixed and you cannot change it — you are writing only the words a learner reads.

Voice, and it matters more than anything else here:
- "intent" explains WHY this control is the right one. Never "Click the Styles button" —
  say what the control IS FOR and what it means to use it. The learner is about to click it
  themselves; they need a reason, not a pointer.
- "hints" is exactly two strings, escalating: [conceptual, spatial]. Conceptual nudges the
  learner's thinking ("you're adding something new — which menu handles that?"). Spatial
  says where it is ("Insert menu, near the bottom"). Never give the exact answer in hint 1.
- "preamble" sets up the mental model before step 1. It should reframe the task: what the
  learner thinks they're doing vs. what is actually going on.
- "generalization" is the transferable rule, read at the end. NOT a "well done" — the point
  the learner keeps after the specific task is forgotten.
- "wrongHints" maps a control name to a correction. Only use control names that were
  actually visible at that step. Explain why the wrong thing was a reasonable guess and
  what distinguishes the right one. Optional; omit rather than pad.

Write in the voice of the two exemplar lessons below. Match their register exactly: plain,
unhurried, second person, no exclamation marks, no praise, no "simply" or "just".`;

async function narrate(client, skel, meta, exemplars) {
  const traceSummary = [
    `GOAL: ${meta.goal}`,
    '',
    'The fixed path (you cannot change these):',
    ...skel.map(s => [
      s.target.any
        ? `${s.id}  [${s.mode}]  choose from the list — the trace happened to pick "${s.target.name}" (${s.target.scope})`
        : `${s.id}  [${s.mode}]  click "${s.target.name}" (${s.target.scope})`,
      // The runtime accepts every one of these, so prose that steers the
      // learner to one of them, or corrects them for picking another, would be
      // contradicted by the lesson itself the moment they choose differently.
      ...(s.target.any ? [
        `      free choice: ${s._trace.accepted.map(name => `"${name}"`).join(', ')} are all equally correct.`,
        '      Do not tell the learner which of these to pick, and do not write wrongHints for any of them.',
      ] : []),
      `      the agent's reason: ${s._trace.reasoning}`,
      `      what happened:      ${s._trace.observed}`,
    ].join('\n')),
  ].join('\n');

  const res = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: zodOutputFormat(Narration) },
    system: [
      { type: 'text', text: NARRATION_RULES },
      {
        type: 'text',
        text: `EXEMPLAR LESSONS — match this voice:\n\n${exemplars}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: traceSummary }],
  });

  return res.parsed_output;
}

export async function emit(pruned, meta) {
  // The trace records which app it explored; a caller may name one instead.
  // Falling back to Docs keeps every pre-existing call site working.
  const app = meta.app
    ?? appById(pruned.app ?? meta.appId)
    ?? appFor(pruned.url ?? meta.url ?? 'https://docs.google.com/');
  const skel = skeleton(pruned.kept, { ...meta, app });
  const client = meta.client ?? new Anthropic();
  const exemplars = await loadExemplars();
  const prose = await narrate(client, skel, meta, exemplars);

  // The model writes sentences; the trace writes descriptors. Only intent/hints/
  // wrongHints are taken from prose — never target, verify, mode or order.
  const byId = new Map((prose?.steps ?? []).map(s => [s.id, s]));

  const steps = skel.map((s, i) => {
    const p = byId.get(s.id) ?? {};
    const visibleNames = new Set([
      ...(pruned.kept[i].pre.toolbar ?? []),
      ...(pruned.kept[i].pre.menu ?? []),
      ...(pruned.kept[i].pre.dialog ?? []),
    ].map(c => c.name));

    // On a free choice the accepted peers are right answers, whatever the model wrote.
    const peerNames = acceptedPeers(s.target.any, pruned.kept[i]);
    const wrongHints = Object.fromEntries(
      (p.wrongHints ?? [])
        .filter(w => visibleNames.has(w.name) && !peerNames.has(w.name))
        .map(w => [w.name, w.message]),
    );

    const step = {
      id: s.id,
      intent: p.intent ?? `Click ${s.target.name}.`,
      mode: s.mode,
      target: s.target,
      action: 'click',
      verify: s.verify,
      hints: [
        p.hintConceptual ?? `Look for ${s.target.name}.`,
        p.hintSpatial ?? `It is in the ${s.target.scope}.`,
      ],
    };
    if (Object.keys(wrongHints).length) step.wrongHints = wrongHints;
    return step;
  });

  const lesson = {
    id: meta.id,
    // What the extension scopes on: a lesson is only offered on the app it
    // was authored against. See extension/src/sites.js.
    app: app.id,
    goal: meta.goal,
    preamble: prose?.preamble ?? '',
    generalization: prose?.generalization ?? '',
    steps,
  };

  // A path that crossed a route change has to declare it, or the panel treats
  // the navigation as the learner leaving and cancels on the very click it
  // just asked for. See watchNavigation in extension/src/paint/navigation.js.
  if (navigates(pruned.kept)) lesson.navigates = true;

  validate(lesson);
  return lesson;
}

/** Did any step's click change the page's route? */
function navigates(kept) {
  const key = url => {
    try { const u = new URL(url); return `${u.origin}${u.pathname}${u.search}`; } catch { return url; }
  };
  return kept.some(step => step.pre?.url && step.post?.url && key(step.pre.url) !== key(step.post.url));
}

const Lesson = z.object({
  id: z.string().min(1),
  // Was z.literal('google-docs'), which made a lesson for any other app
  // unemittable. Any non-empty app id now; the value comes from apps.js, not
  // from the model, so it cannot be a hallucinated string.
  app: z.string().min(1),
  goal: z.string().min(1),
  preamble: z.string(),
  generalization: z.string(),
  steps: z.array(z.object({
    id: z.string(),
    intent: z.string().min(1),
    mode: z.enum(['demo', 'guided', 'solo']),
    target: z.object({
      scope: z.enum(['toolbar', 'menu', 'any']).optional(),
      name: z.string().min(1),
      nth: z.number().int().nonnegative().optional(),
      // One example from a list of interchangeable choices; the runtime accepts
      // any row in the same list, or any row whose label matches the pattern.
      // Additive to PLAN.md §5 — a reader that does not know the flag still
      // resolves the named control.
      any: z.union([z.boolean(), z.string()]).optional(),
    }).nullable(),
    action: z.literal('click'),
    verify: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('label'), selector: z.string(), match: z.string() }),
      z.object({ kind: z.literal('dom'), selector: z.string() }),
      z.object({ kind: z.literal('visible'), name: z.string(), scope: z.string().optional() }),
      z.object({ kind: z.literal('none') }),
    ]),
      hints: z.tuple([z.string(), z.string()]),
    wrongHints: z.record(z.string(), z.string()).optional(),
  })).min(1),
  navigates: z.boolean().optional(),
});

export function validate(lesson) {
  const r = Lesson.safeParse(lesson);
  if (!r.success) {
    throw new Error(`emitted lesson does not match PLAN.md §5:\n${JSON.stringify(r.error.issues, null, 2)}`);
  }
  // §5 authoring rules the schema cannot express.
  for (const s of lesson.steps) {
    if (!s.target) continue;
    if (isStateName(s.target.name)) throw new Error(`${s.id}: target name contains a changing state readout`);
    if (/[▶▸►‣]/.test(s.target.name)) throw new Error(`${s.id}: name still carries a submenu arrow`);
    if (/(Ctrl|Alt|Shift|⌘|⌥|⇧|⌃)\+/.test(s.target.name)) throw new Error(`${s.id}: name still carries a shortcut`);
  }
  return lesson;
}

async function loadExemplars() {
  const files = ['../extension/lessons/styles-toc.json', '../extension/lessons/version-history.json'];
  const out = [];
  for (const f of files) {
    const url = new URL(f, import.meta.url);
    out.push(await readFile(url, 'utf8'));
  }
  return out.join('\n\n');
}
