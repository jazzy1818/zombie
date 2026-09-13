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
//
// docUrl is whatever page the panel is open on, so a question asked on GitHub
// explores GitHub. DEMO_DOC_URL is only the fallback for a panel that didn't
// send one.
//   GET  /jobs/:id                                           -> job state
//   POST /jobs/:id/cancel                                    -> cancel job
//   GET  /lessons                                            -> saved lesson ids
//   GET  /health                                             -> { ok: true, match: true }
//
// Jobs are async because generation takes 1-4 minutes and no browser will hold
// a request open that long. The panel polls.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { openExploreSession, closeSession, tryLoadProfile } from './session.js';
import { explore } from './explore.js';
import { prune } from './prune.js';
import { emit } from './emit.js';
import { verifyLesson } from './verify.js';
import { createJobViewer } from './session-viewer.js';
import { createReplayService } from './session-replay.js';
import { STEEL_API_KEY } from './config.js';
import { appFor, choosePage } from './apps.js';

const PORT = Number(process.env.BRIDGE_PORT ?? 7777);
const LESSONS = new URL('../extension/lessons/', import.meta.url);
const INDEX = new URL('index.json', LESSONS);

// One Steel session at a time. Two concurrent explorations on the same Google
// account fight over the same document and produce traces that interleave.
let running = false;

const jobs = new Map();
const JOB_TTL_MS = 24 * 60 * 60_000;
const replays = createReplayService({
  apiKey: STEEL_API_KEY,
  baseUrl: () => `http://127.0.0.1:${server.address()?.port ?? PORT}`,
});

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
  const job = {
    id, goal, state: 'running', progress: [], startedAt: Date.now(),
    abort: new AbortController(),
    handle: null,        // the live Steel session, so cancel can release it now
    polledAt: Date.now(),
  };
  createJobViewer(job);
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

// Cancellation and normal finally blocks can race. They share the same release
// promise so the server stays busy until cleanup finishes, without releasing a
// paid session twice. Weak keys do not keep browser handles alive with job history.
const handleReleases = new WeakMap();
function releaseOnce(handle, close = closeSession) {
  if (!handle) return Promise.resolve();
  if (!handleReleases.has(handle)) {
    handleReleases.set(handle, Promise.resolve().then(() => close(handle)));
  }
  return handleReleases.get(handle);
}

/**
 * Stop a job and release its cloud browser now. Closing the session interrupts
 * pending Playwright waits; the signal stops model output at its next safe point.
 */
export async function cancelJob(job, why) {
  if (job.state !== 'running') return false;
  job.state = 'cancelled';
  job.error = why;
  job.abort.abort();
  note(job, why);
  const handle = job.handle;
  job.handle = null;
  if (handle) await (job.releaseHandle ?? releaseOnce)(handle).catch(() => {});
  return true;
}

// A closed tab, a crashed browser, a shut laptop: none of them send anything. Without
// this the session runs to its Steel timeout and blocks every later question.
const ABANDONED_MS = 60_000;

setInterval(() => {
  for (const job of jobs.values()) {
    if (job.state !== 'running') continue;
    if (Date.now() - job.polledAt < ABANDONED_MS) continue;
    cancelJob(job, 'Nobody was waiting for this any more, so I stopped it.')
      .catch(err => console.error(`  [${job.id}] cleanup failed:`, err.message));
  }
}, 10_000).unref();

/**
 * The whole pipeline, for one goal.
 *
 * Mirrors `author.js run`, with two differences that matter when a human is
 * waiting: fewer exploration attempts, and verify is off by default. A second
 * replay doubles the wait for someone staring at a panel — and they are about
 * to walk the lesson themselves, which is a better test than any replay.
 */
