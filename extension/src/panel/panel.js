// [B] The UI: a translucent chat bar pinned to the bottom, and a floating
// lesson window you can drag anywhere and resize.
//
// Injected into the page, NOT a browser popup — a popup closes the moment the
// user clicks the document, which is every single step of every lesson.
//
// The window floats over the page and never reflows it. That's load-bearing:
// anything that narrows Docs drops it below 1440px, collapses toolbar buttons
// into `More`, and makes lessons target elements that no longer exist (§3).
//
// FOCUS DISCIPLINE (PLAN.md §15, B's responsibility): Docs menus dismiss on
// blur. Every control suppresses mousedown, drag gestures preventDefault, and
// the bar's input is disabled while a lesson is running.
import { PANEL_WIDTH, PANEL_SIDE, OVERLAY_Z } from '../constants.js';
import { mountBar } from './launcher.js';
import { makeFloating } from './floating.js';
import { loadLesson, loadHere, matchLesson, listLessons, validateLesson, addLesson } from './lessons.js';
import { siteKey, siteLabel, lessonRunsHere, lessonSites } from '../sites.js';
import { awaitSupport, probeSupport, explain } from './support.js';
import { probe, check } from './probe.js';
import { findTarget } from '../teaching/resolution.js';
import { generateLesson, bridgeAvailable, cancelGeneration } from './generate.js';
import { runLesson, ACTION } from './machine.js';
import { createSpeech } from './speech.js';
import { installDev } from './dev.js';
import { onRaise } from '../paint/host.js';
import { watchNavigation } from '../paint/navigation.js';

