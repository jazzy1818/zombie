// [C] The runtime bridge — the one piece that lets the two halves talk.
//
// PLAN.md's rule is that authoring (cloud) and teaching (local) never talk at
// runtime, and for a pre-generated library that stays true: the panel searches
// lessons/ and nothing leaves the machine. This server is the escape hatch for
// the case the library can't answer — the panel asks for a goal it has no
// lesson for, and we generate one on the spot.
//
// It exists because a Chrome extension cannot do this itself. It can't hold a
// Steel key safely, and driving a cloud browser needs Playwright over CDP,
// which has no meaning inside an extension. So: one local process, started
// once, holding the keys, doing the thing the extension can't.
//
// Start it with:  npm run bridge
//
//   POST /generate  { goal, id?, docUrl?, check?, verify? }  -> { jobId }
//   POST /match     { question, candidates: [{id, goal, summary}] } -> { id | null, reason }
//   GET  /jobs/:id                                           -> job state
//   GET  /lessons                                            -> saved lesson ids
//   GET  /health                                             -> { ok: true, match: true }
//
// Jobs are async because generation takes 1-4 minutes and no browser will hold
// a request open that long. The panel polls.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { openAuthedSession, openLocalSession, closeSession } from './session.js';
import { explore } from './explore.js';
import { prune } from './prune.js';
import { emit } from './emit.js';
import { verifyLesson } from './verify.js';

const PORT = Number(process.env.BRIDGE_PORT ?? 7777);
const LESSONS = new URL('../extension/lessons/', import.meta.url);
const INDEX = new URL('index.json', LESSONS);

// One Steel session at a time. Two concurrent explorations on the same Google
// account fight over the same document and produce traces that interleave.
let running = false;

const jobs = new Map();
const JOB_TTL_MS = 30 * 60_000;

/* ------------------------------------------------------------------ lessons */

/**
 * An id derived from the user's own words. The panel never sees this — it runs
 * the lesson object directly — but it's the filename, so it has to be sane and
 * it has to not collide with a lesson we already have.
 */
function slugify(goal) {
  const base = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(w => !['how', 'do', 'i', 'a', 'an', 'the', 'to', 'in', 'my', 'can', 'you'].includes(w))
    .slice(0, 5)
    .join('-');
  return base || 'lesson';
}

async function uniqueId(goal) {
  const existing = new Set(await listSaved());
  const base = slugify(goal);
  if (!existing.has(base)) return base;
  for (let n = 2; n < 100; n++) if (!existing.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now()}`;
}

async function listSaved() {
  try {
    const files = await readdir(fileURLToPath(LESSONS));
    return files.filter(f => f.endsWith('.json') && f !== 'index.json').map(f => f.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * Write the lesson, then rewrite the index.
 *
 * The index is what makes a lesson findable next time — the extension can't
 * list a directory, so a file that isn't in the index is invisible no matter
 * how good it is. Rebuilt from the directory rather than appended to, so a
 * hand-deleted lesson doesn't leave a dangling entry.
 */
async function saveLesson(lesson) {
  await mkdir(fileURLToPath(LESSONS), { recursive: true });
  await writeFile(new URL(`${lesson.id}.json`, LESSONS), JSON.stringify(lesson, null, 2));
  const ids = await listSaved();
  await writeFile(INDEX, `${JSON.stringify(ids.sort(), null, 2)}\n`);
  return ids;
}

/* --------------------------------------------------------------------- jobs */

function newJob(goal) {
  const id = `j_${Math.random().toString(36).slice(2, 10)}`;
  const job = { id, goal, state: 'running', progress: [], startedAt: Date.now() };
  jobs.set(id, job);

  // Without this a long-lived bridge accumulates every lesson it ever made.
  for (const [key, old] of jobs) {
    if (old.state !== 'running' && Date.now() - old.startedAt > JOB_TTL_MS) jobs.delete(key);
  }
  return job;
}

const note = (job, text) => {
  job.progress.push({ at: Date.now(), text });
  console.log(`  [${job.id}] ${text}`);
};

/**
 * The whole pipeline, for one goal.
 *
 * Mirrors `author.js run`, with two differences that matter when a human is
 * waiting: fewer exploration attempts, and verify is off by default. A second
 * replay doubles the wait for someone staring at a panel — and they are about
 * to walk the lesson themselves, which is a better test than any replay.
 */
async function runJob(job, spec) {
  const { goal, docUrl, check, verify, local } = spec;
  let trace = null;

  for (let attempt = 1; attempt <= 2 && !trace; attempt++) {
    const handle = local ? await openLocalSession() : await openAuthedSession();
    job.viewerUrl = handle.viewerUrl;
    try {
      note(job, attempt === 1 ? 'Opening a cloud browser…' : `Retrying (attempt ${attempt})…`);
      const result = await explore(handle, {
        goal,
        docUrl,
        goalCheck: check ?? { kind: 'none' },
        onStep(ev) {
          if (ev.phase === 'opening') note(job, 'Loading the document…');
          if (ev.phase === 'click') note(job, `Tried "${ev.name}" — ${ev.reasoning}`);
          if (ev.phase === 'checking') note(job, 'Checking whether that worked…');
          if (ev.phase === 'reached') note(job, 'Found a path that works.');
          if (ev.phase === 'stuck') note(job, `Stuck: ${ev.reasoning}`);
        },
      });
      if (result.ok) trace = result;
      else note(job, `That attempt did not reach the goal (${result.reason}).`);
    } finally {
      await closeSession(handle);
    }
  }

  if (!trace) throw new Error(`I explored but couldn't find a reliable way to do "${goal}".`);

  note(job, 'Removing the wrong turns…');
  const pruned = prune(trace);

  note(job, 'Writing the explanation…');
  const id = spec.id ?? await uniqueId(goal);
  const lesson = await emit(pruned, { id, goal });

  if (verify) {
    note(job, 'Replaying it in a fresh browser to be sure…');
    const report = await verifyLesson(lesson, { docUrl, local: !!local });
    if (!report.ok) throw new Error('The lesson did not replay cleanly, so I threw it away.');
  }

  note(job, 'Saving it for next time…');
  await saveLesson(lesson);

  job.lesson = lesson;
  job.state = 'done';
  note(job, `Done — ${lesson.steps.length} steps.`);
}

