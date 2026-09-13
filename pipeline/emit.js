// [C] Stage 4 — pruned trace → a Lesson matching PLAN.md §5.
//
// Two halves, kept apart on purpose: the skeleton never calls the model, and the
// narration call never touches a descriptor.
import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { candidatePool, canonicalTarget, isStateName } from './target-policy.js';

// Progressively gentler strips, so an over-trimmed name can back off instead of failing.
function stripLadder(raw, scope) {
  const t = String(raw).trim();
  if (scope === 'toolbar') {
    return [t.replace(/\s*\([^)]*\)\s*$/, '').trim(), t];
  }
  const noArrow = t.replace(/[▶▸►‣]\s*$/, '').trim();
  // "Page elementsUpdated" — Docs appends promo badges to menu labels.
  const noBadge = noArrow.replace(/(?:Updated|New)$/, '').trim();
  return [
    noBadge
      .replace(/\s*\([A-Za-z0-9]{1,3}\)\s*$/, '')
      .replace(/(?:Ctrl|Alt|Shift|Cmd|⌘|⌥|⇧|⌃)[^\s]*$/, '')
      .trim(),
    noBadge,
    noArrow.replace(/\s*\([A-Za-z0-9]{1,3}\)\s*$/, '').trim(),
    noArrow,
    t,
  ];
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
    if (!name) continue;
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

const SAFE_SELECTOR = /^(#[A-Za-z][\w-]*|\[aria-label="[^"]+"\])$/;

// Decision table over step.delta, first match wins.
export function deriveVerify(step, nextStep) {
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
      return { kind: 'label', selector: `#docs-toolbar-wrapper [aria-label="${changed.name}"]`, match: changed.to };
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

function deriveMode(i, total) {
  if (i === 0) return 'demo';                 // step 1 establishes the pattern
  if (total > 2 && i === total - 1) return 'solo';   // never end a 2-step lesson on solo
  return 'guided';
}

export function skeleton(kept) {
  return kept.map((step, i) => ({
    id: `s${i + 1}`,
    mode: deriveMode(i, kept.length),
    // Never null here — instruct-only steps need a human, the doc body is canvas.
    target: deriveTarget(step),
    action: 'click',
    verify: deriveVerify(step, kept[i + 1]),
    _trace: {
      reasoning: step.action.reasoning,
      expectation: step.action.expectation,
      observed: [
        step.delta.appeared.length && `${step.delta.appeared.length} controls appeared`,
        ...step.delta.changed.map(c => `${c.name} now reads "${c.to}"`),
      ].filter(Boolean).join('; ') || 'no visible change',
    },
  }));
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
      `${s.id}  [${s.mode}]  click "${s.target.name}" (${s.target.scope})`,
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
  const skel = skeleton(pruned.kept);
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

    const wrongHints = Object.fromEntries(
      (p.wrongHints ?? [])
        .filter(w => visibleNames.has(w.name))
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
    app: meta.app ?? 'google-docs',
    goal: meta.goal,
    preamble: prose?.preamble ?? '',
    generalization: prose?.generalization ?? '',
    steps,
  };

  validate(lesson);
  return lesson;
}

const Lesson = z.object({
  id: z.string().min(1),
  app: z.literal('google-docs'),
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
