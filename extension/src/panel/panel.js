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
import { loadLesson, loadAll, matchLesson, listLessons } from './lessons.js';
import { runLesson, ACTION } from './machine.js';
import { createSpeech } from './speech.js';
import { installDev } from './dev.js';

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

  // OVERLAY_Z is INT_MAX, so we can't outrank D's scrim by z-index alone —
  // and since this window moves, D can't cut a hole for it either. Matching
  // their z-index and being later in the DOM wins the tie, which keeps the
  // narration readable while the page behind it is dimmed. raise() re-asserts
  // it when a lesson starts, in case D mounted their host lazily after us.
  host.style.setProperty('--bt-z', String(OVERLAY_Z));
  const raise = () => document.documentElement.appendChild(host);

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

  const bar = mountBar(root, {
    onPrompt: start,
    // Stop talking the moment they start — otherwise the mic hears us.
    onListenStart: () => speech.stop(),
  });
  ui.bindBar(bar);

  noFocusSteal(els.close);
  els.close.addEventListener('click', () => ui.reset());

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
  async function play(id, opts) {
    try {
      await runLesson(await loadLesson(id), ui, opts);
    } catch (err) {
      console.error('[browser-teacher]', err);
      ui.fail(err);
    }
  }

  async function start(question) {
    try {
      const { id, confident, ranked } = await matchLesson(question);
      if (!confident) return ui.showPicker(question, ranked);
      await play(id);
    } catch (err) {
      console.error('[browser-teacher]', err);
      ui.fail(err);
    }
  }

  ui.onPickLesson = id => play(id);

  // Rehearsal: skip straight to the step you're practising.
  //   __BT_DEV.run('styles-toc', 3)
  if (window.__BT_DEV) {
    window.__BT_DEV.run = (id = 'styles-toc', step = 1) => play(id, { from: Math.max(0, step - 1) });
    window.__BT_DEV.lessons = () => listLessons();
  }

  ui.reset();
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
  let spoken = '';   // what's currently on screen, for the toggle-on case

  const fire = value => {
    const r = resolveAction;
    resolveAction = null;
    r?.(value);
  };

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

    bindBar(b) { bar = b; },

    /** Re-read what's on screen — used when the toggle is switched on mid-lesson. */
    sayCurrent() { speech.say(spoken); },

    reset() {
      resolveAction = null;
      speech.stop();
      spoken = '';
      setOpen(false);
      els.progress.hidden = true;
      els.body.replaceChildren();
      els.actions.replaceChildren();
      bar?.setEnabled(true);
      window.__TEACH?.clear();
    },

    /** Matcher wasn't confident. Ask rather than confidently teach the wrong thing. */
    async showPicker(question, ranked) {
      raise();
      setOpen(true);
      const lessons = await loadAll();
      // Best guess first — we weren't confident enough to commit, but we're not
      // clueless either, and the ordering is free.
      // Best guesses only. Once C's batch runs there could be fifty lessons,
      // and a wall of buttons is a worse answer than four good ones.
      const order = (ranked?.length ? ranked.map(r => r.id) : lessons.map(l => l.id))
        .slice(0, PICKER_LIMIT);
      renderCard({
        kind: 'picker',
        title: 'I know two things so far',
        body: question
          ? `I'm not sure "${question}" is either of these — which did you mean?`
          : 'Which would you like?',
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
    },

    lessonStarted() {
      raise();          // stay above D's scrim
      bar?.setEnabled(false);
      setOpen(true);
    },

    lessonEnded() { ui.reset(); },

    /** A card that waits for one of its own buttons. */
    card({ kind, title, body, actions }) {
      renderCard({ kind, title, body });
      renderActions(actions);
      return new Promise(res => { resolveAction = res; });
    },

    step(step, index, total) {
      els.progress.hidden = false;
      els.progress.textContent = `${index + 1} / ${total}`;
      renderCard({ kind: 'step', mode: step.mode, title: modeLabel(step.mode), body: step.intent });
      renderActions([
        { label: 'Just do it for me', value: ACTION.DEMO_REST, subtle: true },
        { label: 'Stop', value: ACTION.QUIT, subtle: true },
      ]);
    },

    /** Actions with no new card — used by instruct-only steps. */
    actions(list) {
      renderActions(list);
      return new Promise(res => { resolveAction = res; });
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
    pendingAction() {
      return new Promise(res => { resolveAction = res; });
    },
  };

  return ui;
}

function modeLabel(mode) {
  if (mode === 'demo') return 'Watch';
  if (mode === 'solo') return 'Your turn — no hints';
  return 'Your turn';
}