const SPEAKER_SVG = `
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
    <path d="M4 8h2.6L10 5v10L6.6 12H4z" fill="currentColor"/>
    <g class="bt-waves" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <path d="M12.6 7.6a3.4 3.4 0 0 1 0 4.8"/>
      <path d="M14.8 5.4a6.5 6.5 0 0 1 0 9.2"/>
    </g>
    <path class="bt-slash" d="M13 7l5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

const HOST_ID = 'browser-teacher-root';

// Bumped whenever the panel's behaviour changes in a way a stale tab would
// hide. __BT_DEV.here() reports it, so "did this tab pick up my reload?" is a
// question with an answer rather than a guess.
const BUILD = 'site-scoped-3';

const WIN_W = PANEL_WIDTH + 40;   // squarish; constants.js still sets the base
const WIN_H = 380;
const MARGIN = 28;
const PICKER_LIMIT = 4;           // how many guesses to offer when unsure

export async function mountPanel() {
  if (document.getElementById(HOST_ID)) return;   // idempotent

  installDev();   // inert until you call __BT_DEV.<scenario>() from the console

  const host = document.createElement('div');
  host.id = HOST_ID;
  // NOTE for [A]: clicks inside this host are UI, not the user answering a
  // step. waitForClick() should ignore any event whose composedPath()
  // includes #browser-teacher-root.
  host.setAttribute('data-browser-teacher', 'ui');
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  await injectStyles(root);

  // The paint scrim is a manual popover in the browser's top layer. Put this
  // pointer-transparent surface above it, with only its controls interactive.
  host.style.setProperty('--bt-z', String(OVERLAY_Z));
  for (const [key, value] of Object.entries({
    all: 'initial', position: 'fixed', inset: '0', width: '100%', height: '100%',
    margin: '0', padding: '0', border: '0', overflow: 'visible',
    'max-width': 'none', 'max-height': 'none', 'pointer-events': 'none',
    background: 'transparent', 'z-index': String(OVERLAY_Z),
    transform: 'none', filter: 'none', opacity: '1', visibility: 'visible',
    'font-family': "'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, sans-serif",
    color: 'var(--bt-text)',
  })) host.style.setProperty(key, value, 'important');
  if (typeof host.showPopover === 'function') host.setAttribute('popover', 'manual');
  const raise = () => {
    // Popovers outside a native modal are visually above it but still inert.
    // Moving our host inside the active dialog keeps Stop/Close operable.
    const dialogs = [...document.querySelectorAll('dialog[open]')].filter(dialog => {
      try { return dialog.matches(':modal'); } catch { return true; }
    });
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    let focusedDialog = null;
    for (let node = focused; node; node = node.parentElement || node.getRootNode()?.host) {
      if (node.localName !== 'dialog' || !node.open) continue;
      try { if (!node.matches(':modal')) continue; } catch { /* Legacy browser. */ }
      focusedDialog = node;
      break;
    }
    const parent = focusedDialog || dialogs.at(-1) || document.documentElement;
    const modalRoot = parent.getRootNode();
    if (modalRoot instanceof ShadowRoot) {
      // Shadow-tree dialog open/close changes do not reach a document observer.
      dialogChanges.observe(modalRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    }
    if (host.parentNode !== parent) parent.appendChild(host);
    if (host.hasAttribute('popover')) {
      try {
        if (host.matches(':popover-open')) host.hidePopover();
        host.showPopover();
      } catch { /* Older documents keep the fixed-position fallback. */ }
    }
  };
  onRaise(raise);
  const dialogChanges = new MutationObserver(records => {
    if (!host.isConnected || records.some(record => record.type === 'attributes' && record.target.tagName === 'DIALOG')) raise();
  });
  dialogChanges.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });

  const win = document.createElement('section');
  win.className = 'bt-window';
  win.innerHTML = `
    <header class="bt-head">
      <span class="bt-grip" aria-hidden="true"></span>
      <span class="bt-title">Browser Teacher</span>
      <span class="bt-progress" hidden></span>
      <button class="bt-speak" type="button" aria-pressed="false">${SPEAKER_SVG}</button>
      <button class="bt-close" type="button" title="Close" aria-label="Close">×</button>
    </header>
    <div class="bt-body"></div>
    <footer class="bt-actions"></footer>
    <div class="bt-resize" title="Drag to resize"></div>
  `;
  root.appendChild(win);

  const els = {
    win,
    head: win.querySelector('.bt-head'),
    body: win.querySelector('.bt-body'),
    actions: win.querySelector('.bt-actions'),
    progress: win.querySelector('.bt-progress'),
    speak: win.querySelector('.bt-speak'),
    close: win.querySelector('.bt-close'),
    resize: win.querySelector('.bt-resize'),
  };

  const floating = makeFloating(win, { handle: els.head, resizer: els.resize });
  floating.place({
    left: PANEL_SIDE === 'right'
      ? Math.max(MARGIN, window.innerWidth - WIN_W - MARGIN)
      : MARGIN,
    top: Math.max(MARGIN, window.innerHeight - WIN_H - 120),
    width: WIN_W,
    height: WIN_H,
  });

  const speech = createSpeech();
  const ui = createUI(els, raise, speech);
  let currentRun = null;
  let liveJobId = null;

  // pagehide is the last thing that runs when the tab closes, and sendBeacon is the only
  // request that survives it. Without this a closed tab leaves a cloud browser running
  // until the bridge's reaper notices.
  window.addEventListener('pagehide', () => {
    if (liveJobId) cancelGeneration(liveJobId);
  });

  const cancel = () => {
    const previous = currentRun;
    currentRun = null;
    previous?.controller.abort();
    previous?.stopNavigation();
    window.__TEACH?.clear();
    ui.reset();
  };
  ui.onCancel = cancel;

  const bar = mountBar(root, {
    onPrompt: start,
    // Stop talking the moment they start — otherwise the mic hears us.
    onListenStart: () => speech.stop(),
  });
  ui.bindBar(bar);

  noFocusSteal(els.close);
  els.close.addEventListener('click', cancel);

  if (!speech.supported) {
    els.speak.hidden = true;
  } else {
    const syncSpeakButton = () => {
      els.speak.classList.toggle('is-on', speech.enabled);
      els.speak.setAttribute('aria-pressed', String(speech.enabled));
      els.speak.title = speech.enabled ? 'Reading aloud — click to mute' : 'Read the narration aloud';
    };
    syncSpeakButton();
    noFocusSteal(els.speak);
    els.speak.addEventListener('click', () => {
      speech.toggle();
      syncSpeakButton();
      // Turning it on mid-lesson should read what's on screen now, not wait
      // for the next step — otherwise it feels like the toggle did nothing.
      if (speech.enabled) ui.sayCurrent();
    });
  }

  /**
   * Every path into the runner goes through here. Checkpoint 1 is four
   * half-wired layers meeting for the first time — a thrown error must land
   * where someone can read it, not silently in the console behind the page.
   */
  async function session(work) {
    cancel();
    const controller = new AbortController();
    const run = { controller, stopNavigation: () => {} };
    currentRun = run;
    run.stopNavigation = watchNavigation(cancel);
    const active = () => currentRun === run && !controller.signal.aborted;
    const options = {
      signal: controller.signal,
      isCurrent: () => currentRun === run,
      // A lesson that walks the user through a route change has to say so
      // before the first step, or the watcher above cancels it on the click it
      // just asked for. Same-app moves only — leaving the app still ends it.
      allowNavigation() {
        if (currentRun !== run) return;
        run.stopNavigation();
        run.stopNavigation = watchNavigation(cancel, { site: true });
      },
    };
    let stopWaiting;
    const cancelled = new Promise((_, reject) => {
      stopWaiting = () => reject(new DOMException('Lesson cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', stopWaiting, { once: true });
    });
    ui.loading();
    try {
      await Promise.race([work({ active, options }), cancelled]);
      return { status: active() ? 'completed' : 'cancelled' };
    } catch (err) {
      if (err?.name === 'AbortError' || !active()) return { status: 'cancelled' };
      console.error('[browser-teacher]', err);
      ui.fail(err);
      return { status: 'error', message: err?.message || String(err) };
    } finally {
      controller.signal.removeEventListener('abort', stopWaiting);
      run.stopNavigation();
      if (currentRun === run) currentRun = null;
    }
  }

  function play(id, opts = {}) {
    return session(async ({ active, options }) => {
      const lesson = await loadLesson(id);
      // Last line of defence. Every step of a lesson for another app points at
      // a control that does not exist here, so it would spotlight nothing and
      // sit there waiting for a click the user cannot make. Say so instead.
      // __BT_DEV.run() bypasses this deliberately — see opts.anywhere.
      if (!opts.anywhere && !lessonRunsHere(lesson)) {
        ui.wrongApp(lesson);
        return;
      }
      if (lesson.navigates) options.allowNavigation();
      if (active()) await runLesson(lesson, ui, { ...opts, ...options });
    });
  }

  /**
   * A question never launches a lesson by itself — it always comes back with
   * choices. Even a strong match is a guess: "change the text colour" scores
   * hard against the colour lesson, and starting it unasked is the panel
   * deciding for the user, who then has to stop a lesson to say "not that one".
   * Confirming costs one click; guessing wrong costs the user's trust in every
   * later guess. `confident` still colours the wording — it just doesn't act.
   */
  function start(question) {
    return session(async ({ active, options }) => {
      const { confident, matches } = await matchLesson(question);
      if (!active()) return;

      // Offer the lessons the question actually matched — which is sometimes
      // none of them — and, if an authoring bridge happens to be running,
      // offer to go and learn it for real. Deliberately a button rather than
      // automatic: generation costs a cloud browser and a few minutes, which
      // is a bad thing to spend on a typo, mid-demo.
      const canGenerate = await bridgeAvailable();
      if (!active()) return;
      return ui.showPicker(question, matches, {
        signal: options.signal,
        confident,
        onGenerate: canGenerate ? () => generate(question) : null,
      });
    });
  }

  /** Send the question to the cloud browser, then teach whatever comes back. */
  function generate(question) {
    return session(async ({ active, options }) => {
      ui.generating(question);
      const lesson = await generateLesson(question, {
        signal: options.signal,
        // The page the user asked from IS the subject of the question. Without
        // this the bridge falls back to its configured demo doc and explores
        // Google Docs however the question was asked on GitHub.
        docUrl: location.href,
        // A closing tab fires no abort, so the id is kept where pagehide can reach it.
        onJob: id => { liveJobId = id; },
        onProgress: text => { if (active()) ui.generatingNote(text); },
      });
      liveJobId = null;
      if (!active()) return;
      // Findable by search from here on, so asking again doesn't rebuild it.
      addLesson(lesson);
      if (lesson.navigates) options.allowNavigation();
      await runLesson(lesson, ui, options);
    });
  }

  ui.onPickLesson = id => play(id);

  // Rehearsal: skip straight to the step you're practising.
  //   __BT_DEV.run('styles-toc', 3)
  if (window.__BT_DEV) {
    window.__BT_DEV.run = (id = 'styles-toc', step = 1) =>
      play(id, { from: Math.max(0, step - 1), anywhere: true });
    window.__BT_DEV.runLesson = (lesson, opts = {}) =>
      session(async ({ active, options }) => {
        validateLesson(lesson);
        if (active()) {
          await runLesson(lesson, ui, { ...opts, ...options });
        }
      });

    window.__BT_DEV.lessons = () => listLessons();

    // Authoring a lesson for a site nobody has taught yet starts here — see
    // panel/probe.js. Also the fastest way to tell a genuinely unteachable
    // page from one that simply hadn't finished loading.
    window.__BT_DEV.probe = filter => probe(filter);
    window.__BT_DEV.check = target => check(target, t => findTarget(t));
    window.__BT_DEV.support = () => probeSupport();

    /**
     * What the panel thinks about the page it is on.
     *
     * The first question to ask when the panel offers something unexpected:
     * which site does it believe it is on, and which lessons did it consider?
     * Reloading an unpacked extension does NOT update tabs that were already
     * open, so an old content script serving the whole library on the wrong
     * site is the likeliest cause of a lesson appearing where it should not.
     * `build` being absent is the tell.
     */
    window.__BT_DEV.here = async () => {
      const site = siteKey();
      const here = await loadHere(site);
      const report = { build: BUILD, site, label: siteLabel(site), teachable: probeSupport() };
      report.lessons = here.map(l => ({ id: l.id, app: l.app ?? '(none)' }));
      const all = await listLessons();
      report.excluded = all.length - here.length;
      console.log(`%c[bt] ${report.lessons.length} of ${all.length} lessons run on ${report.label}`,
        'color:#4F9CF9;font-weight:bold');
      console.table(report.lessons);
      return report;
    };
  }

  ui.reset();
  raise();

  /**
   * Decide whether this page is teachable at all, and say so if it isn't.
   *
   * Deliberately after everything above is wired: the probe is patient (a
   * single-page app mounts its chrome well after document_idle) and the panel
   * should be fully working by the time it answers, whichever way it answers.
   */
  async function checkPage() {
    const report = await awaitSupport();
    ui.setTeachable(report.ok, `Nothing on ${siteLabel()} I can point at`);
    if (report.ok) {
      ui.reset();
      return;
    }
    console.info('[browser-teacher] not teachable here:', report);
    ui.unsupported(report, { onRetry: checkPage });
  }
  checkPage();
}

/* ------------------------------------------------------------------ styles */

async function injectStyles(root) {
  const style = document.createElement('style');
  try {
    const res = await fetch(chrome.runtime.getURL('src/panel/panel.css'));
    style.textContent = await res.text();
  } catch (e) {
    console.error('[browser-teacher] panel.css failed to load', e);
  }
  root.appendChild(style);
}

/** Keep focus where it is. This is what stops a click dismissing a Docs menu. */
function noFocusSteal(el) {
  el.addEventListener('mousedown', e => e.preventDefault());
}

/* ---------------------------------------------------------------- UI facade */

/**
 * Everything machine.js is allowed to do to the UI. Passing this in rather than
 * importing the panel keeps the runner DOM-free and the imports acyclic.
 */
function createUI(els, raise, speech) {
  let resolveAction = null;
  let bar = null;
  // A page we can't teach stays unteachable after the user closes the notice.
  // Without this, reset() quietly re-arms the chat bar and every question
  // from then on fails to find anything, with no explanation on screen.
  let teachable = false;
  let lockReason = '';
  let spoken = '';   // what's currently on screen, for the toggle-on case

  const fire = value => {
    if (value === ACTION.QUIT) { ui.onCancel(); return; }
    const r = resolveAction;
    resolveAction = null;
    r?.(value);
  };

  function waitAction({ signal } = {}) {
    return new Promise((resolve, reject) => {
      const abort = () => finish(reject, new DOMException('Lesson cancelled', 'AbortError'));
      const finish = (settle, value) => {
        signal?.removeEventListener('abort', abort);
        if (resolveAction === answer) resolveAction = null;
        settle(value);
      };
      const answer = value => finish(resolve, value);
      resolveAction = answer;
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  function setOpen(open) {
    els.win.classList.toggle('is-open', open);
  }

  function renderActions(actions = []) {
    els.actions.replaceChildren();
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.subtle ? 'bt-btn bt-btn-subtle' : 'bt-btn';
      b.textContent = a.label;
      noFocusSteal(b);
      b.addEventListener('click', () => fire(a.value));
      els.actions.appendChild(b);
    }
  }

  function renderCard({ kind, mode, title, body }) {
    const card = document.createElement('div');
    card.className = `bt-card bt-card-${kind}${mode ? ` bt-mode-${mode}` : ''}`;
    if (title) {
      const h = document.createElement('h2');
      h.className = 'bt-card-title';
      h.textContent = title;
      card.appendChild(h);
    }
    const p = document.createElement('p');
    p.className = 'bt-card-body';
    p.textContent = body;
    card.appendChild(p);
    els.body.replaceChildren(card);

    // Each new card replaces what's being said. Without the implicit cancel in
    // say(), hints and steps would queue up and read minutes behind the screen.
    spoken = body;
    speech.say(body);
  }

  /** Hints and corrections append below the step, they don't replace it. */
  function appendNote(kind, text) {
    const existing = els.body.querySelector(`.bt-note-${kind}`);
    if (existing) { existing.textContent = text; return; }
    const note = document.createElement('p');
    note.className = `bt-note bt-note-${kind}`;
    note.textContent = text;
    els.body.appendChild(note);
    els.body.scrollTop = els.body.scrollHeight;
    spoken = text;
    speech.say(text);
  }

  const ui = {
    onPickLesson: () => {},
    onCancel: () => {},

    bindBar(b) { bar = b; },

    /** Re-read what's on screen — used when the toggle is switched on mid-lesson. */
    sayCurrent() { speech.say(spoken); },

    reset() {
      const pending = resolveAction;
      resolveAction = null;
      pending?.(ACTION.QUIT);
      speech.stop();
      spoken = '';
      setOpen(false);
      els.progress.hidden = true;
      els.body.replaceChildren();
      els.actions.replaceChildren();
      bar?.setEnabled(teachable, lockReason);
      window.__TEACH?.clear();
    },

    /** Set by the support probe; gates the chat bar from mount onwards. */
    setTeachable(value, reason = '') {
      teachable = Boolean(value);
      lockReason = teachable ? '' : reason;
      bar?.setEnabled(teachable, lockReason);
    },

    /**
     * A lesson that belongs to a different app.
     *
     * Should be unreachable — the picker only offers site-scoped lessons — so
     * if this ever shows, something upstream is serving the wrong library and
     * the message should make that obvious rather than blaming the user.
     */
    wrongApp(lesson) {
      raise();
      setOpen(true);
      const belongs = lessonSites(lesson).join(', ');
      renderCard({
        kind: 'unsupported',
        title: 'That lesson is for a different app',
        body: `"${lesson.goal}" was written for ${belongs}, and none of its steps exist on `
          + `${siteLabel()}. Nothing has been changed. If you are seeing this from the picker, `
          + 'reload the extension and hard-refresh this tab.',
      });
      renderActions([{ label: 'Close', value: ACTION.QUIT, subtle: true }]);
    },

    /**
     * A page with nothing we could ever point at.
     *
     * Shown once, at mount, instead of leaving a chat bar that accepts
     * questions and then silently fails to find anything for every one of
     * them. Naming the obstacle matters more than the refusal does: "this app
     * draws itself on a canvas" is something the user can act on, and
     * "unsupported site" is not.
     */
    unsupported(report, { onRetry } = {}) {
      raise();
      setOpen(true);
      bar?.setEnabled(false, lockReason);
      els.progress.hidden = true;
      renderCard({
        kind: 'unsupported',
        title: "I can't teach this page",
        body: explain(report, siteLabel()),
      });
      els.actions.replaceChildren();
      // Not renderActions(): every button it makes goes through fire(), and
      // this one re-probes rather than answering a step that isn't running.
      // An app that was still booting is the likeliest reason to be here.
      if (onRetry) {
        const again = document.createElement('button');
        again.type = 'button';
        again.className = 'bt-btn bt-btn-subtle';
        again.textContent = 'Check again';
        noFocusSteal(again);
        again.addEventListener('click', onRetry);
        els.actions.appendChild(again);
      }
    },

    /**
     * Where every question lands. Ask rather than assume — see start().
     *
     * `matches` is only the lessons the question actually earned, so it is
     * frequently empty — a question about something we don't teach gets no
     * choices at all, not the library in ranked order. A list of six unrelated
     * lessons under "which did you mean?" is a worse answer than admitting we
     * don't know it, and it buries the one control that can actually help.
     *
     * "None of these" therefore comes last, after whatever we did match: the
     * user rules the guesses out, then spends the cloud browser.
     */
    async showPicker(question, matches, { signal, confident, onGenerate } = {}) {
      raise();
      setOpen(true);
      const lessons = await loadHere();
      if (signal?.aborted) return;
      // Best guesses only. Once C's batch runs there could be fifty lessons,
      // and a wall of buttons is a worse answer than four good ones.
      const found = (matches ?? []).slice(0, PICKER_LIMIT).map(m => m.id);
      // Nothing matched and no bridge to go and learn it: a picker with no
      // buttons is a dead end, so fall back to showing what we do teach.
      const browsing = !found.length && !onGenerate;
      // Belt and braces: `lessons` is already scoped to this site, so anything
      // ranked that is not in it belongs to a different app and must not be
      // offered. The ranking is built from the same scoped list, so this should
      // never drop anything — but a lesson for the wrong app appearing in the
      // picker is the single most confusing thing this panel can do, and the
      // check costs nothing.
      const here = new Set(lessons.map(l => l.id));
      const offered = found.filter(id => here.has(id));
      if (offered.length !== found.length) {
        console.warn('[browser-teacher] dropped lessons ranked for another app:',
          found.filter(id => !here.has(id)));
      }
      const order = browsing ? lessons.slice(0, PICKER_LIMIT).map(l => l.id) : offered;

      renderCard({
        kind: 'picker',
        title: pickerTitle(order.length),
        // A site we have no lessons for at all is a different answer from a
        // question we didn't recognise, and saying "here's what I do teach"
        // over an empty list is the worst of both.
        body: pickerBody(question, order.length, Boolean(onGenerate), confident, lessons.length),
      });
      els.actions.replaceChildren();

      for (const id of order) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bt-btn';
        b.textContent = lessons.find(l => l.id === id)?.goal || id;
        noFocusSteal(b);
        b.addEventListener('click', () => ui.onPickLesson(id));
        els.actions.appendChild(b);
      }

      // Last, under the guesses it is offered instead of. Subtle only when
      // there are guesses — with none, it is the only thing to do here.
      if (onGenerate) {
        const b = document.createElement('button');
        b.type = 'button';
        // Its own class: this is not one of the published lessons, and anything
        // counting the choices on offer must be able to tell the difference.
        b.className = order.length ? 'bt-btn bt-btn-generate bt-btn-subtle' : 'bt-btn bt-btn-generate';
        b.textContent = order.length ? 'None of these' : 'Work it out for me';
        noFocusSteal(b);
        b.addEventListener('click', () => onGenerate());
        els.actions.appendChild(b);
      }

      // Reachable on a site we have no lessons for with no bridge running:
      // nothing matched, there is nothing to browse, and nothing to generate.
      // A card with no buttons reads as a hang, so give the dead end a door.
      if (!els.actions.children.length) {
        renderActions([{ label: 'Close', value: ACTION.QUIT, subtle: true }]);
      }
    },

    /**
     * A cloud browser is off learning this. Minutes, not seconds — so show the
     * agent's own reasoning as it goes. A narrated wait reads as the product
     * working; the same wait behind a spinner reads as a hang.
     */
    generating(question) {
      raise();
      bar?.setEnabled(false);
      setOpen(true);
      els.progress.hidden = true;
      renderCard({
        kind: 'loading',
        title: 'Working it out',
        body: `I don't have a lesson for "${question}", so I'm opening a cloud browser and finding out. This takes a minute or two.`,
      });
      renderActions([{ label: 'Stop', value: ACTION.QUIT, subtle: true }]);
    },

    /** One line of the agent's trail. Deliberately not spoken — it would never stop talking. */
    generatingNote(text) {
      let trail = els.body.querySelector('.bt-trail');
      if (!trail) {
        trail = document.createElement('ol');
        trail.className = 'bt-trail';
        els.body.appendChild(trail);
      }
      const li = document.createElement('li');
      li.textContent = text;
      trail.appendChild(li);
      // Older lines stop being interesting once they scroll; keep the tail.
      while (trail.children.length > 6) trail.removeChild(trail.firstElementChild);
      els.body.scrollTop = els.body.scrollHeight;
    },

    lessonStarted() {
      raise();          // stay above D's scrim
      bar?.setEnabled(false);
      setOpen(true);
    },

    loading() {
      raise();
      bar?.setEnabled(false);
      setOpen(true);
      renderCard({ kind: 'loading', title: 'Browser Teacher', body: 'Preparing your lesson…' });
      renderActions([{ label: 'Stop', value: ACTION.QUIT, subtle: true }]);
    },

    lessonEnded() { ui.reset(); },

    /** A card that waits for one of its own buttons. */
    card({ kind, title, body, actions }, options) {
      renderCard({ kind, title, body });
      renderActions(actions);
      return waitAction(options);
    },

    step(step, index, total) {
      els.progress.hidden = false;
      els.progress.textContent = `${index + 1} / ${total}`;
      renderCard({ kind: 'step', mode: step.mode, title: modeLabel(step.mode), body: step.intent });
      renderActions([
        { label: 'Show me where', value: ACTION.DEMO_REST, subtle: true },
        { label: 'Stop', value: ACTION.QUIT, subtle: true },
      ]);
    },

    /** Actions with no new card — used by instruct-only steps. */
    setActions: renderActions,

    actions(list, options) {
      renderActions(list);
      return waitAction(options);
    },

    hint(text) { appendNote('hint', text); },
    wrong(text) { appendNote('wrong', text); },

    /** Something threw. Show it rather than dying quietly behind the page. */
    fail(err) {
      raise();
      setOpen(true);
      els.progress.hidden = true;
      renderCard({
        kind: 'error',
        title: 'That broke',
        body: err?.message || String(err),
      });
      renderActions([{ label: 'Close', value: ACTION.QUIT }]);
      resolveAction = () => ui.reset();
    },

    /** Resolves when a footer button is pressed. Raced against waitForClick. */
    pendingAction: waitAction,
  };

  return ui;
}

function pickerTitle(found) {
  if (!found) return "I don't know that one yet";
  return found === 1 ? 'Is this the one?' : 'Is it one of these?';
}

/**
 * Picker copy. Saying the wrong one here is how the panel loses the user:
 * hedging over a strong match reads as incompetence, and sounding certain over
 * three weak ones reads as a lie.
 */
function pickerBody(question, found, canGenerate, confident, known = 1) {
  if (!question) return 'Which would you like?';
  const escape = canGenerate ? " Or say none of these and I'll go and work it out." : '';
  if (!found) {
    // No lessons for this site at all. Blaming the question would be a lie,
    // and offering "here's what I do teach" over an empty library is worse.
    if (!known) {
      return canGenerate
        ? `I don't have any lessons for ${siteLabel()} yet. I can open a cloud browser and work this one out.`
        : `I don't have any lessons for ${siteLabel()} yet, and there's no authoring bridge running to build one.`;
    }
    return canGenerate
      ? `I have no lesson for "${question}". I can open a cloud browser and work it out.`
      : `I have no lesson for "${question}". Here's what I do teach.`;
  }
  if (confident) {
    return found === 1
      ? `This looks like what you meant by "${question}".${escape}`
      : `One of these looks like what you meant by "${question}".${escape}`;
  }
  return `I'm not certain what you meant by "${question}" — pick the closest.${escape}`;
}

function modeLabel(mode) {
  if (mode === 'demo') return 'Follow the guide';
  if (mode === 'solo') return 'Your turn — no hints';
  return 'Your turn';
}
