#!/usr/bin/env node
// [C] The CLI. Run with no args for the command list.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openAuthedSession, openCaptureSession, saveProfile, closeSession,
  listProfiles, adoptProfile,
} from './session.js';
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

// A valueless flag parses as `true`, which would beat the process.env fallback.
const str = v => (typeof v === 'string' && v.length ? v : undefined);

const fromCwd = p => resolvePath(process.cwd(), p);
const fromHere = p => fileURLToPath(new URL(p, import.meta.url));

const commands = {
  async 'capture-profile'() {
    const handle = await openCaptureSession();
    await saveProfile(handle);
    console.log('\n  Done. explore/verify will use this automatically.\n');
  },

  // Hold a session open, and report the viewport / probe numbers from the environment
  // explore and verify actually run in.
  async open({ flags }) {
    const docUrl = str(flags.doc) ?? process.env.DEMO_DOC_URL;
    const handle = await openAuthedSession();

    try {
      if (docUrl) {
        await handle.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
        await handle.page.waitForSelector('#docs-toolbar-wrapper', { timeout: 30_000 });
        await handle.page.waitForTimeout(1500);
      } else {
        console.warn('\n  no DEMO_DOC_URL — opening a blank browser');
      }

      const [w, h] = await handle.page.evaluate(() => [window.innerWidth, window.innerHeight]);
      console.log(`\n  viewport   ${w}x${h}   ${w >= 1400 ? 'ok' : 'TOO NARROW — toolbar will be collapsed into More'}`);

      if (docUrl) {
        const obs = await handle.probe('observe');
        console.log(`  probe      ${obs.toolbar.length} toolbar, ${obs.menu.length} menu, ${obs.dialog.length} dialog visible`);

        const file = obs.menu.find(c => c.name === 'File');
        console.log(`  menubar    ${file ? `"File" found via ${file.source}` : '"File" NOT FOUND — version-history s1 will not resolve'}`);

        // Near-equal counts mean the visibility filter is broken.
        const total = await handle.page.evaluate(
          () => document.querySelectorAll('[role="menuitem"]').length,
        );
        console.log(`  filter     ${obs.menu.length} visible of ${total} in the DOM`);

        // Which account this browser is actually signed in as — the profile and your
        // local browser can easily be different accounts.
        const who = await handle.page.evaluate(() =>
          [...document.querySelectorAll('[aria-label]')]
            .map(e => e.getAttribute('aria-label'))
            .filter(l => l && l.includes('@'))
            .slice(0, 3));
        console.log(`  account    ${who.length ? who.join(' | ') : 'no signed-in account found — the session may be anonymous'}`);
      }

      if (docUrl) {
        const menu = await handle.page.evaluate(() => {
          const el = [...document.querySelectorAll('[role="menuitem"]')]
            .find(e => e.textContent.trim().startsWith('Version history'));
          return el ? { found: true, disabled: el.getAttribute('aria-disabled') === 'true' } : { found: false };
        });
        console.log(`  vers.hist  ${!menu.found ? 'not in the DOM' : menu.disabled ? 'DISABLED — this doc will not work for version-history' : 'enabled'}`);
      }

      const url = handle.session.debugUrl ?? handle.viewerUrl;
      console.log(`\n  Watch / drive it here:\n\n    ${url}${url.includes('?') ? '&' : '?'}interactive=true\n`);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('  Press ENTER to close the session... ');
      rl.close();
    } finally {
      await closeSession(handle);
    }
  },

  // Recovery for a capture that logged in but failed to write profile.json.
  async profiles() {
    const all = await listProfiles();
    if (!all.length) {
      console.log('\n  No profiles on this account. The login did not persist — re-run capture-profile.\n');
      return;
    }
    console.log('');
    for (const p of all) {
      const created = p.createdAt ?? p.created_at ?? '?';
      console.log(`  ${p.id}   ${String(p.status ?? '?').padEnd(10)} ${created}   ${p.name ?? ''}`);
    }
    console.log('\n  Adopt the newest READY one:  node author.js adopt <profileId>\n');
  },

  async adopt({ positional }) {
    const id = positional[0];
    if (!id) throw new Error('usage: node author.js adopt <profileId>  (list them with: node author.js profiles)');
    await adoptProfile(id);
  },

  async verify({ positional, flags }) {
    const paths = positional.length
      ? positional.map(fromCwd)
      : ['../extension/lessons/styles-toc.json', '../extension/lessons/version-history.json'].map(fromHere);

    let allOk = true;
    for (const p of paths) {
      const lesson = JSON.parse(await readFile(p, 'utf8'));
      const report = await verifyLesson(lesson, { docUrl: str(flags.doc) });
      allOk = printReport(lesson, report) && allOk;
    }
    if (!allOk) process.exitCode = 1;
  },

  async run({ flags }) {
    const id = str(flags.id) ?? 'scratch';
    const goal = str(flags.goal);
    if (!goal) throw new Error('--goal is required');

    const spec = {
      goal,
      docUrl: str(flags.doc) ?? process.env.DEMO_DOC_URL,
      goalCheck: str(flags.check) ? JSON.parse(flags.check) : { kind: 'none' },
    };
    if (spec.goalCheck.kind === 'none') {
      console.warn('[author] no --check given: "done" will be taken on the model\'s word.');
    }

    // Never emit from a trace that didn't reach the goal — it would teach the dead end.
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
    const trace = JSON.parse(await readFile(fromCwd(path), 'utf8'));
    const pruned = prune(trace);
    printPrune(trace, pruned);

    if (flags['skeleton-only']) return;
    const id = str(flags.id) ?? 'scratch';
    const lesson = await emit(pruned, { id, goal: trace.goal });
    console.log(`  wrote ${await saveLesson(id, lesson)}`);
  },

  async demo({ flags }) {
    await fallbackDemo({ live: !!flags.live, docUrl: str(flags.doc), spec: SHALLOW_GOAL });
  },
};

async function saveTrace(id, trace) {
  await mkdir(TRACES, { recursive: true });
  const name = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(new URL(name, TRACES), JSON.stringify(trace, null, 2));
  return name;
}

// out/, never extension/lessons/ — the pipeline must not overwrite the hand-written ones.
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