export async function runJob(job, spec, overrides = {}) {
  const { goal, docUrl, check, verify, local } = spec;
  const services = { openExploreSession, closeSession, explore, prune, emit, verifyLesson, uniqueId, saveLesson, ...overrides };
  const viewer = createJobViewer(job, { registerRecording: overrides.registerRecording ?? replays.register });
  job.abort ??= new AbortController();
  const signal = job.abort.signal;
  const releaseHandle = handle => releaseOnce(handle, services.closeSession);
  job.releaseHandle = releaseHandle;
  const checkCancelled = () => signal.throwIfAborted();

  // Cancelling clears the live link immediately, including while an opener is
  // still pending. A later close callback may retain its recording, but a late
  // ready callback must never bring a cancelled browser back into the panel.
  let closeViewer = () => {};
  const onAbort = () => closeViewer();
  signal.addEventListener('abort', onAbort);
  function beginViewer(options) {
    const update = viewer.begin(options);
    closeViewer = () => update({ ...job.viewer,
      status: job.viewer.sessionId ? 'closed' : 'unavailable', url: null });
    return state => {
      if (!signal.aborted || state.status === 'closed') update(state);
    };
  }

  // Explore the app the panel was open on, preserving its auth policy through
  // retries and the optional fresh verification session.
  const app = appFor(docUrl);
  job.app = app.id;
  let trace = null;
  let browserNumber = 0;

  try {
    for (let attempt = 1; attempt <= 2 && !trace; attempt++) {
      checkCancelled();
      const onViewer = beginViewer({ attempt: ++browserNumber, local: !!local });
      note(job, attempt === 1
        ? `Opening a ${local ? 'local' : 'cloud'} browser on ${app.label}…`
        : `Retrying (attempt ${attempt})…`);
      let handle;
      try {
        // Public pages can use an anonymous browser when no saved profile is
        // available. The observer travels through every auth/local path.
        handle = await services.openExploreSession({ app, local: !!local, auth: spec.auth ?? 'auto', onViewer });
        job.handle = handle;
        checkCancelled(); // cancellation may have arrived while opening
        job.anonymous = !!handle.anonymous;
        if (handle.anonymous) note(job, `Browsing ${app.label} signed out.`);
        if (attempt === 1 && spec.pageUrl && spec.pageUrl !== docUrl) {
          note(job, 'Using the prepared document rather than yours — the cloud browser signs in as a different account.');
        }
        const result = await services.explore(handle, {
          goal,
          docUrl,
          app,
          signal,
          goalCheck: check ?? { kind: 'none' },
          onStep(ev) {
            if (signal.aborted) return;
            if (ev.phase === 'opening') note(job, `Loading ${ev.docUrl ?? app.label}…`);
            if (ev.phase === 'click') note(job, `Tried "${ev.name}" — ${ev.reasoning}`);
            if (ev.phase === 'checking') note(job, 'Checking whether that worked…');
            if (ev.phase === 'reached') note(job, 'Found a path that works.');
            if (ev.phase === 'stuck') note(job, `Stuck: ${ev.reasoning}`);
            if (ev.phase === 'login-wall') note(job, `That page wants a sign-in: ${ev.reason}.`);
          },
        });
        checkCancelled();
        if (result.ok) trace = result;
        else note(job, `That attempt did not reach the goal (${result.reason}).`);
      } finally {
        if (job.handle === handle) job.handle = null;
        if (handle) await releaseHandle(handle);
      }
    }

    checkCancelled();
    if (!trace) throw new Error(`I explored but couldn't find a reliable way to do "${goal}".`);

    note(job, 'Removing the wrong turns…');
    const pruned = services.prune(trace);

    note(job, 'Writing the explanation…');
    const id = spec.id ?? await services.uniqueId(goal);
    checkCancelled();
    const lesson = await services.emit(pruned, { id, goal, app });
    checkCancelled();

    if (verify) {
      note(job, 'Replaying it in a fresh browser to be sure…');
      const onViewer = beginViewer({ attempt: ++browserNumber, phase: 'verifying', local: !!local });
      const report = await services.verifyLesson(lesson, {
        docUrl, local: !!local, auth: spec.auth ?? 'auto', app, onViewer, signal,
        // Verification owns a fresh session. Make it reachable by cancellation
        // as soon as it opens and share release with its own finally block.
        onHandle: handle => { job.handle = handle; },
        releaseHandle,
      });
      checkCancelled();
      if (!report.ok) throw new Error('The lesson did not replay cleanly, so I threw it away.');
    }

    checkCancelled();
    note(job, 'Saving it for next time…');
    await services.saveLesson(lesson);
    checkCancelled();

    job.lesson = lesson;
    job.state = 'done';
    note(job, `Done — ${lesson.steps.length} steps.`);
  } finally {
    try {
      if (job.handle) await releaseHandle(job.handle);
    } finally {
      job.handle = null;
      delete job.releaseHandle;
      signal.removeEventListener('abort', onAbort);
      // Keep closed recordings for the same 24-hour window as job history.
      viewer.finish();
    }
  }
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

const MATCH_RULES = `You decide whether one of the saved Browser Teacher lessons answers a user's question about the app they are using.

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

  if (await replays.handle(req, res, url)) return;

  if (url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      busy: running,
      // The panel asks /match for a second opinion on an uncertain question.
      match: true,
      docUrl: !!process.env.DEMO_DOC_URL,
      // The panel sends its own page URL; this is only the fallback.
      fallbackApp: process.env.DEMO_DOC_URL ? appFor(process.env.DEMO_DOC_URL).id : null,
      // Whether a signed-in browser is available. Public pages work without
      // one; anything behind a login does not.
      profile: Boolean(await tryLoadProfile()),
    });
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
    const rest = url.pathname.slice('/jobs/'.length);
    const cancelling = rest.endsWith('/cancel');
    const job = jobs.get(cancelling ? rest.slice(0, -'/cancel'.length) : rest);
    if (!job) return send(res, 404, { error: 'no such job' });

    // sendBeacon can only POST, and it is the only thing that survives a closing tab.
    if (cancelling) {
      if (req.method !== 'POST') return send(res, 405, { error: 'cancel requires POST' });
      const stopped = await cancelJob(job, 'Cancelled — the cloud browser has been released.');
      return send(res, 200, { id: job.id, state: job.state, stopped });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'job polling requires GET' });
    // Polling is the liveness signal: it is what tells the reaper someone still cares.
    job.polledAt = Date.now();
    return send(res, 200, {
      id: job.id, state: job.state, progress: job.progress,
      viewer: job.viewer, viewerUrl: job.viewerUrl, recordings: job.recordings, lesson: job.lesson, error: job.error,
    });
  }

  if (url.pathname === '/generate' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (err) { return send(res, 400, { error: err.message }); }

    const goal = typeof body.goal === 'string' && body.goal.trim();
    if (!goal) return send(res, 400, { error: 'goal is required' });

    const docUrl = choosePage(body.docUrl);
    if (!docUrl) return send(res, 400, { error: 'no page URL sent and DEMO_DOC_URL is not set' });
    if (!/^https?:\/\//i.test(docUrl)) return send(res, 400, { error: 'page URL must be http(s)' });

    // A second session would fight the first over the same document.
    if (running) return send(res, 409, { error: 'already generating a lesson — try again in a minute' });

    const job = newJob(goal);
    running = true;
    send(res, 202, { jobId: job.id });

    runJob(job, {
      goal, docUrl, pageUrl: body.docUrl, id: body.id, check: body.check,
      verify: !!body.verify, local: !!body.local,
      // 'none' forces a signed-out browser — the honest way to check that a
      // lesson is reachable by a logged-out visitor.
      auth: body.auth === 'none' || body.auth === 'required' ? body.auth : 'auto',
    })
      .catch(err => {
        // A cancelled job already has its state and its reason; the throw that got us
        // out of the loop is the mechanism, not news.
        if (job.state === 'cancelled') return;
        job.state = 'error';
        job.error = err.message;
        note(job, `Failed: ${err.message}`);
      })
      .finally(async () => {
        if (job.handle) await (job.releaseHandle ?? releaseOnce)(job.handle).catch(() => {});
        job.handle = null;
        running = false;
      });
    return;
  }

  send(res, 404, { error: 'not found' });
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Browser Teacher bridge on http://localhost:${PORT}`);
  console.log(`  Fallback page: ${process.env.DEMO_DOC_URL ?? 'DEMO_DOC_URL not set — the panel must send its own'}`);
  console.log('\n  Leave this running. Ask the panel a question it has no lesson for,');
  console.log('  on any teachable site — it explores whatever page you asked from.\n');
});
