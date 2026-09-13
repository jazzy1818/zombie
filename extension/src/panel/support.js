// Can this page be taught at all?
//
// The teaching layer has exactly one requirement, and it is not "is this
// Google Docs". It is: every control a lesson points at has to be findable by
// accessible name, in this frame's light or open-shadow DOM. Everything the
// panel does — spotlight, ghost cursor, waiting for the user's own click —
// hangs off findTarget() succeeding, and findTarget() can only see what
// queryDeep(CONTROL) returns.
//
// So the probe measures precisely that, using the resolver's own definitions
// rather than a second opinion that could drift from them. If the page has
// controls we can name, we can teach it. If it doesn't, no amount of lesson
// authoring will help, and saying so plainly is better than a chat bar that
// silently never finds anything.
//
// Bias is deliberately toward "supported": a false "can't teach this" on a
// working app is much worse than a lesson that turns out to resolve nothing,
// because the second one is recoverable and the first one is the end of the
// session. Every real web app clears MIN_CONTROLS by an order of magnitude.

import { CONTROL, ACTION_ROLES, queryDeep, usable, accessibleName, roleOf } from '../teaching/resolution.js';

const MIN_CONTROLS = 6;        // below this there is nothing a lesson could point at
const CANVAS_SHARE = 0.5;      // of the viewport, before we call it a canvas app
const FRAME_SHARE = 0.5;       // of the viewport, before we blame the iframe

export const REASON = {
  OK: 'ok',
  CANVAS: 'canvas',
  FRAMED: 'framed',
  UNLABELLED: 'unlabelled',
  BARE: 'bare',
  NO_DOCUMENT: 'no-document',
};

const area = element => {
  const rect = element.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
};

const viewportArea = () => Math.max(1, window.innerWidth * window.innerHeight);

/** Controls the resolver could actually be asked to find, by accessible name. */
function nameableControls() {
  const names = new Set();
  for (const element of queryDeep(CONTROL)) {
    if (!usable(element)) continue;
    const role = roleOf(element);
    // Same rule findTarget applies: a container's concatenated text is not a
    // control's name, so grouping roles don't count as something to point at.
    if (role && !ACTION_ROLES.has(role)) continue;
    const name = accessibleName(element);
    if (name) names.add(name);
  }
  return names;
}

/**
 * Why a page with no nameable controls has none. The count is the verdict;
 * this only decides which sentence the user gets, so a wrong guess here costs
 * a slightly off explanation rather than a wrong decision.
 */
function diagnose() {
  const viewport = viewportArea();

  const canvas = queryDeep('canvas').filter(usable);
  if (canvas.some(element => area(element) / viewport >= CANVAS_SHARE)) return REASON.CANVAS;

  // We only ever query our own frame. An app rendered inside a frame is
  // invisible to us from out here whatever its markup looks like.
  const frames = [...document.querySelectorAll('iframe, frame')].filter(usable);
  if (frames.some(element => area(element) / viewport >= FRAME_SHARE)) return REASON.FRAMED;

  // Controls exist but none of them carry a name we could ask for. Nothing to
  // be done from this side: this is the site's accessibility, not our bug.
  const unnamed = queryDeep(CONTROL).filter(usable).length;
  return unnamed >= MIN_CONTROLS ? REASON.UNLABELLED : REASON.BARE;
}

/**
 * One measurement of the current page.
 * @returns {{ok: boolean, reason: string, controls: number, frames: number}}
 */
export function probeSupport() {
  if (typeof document === 'undefined' || !document.body) {
    return { ok: false, reason: REASON.NO_DOCUMENT, controls: 0, frames: 0 };
  }
  const controls = nameableControls().size;
  const frames = [...document.querySelectorAll('iframe, frame')].filter(usable).length;
  if (controls >= MIN_CONTROLS) return { ok: true, reason: REASON.OK, controls, frames };
  return { ok: false, reason: diagnose(), controls, frames };
}

/**
 * The same measurement, but patient.
 *
 * Single-page apps mount their chrome after `document_idle`, so probing once at
 * load would declare Gmail unteachable roughly every time. Poll until the page
 * looks teachable or we run out of patience, then report whatever we last saw.
 */
export async function awaitSupport({ timeout = 8000, interval = 250, signal } = {}) {
  const end = performance.now() + timeout;
  let report = probeSupport();
  while (!report.ok && performance.now() < end && !signal?.aborted) {
    await new Promise(resolve => setTimeout(resolve, interval));
    report = probeSupport();
  }
  return report;
}

/**
 * What to tell the user. Each one names the actual obstacle rather than
 * "unsupported site" — someone who hits this should be able to tell whether
 * they picked the wrong tab or whether the app is simply out of reach.
 */
export function explain(report, site = 'this page') {
  switch (report.reason) {
    case REASON.CANVAS:
      return `${site} draws its interface on a canvas, so there are no buttons for me to point at. `
        + `I can only teach apps built out of real page elements.`;
    case REASON.FRAMED:
      return `${site} runs its interface inside an embedded frame that I'm not allowed to reach into. `
        + `If the app has its own address, opening it directly usually works.`;
    case REASON.UNLABELLED:
      return `I can see controls on ${site}, but none of them are labelled, so I have no way to say `
        + `which one you should click. That's the site's accessibility, and I can't work around it.`;
    case REASON.NO_DOCUMENT:
      return `There's no page here for me to read.`;
    default:
      return `I can't find anything on ${site} to point at yet. `
        + `If the app is still loading, reload once it's finished.`;
  }
}
