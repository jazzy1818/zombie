// Explicit local handoff. Publishing never creates a browser or calls a model.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateLesson } from '../extension/src/panel/lessons.js';

const DEFAULT_LESSONS = fileURLToPath(new URL('../extension/lessons/', import.meta.url));
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
export const STATE_TARGET = /\b(?:list|menu)\.\s.+\sselected\.\s*$/i;
export function assertLessonId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id === 'index') throw new Error('Lesson id must be a safe lowercase filename other than index.');
}

export function validatePublishable(lesson) {
  validateLesson(lesson);
  assertLessonId(lesson.id);
  const ids = new Set();
  for (const step of lesson.steps) {
    if (typeof step.id !== 'string' || !step.id || ids.has(step.id)) throw new Error('Lesson step ids must be present and unique.');
    ids.add(step.id);
    if (step.action !== 'click') throw new Error(`${step.id}: only click actions are supported.`);
    if (step.target !== null) {
      if (!step.target || STATE_TARGET.test(step.target.name)) throw new Error(`${step.id}: target must name a stable control, not a changing state readout.`);
      if (step.target.nth !== undefined && (!Number.isInteger(step.target.nth) || step.target.nth < 0)) throw new Error(`${step.id}: invalid nth.`);
      if (step.target.scope !== undefined && !['toolbar', 'menu', 'any', 'dialog'].includes(step.target.scope)) throw new Error(`${step.id}: unsupported target scope.`);
    }
  }
  return lesson;
}

export const lessonDigest = lesson => createHash('sha256').update(JSON.stringify(lesson)).digest('hex');

export function verificationEvidence(lesson, report) {
  validatePublishable(lesson);
  if (!report?.ok || report.steps?.length !== lesson.steps.length
    || report.steps.some((step, index) => step.status !== 'ok' || step.id !== lesson.steps[index].id)) {
    throw new Error('Publication requires a complete successful replay of every step; skipped or failed steps do not qualify.');
  }
  return {
    version: 1, lessonId: lesson.id, sha256: lessonDigest(lesson),
    verifiedAt: new Date().toISOString(), complete: true,
    environment: report.local ? 'local-browser' : 'cloud-browser',
    steps: report.steps.map(({ id, status }) => ({ id, status })),
  };
}

function checkEvidence(lesson, evidence) {
  if (evidence?.version !== 1 || evidence.complete !== true || evidence.lessonId !== lesson.id
    || evidence.sha256 !== lessonDigest(lesson)) throw new Error('Verification evidence does not match this exact lesson; verify it again before publishing.');
  verificationEvidence(lesson, { ok: true, steps: evidence.steps });
}

export async function recordVerification(lesson, report, reportsDir = fileURLToPath(new URL('./reports/', import.meta.url))) {
  validatePublishable(lesson);
  await mkdir(reportsDir, { recursive: true });
  const reportFile = join(reportsDir, `${lesson.id}.report.json`);
  await atomicJSON(reportFile, { lessonId: lesson.id, sha256: lessonDigest(lesson), recordedAt: new Date().toISOString(), ...report });
  const evidenceFile = join(reportsDir, `${lesson.id}.verify.json`);
  let evidence;
  try { evidence = verificationEvidence(lesson, report); }
  catch {
    // A failed current run must not leave yesterday's proof at the default path.
    await unlink(evidenceFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { reportFile, evidenceFile: null, evidence: null };
  }
  await atomicJSON(evidenceFile, evidence);
  return { reportFile, evidenceFile, evidence };
}

export async function runRecordedVerification(lesson, replay, reportsDir = fileURLToPath(new URL('./reports/', import.meta.url))) {
  validatePublishable(lesson);
  // Revoke before entering browser code, including initialization. Navigation,
  // click and connection failures can throw instead of returning a report.
  await unlink(join(reportsDir, `${lesson.id}.verify.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  try {
    const report = await replay();
    return { report, recorded: await recordVerification(lesson, report, reportsDir) };
  } catch (error) {
    await recordVerification(lesson, { ok: false, steps: [], reason: 'Replay threw before completing.' }, reportsDir);
    throw error;
  }
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function publishLesson(lesson, evidence, { lessonsDir = DEFAULT_LESSONS } = {}) {
  validatePublishable(lesson);
  checkEvidence(lesson, evidence);
  await mkdir(lessonsDir, { recursive: true });
  const lockPath = join(lessonsDir, '.publish.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another publication owns the lesson index; retry after it finishes.');
    throw error;
  }
  try {
    const indexPath = join(lessonsDir, 'index.json');
    let existing = [];
    try {
      const data = JSON.parse(await readFile(indexPath, 'utf8'));
      const entries = Array.isArray(data) ? data : data?.lessons;
      if (!Array.isArray(entries)) throw new Error('The existing lesson index is malformed.');
      existing = entries.map(entry => typeof entry === 'string' ? entry : entry?.id);
      existing.forEach(assertLessonId);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Index is the commit point. A crash before this rename can leave an
    // unlisted complete lesson file, but never a partial published lesson.
    await atomicJSON(join(lessonsDir, `${lesson.id}.json`), lesson);
    const ids = [...new Set([...existing, lesson.id])];
    await atomicJSON(indexPath, ids);
    return { lesson: join(lessonsDir, `${lesson.id}.json`), index: indexPath, ids };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