/* -------------------------------------------------------------------- match */

// The panel's own search is lexical: it can only see shared words, which is
// how "add a header" once opened the headings lesson and "email draft" opened
// version history. When it is not confident it asks here, and the model reads
// the question against the real lessons and says which one — if any — does
// what the user asked. One short call, no browser, no Steel session.
const Match = z.object({
  id: z.string().describe('The id of the one saved lesson that teaches what the user asked, or exactly "none".'),
  reason: z.string().describe('One sentence: why that lesson fits, or why none of them does.'),
});

const MATCH_RULES = `You decide whether one of the saved Browser Teacher lessons answers a user's question about Google Docs.

A lesson matches only if completing its steps does what the user asked. Sharing words is not a match:
- "how do I add a header or footer" is NOT a lesson about heading styles or a table of contents.
- "add an email draft" is NOT a lesson about version history, even though a version is a kind of draft.
- "insert a table" is NOT the table-of-contents lesson.
Different wording for the same task IS a match: "make my document have chapters" is the headings and table-of-contents lesson.

If no saved lesson does what the user asked, answer "none". Prefer "none" over a loose fit: a wrong lesson wastes the user's time, while "none" lets us go and work the task out for them.`;

async function matchLesson({ question, candidates }) {
  const client = new Anthropic();
  const list = candidates
    .map(c => `- id: ${c.id}\n  goal: ${c.goal}\n  summary: ${c.summary}`)
    .join('\n');

  const res = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: zodOutputFormat(Match) },
    system: MATCH_RULES,
    messages: [{
      role: 'user',
      content: `Question: ${question}\n\nSaved lessons:\n${list}\n\nWhich lesson id answers the question, or "none"?`,
    }],
  });

  const parsed = res.parsed_output;
  const id = parsed && candidates.some(c => c.id === parsed.id) ? parsed.id : null;
  return { id, reason: parsed?.reason ?? '' };
}

/* ------------------------------------------------------------------- server */

// The panel fetches from a content script, so the request carries the page's
// origin (https://docs.google.com) and is subject to CORS. We are a localhost
// dev tool talking to one known caller, so this is deliberately open.
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

const send = (res, code, body) => {
  cors(res);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, busy: running, match: true, docUrl: !!process.env.DEMO_DOC_URL });
  }

  if (url.pathname === '/match' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (err) { return send(res, 400, { error: err.message }); }

    const question = typeof body.question === 'string' && body.question.trim();
    if (!question) return send(res, 400, { error: 'question is required' });

    const candidates = (Array.isArray(body.candidates) ? body.candidates : [])
      .filter(c => c && typeof c.id === 'string' && typeof c.goal === 'string')
      .slice(0, 50)
      .map(c => ({ id: c.id, goal: c.goal.slice(0, 200), summary: String(c.summary ?? '').slice(0, 400) }));
    if (!candidates.length) return send(res, 200, { id: null, reason: 'no saved lessons' });

    try {
      const result = await matchLesson({ question, candidates });
      console.log(`  [match] "${question}" -> ${result.id ?? 'none'} — ${result.reason}`);
      return send(res, 200, result);
    } catch (err) {
      // The panel treats anything but a clean answer as "bridge could not say"
      // and falls back to its local picker, so a model or key problem here
      // degrades rather than wrongly reporting "no match".
      console.warn(`  [match] failed: ${err.message}`);
      return send(res, 502, { error: err.message });
    }
  }

  if (url.pathname === '/lessons') {
    return send(res, 200, { lessons: await listSaved() });
  }

  if (url.pathname.startsWith('/jobs/')) {
    const job = jobs.get(url.pathname.slice('/jobs/'.length));
    if (!job) return send(res, 404, { error: 'no such job' });
    return send(res, 200, {
      id: job.id, state: job.state, progress: job.progress,
      viewerUrl: job.viewerUrl, lesson: job.lesson, error: job.error,
    });
  }

  if (url.pathname === '/generate' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (err) { return send(res, 400, { error: err.message }); }

    const goal = typeof body.goal === 'string' && body.goal.trim();
    if (!goal) return send(res, 400, { error: 'goal is required' });

    const docUrl = body.docUrl ?? process.env.DEMO_DOC_URL;
    if (!docUrl) return send(res, 400, { error: 'no docUrl and DEMO_DOC_URL is not set' });

    // A second session would fight the first over the same document.
    if (running) return send(res, 409, { error: 'already generating a lesson — try again in a minute' });

    const job = newJob(goal);
    running = true;
    send(res, 202, { jobId: job.id });

    runJob(job, { goal, docUrl, id: body.id, check: body.check, verify: !!body.verify, local: !!body.local })
      .catch(err => {
        job.state = 'error';
        job.error = err.message;
        note(job, `Failed: ${err.message}`);
      })
      .finally(() => { running = false; });
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Browser Teacher bridge on http://localhost:${PORT}`);
  console.log(`  Doc: ${process.env.DEMO_DOC_URL ?? 'DEMO_DOC_URL not set — the panel must send one'}`);
  console.log('\n  Leave this running. Ask the panel a question it has no lesson for.\n');
});
