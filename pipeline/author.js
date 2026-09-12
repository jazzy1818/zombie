#!/usr/bin/env node
// [C] The CLI. Everything the pipeline does is reachable from here.
//
//   npm run capture-profile
//       Open a long-lived Steel session, log into Google by hand through the interactive
//       viewer, snapshot the auth to PROFILE_PATH. Do this once, ever.
//
//   npm run verify -- ../extension/lessons/styles-toc.json
//       THE WORKHORSE. Replay a lesson in a fresh 1440×900 cloud Chrome. Run it constantly.
//
//   npm run author -- --goal "..." --id my-lesson
//       explore → prune → emit → verify. Writes pipeline/out/<id>.json.
//
//   node author.js prune traces/<file>.json
//       Offline prune + emit against a saved trace. No Steel, no cost, instant iteration.
//
//   npm run demo [-- --live]
//       The live segment. Cached by default.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openAuthedSession, openCaptureSession, saveProfile, closeSession } from './session.js';
import { explore } from './explore.js';
import { prune, printPrune } from './prune.js';
import { emit } from './emit.js';
import { verifyLesson, printReport } from './verify.js';
import { fallbackDemo, SHALLOW_GOAL } from './fallback-demo.js';

const TRACES = new URL('./traces/', import.meta.url);
const OUT = new URL('./out/', import.meta.url);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue; }
    flags[key] = next;
    i++;
  }
  return { positional, flags };
}

const commands = {
  async 'capture-profile'() {
    const handle = await openCaptureSession();
    await saveProfile(handle);
    console.log('\n  Done. explore/verify will use this automatically.\n');
  },

  async verify({ positional, flags }) {
    const paths = positional.length
      ? positional
      : ['../extension/lessons/styles-toc.json', '../extension/lessons/version-history.json'];

    let allOk = true;
    for (const p of paths) {
      const lesson = JSON.parse(await readFile(new URL(p, import.meta.url), 'utf8'));
      const report = await verifyLesson(lesson, { docUrl: flags.doc });
      allOk = printReport(lesson, report) && allOk;
    }
    if (!allOk) process.exitCode = 1;
  },

  async run({ flags }) {
    const id = flags.id ?? 'scratch';
    const goal = flags.goal;
    if (!goal) throw new Error('--goal is required');

    const spec = {
      goal,
      docUrl: flags.doc ?? process.env.DEMO_DOC_URL,
      // A goalCheck is a probe predicate, written by hand per goal. Without one, "done" is
      // just the model's opinion and prune/verify have no success condition to work from.
      goalCheck: flags.check ? JSON.parse(flags.check) : { kind: 'none' },
    };
    if (spec.goalCheck.kind === 'none') {
      console.warn('[author] no --check given: "done" will be taken on the model\'s word.');
    }

    // Two retries, fresh session each time. Never emit from a trace that didn't reach the
    // goal — a lesson built from a dead end teaches the dead end.
    let trace;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const handle = await openAuthedSession();
      try {
        console.log(`\n[author] exploration attempt ${attempt}/3 — ${handle.viewerUrl}`);
        trace = await explore(handle, spec);
      } finally {
        await closeSession(handle);
      }
      await saveTrace(id, trace);
      if (trace.ok) break;
      console.warn(`[author] attempt ${attempt} failed: ${trace.reason}`);
      trace = null;
    }
    if (!trace) throw new Error('exploration never reached the goal — nothing emitted');

    const pruned = prune(trace);
    printPrune(trace, pruned);

    const lesson = await emit(pruned, { id, goal });
    const path = await saveLesson(id, lesson);
    console.log(`  wrote ${path}`);

    if (flags['no-verify']) return;
    const report = await verifyLesson(lesson, { docUrl: spec.docUrl });
    if (!printReport(lesson, report)) process.exitCode = 1;
  },

  async prune({ positional, flags }) {
    const path = positional[0];
    if (!path) throw new Error('usage: node author.js prune traces/<file>.json');
    const trace = JSON.parse(await readFile(path, 'utf8'));
    const pruned = prune(trace);
    printPrune(trace, pruned);

    if (flags['skeleton-only']) return;
    const id = flags.id ?? 'scratch';
    const lesson = await emit(pruned, { id, goal: trace.goal });
    console.log(`  wrote ${await saveLesson(id, lesson)}`);
  },

  async demo({ flags }) {
    await fallbackDemo({ live: !!flags.live, docUrl: flags.doc, spec: SHALLOW_GOAL });
  },
};

async function saveTrace(id, trace) {
  await mkdir(TRACES, { recursive: true });
  const name = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(new URL(name, TRACES), JSON.stringify(trace, null, 2));
  return name;
}

/**
 * Generated lessons go to pipeline/out/, NEVER to extension/lessons/. Copying one across
 * is a deliberate manual act after verify passes. Nothing the pipeline produces should be
 * able to overwrite the two hand-written lessons the demo depends on.
 */
async function saveLesson(id, lesson) {
  await mkdir(OUT, { recursive: true });
  const url = new URL(`${id}.json`, OUT);
  await writeFile(url, JSON.stringify(lesson, null, 2));
  return `pipeline/out/${id}.json`;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const cmd = positional.shift();
const fn = commands[cmd];

if (!fn) {
  console.error(`\nusage: node author.js <command>\n\n  ${Object.keys(commands).join('\n  ')}\n`);
  process.exit(1);
}

try {
  await fn({ positional, flags });
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
