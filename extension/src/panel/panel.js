// [B] The side panel: shadow host, cards, and the wiring between the entry UI
// and the lesson runner.
//
// Injected into the page, NOT a browser popup — a popup closes the moment the
// user clicks the document, which is every single step of every lesson.
//
// FOCUS DISCIPLINE (PLAN.md §15, B's responsibility): Docs menus dismiss on
// blur. Every control in here suppresses mousedown so clicking it never moves
// focus, and the only .focus() call in this file fires in the idle `ask` state,
// when no lesson is running and no menu can be open.
import { PANEL_WIDTH, PANEL_SIDE } from '../constants.js';
import { mountLauncher } from './launcher.js';
import { loadLesson, loadAll, matchLesson, LESSONS } from './lessons.js';
import { runLesson, ACTION } from './machine.js';
import { installDev } from './dev.js';

const HOST_ID = 'browser-teacher-root';

export async function mountPanel() {
  if (document.getElementById(HOST_ID)) return;   // idempotent

  installDev();   // inert until you call __BT_DEV.<scenario>() from the console

  const host = document.createElement('div');
  host.id = HOST_ID;
  // NOTE for [A]: clicks inside this host are panel UI, not the user answering
  // a step. waitForClick() should ignore any event whose composedPath()
  // includes #browser-teacher-root.
  host.setAttribute('data-browser-teacher', 'ui');
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  await injectStyles(root);

  // constants.js stays the single source of truth for geometry — panel.css
  // reads these rather than hardcoding the same numbers a second time.
  const onRight = PANEL_SIDE === 'right';
  host.style.setProperty('--bt-width', `${PANEL_WIDTH}px`);
  host.style.setProperty('--bt-start', onRight ? 'auto' : '0');
  host.style.setProperty('--bt-end', onRight ? '0' : 'auto');
  host.style.setProperty('--bt-hidden-x', onRight ? '100%' : '-100%');

  const panel = document.createElement('aside');
  panel.className = 'bt-panel';
  panel.innerHTML = `
    <header class="bt-head">
      <span class="bt-title">Browser Teacher</span>
      <span class="bt-progress" hidden></span>
      <button class="bt-close" type="button" title="Close">×</button>
    </header>
    <div class="bt-body"></div>
    <footer class="bt-actions"></footer>
  `;
  root.appendChild(panel);

  const els = {
    panel,
    body: panel.querySelector('.bt-body'),
    actions: panel.querySelector('.bt-actions'),
    progress: panel.querySelector('.bt-progress'),
    close: panel.querySelector('.bt-close'),
  };

  const ui = createUI(els);

  const launcher = mountLauncher(root, {
    onOpen: () => ui.showAsk(),
    onPrompt: text => start(text),
    onInterim: text => ui.showAsk(text, { listening: true }),
    onError: msg => ui.showAsk('', { error: msg }),
  });

  ui.bindLauncher(launcher);
  noFocusSteal(els.close);
  els.close.addEventListener('click', () => ui.reset());

  async function start(question) {
    const { id, confident } = matchLesson(question);
    if (!confident) return ui.showPicker(question);
    ui.setOpen(true);
    await runLesson(await loadLesson(id), ui);
  }

  ui.onPickLesson = async id => {
    ui.setOpen(true);
    await runLesson(await loadLesson(id), ui);
  };
  ui.onSubmitQuestion = start;

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

/** Keep focus where it is. This is what stops a panel click dismissing a Docs menu. */
function noFocusSteal(el) {
  el.addEventListener('mousedown', e => e.preventDefault());
}

/* ---------------------------------------------------------------- UI facade */

/**
 * Everything machine.js is allowed to do to the panel. Passing this in rather
 * than importing the panel keeps the runner DOM-free and the imports acyclic.
 */
function createUI(els) {
  let resolveAction = null;
  let launcher = null;

  /** Resolve whatever the runner is currently awaiting. */
  const fire = value => {
    const r = resolveAction;
    resolveAction = null;
    r?.(value);
  };

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
    return card;
  }

  /** Hints and corrections append below the step, they don't replace it. */
  function appendNote(kind, text) {
    const existing = els.body.querySelector(`.bt-note-${kind}`);
    if (existing) {
      existing.textContent = text;
      return;
    }
    const note = document.createElement('p');
    note.className = `bt-note bt-note-${kind}`;
    note.textContent = text;
    els.body.appendChild(note);
  }

  const ui = {
    onPickLesson: () => {},
    onSubmitQuestion: () => {},

    bindLauncher(l) { launcher = l; },

    setOpen(open) {
      els.panel.classList.toggle('is-open', open);
    },

    reset() {
      resolveAction = null;
      ui.setOpen(false);
      els.progress.hidden = true;
      els.body.replaceChildren();
      els.actions.replaceChildren();
      launcher?.setEnabled(true);
      window.__TEACH?.clear();
    },

    /** Idle state: the question box. The only place anything gets focused. */
    showAsk(value = '', { listening = false, error = '' } = {}) {
      ui.setOpen(true);
      els.progress.hidden = true;

      const card = document.createElement('div');
      card.className = 'bt-card bt-card-ask';
      card.innerHTML = `
        <h2 class="bt-card-title">What do you want to do?</h2>
        <textarea class="bt-input" rows="3" placeholder="how do I add a table of contents?"></textarea>
        <p class="bt-ask-foot"></p>
      `;
      const input = card.querySelector('.bt-input');
      const foot = card.querySelector('.bt-ask-foot');

      input.value = value;
      card.classList.toggle('is-listening', listening);
      foot.textContent = error
        ? error
        : listening
          ? 'Listening… release Option to send'
          : launcher?.voiceSupported
            ? 'Type it, or hold Option and just say it'
            : 'Type it and press Enter';
      foot.classList.toggle('is-error', Boolean(error));

      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        const q = input.value.trim();
        if (q) ui.onSubmitQuestion(q);
      });

      els.body.replaceChildren(card);
      renderActions([]);

      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'bt-btn';
      submit.textContent = 'Teach me';
      noFocusSteal(submit);
      submit.addEventListener('click', () => {
        const q = input.value.trim();
        if (q) ui.onSubmitQuestion(q);
      });
      els.actions.appendChild(submit);

      // Safe: idle state, no lesson running, no Docs menu open.
      if (!listening) input.focus();
    },

    /** Matcher wasn't confident. Ask rather than confidently teach the wrong thing. */
    async showPicker(question) {
      ui.setOpen(true);
      const lessons = await loadAll();
      renderCard({
        kind: 'picker',
        title: "I know two things so far",
        body: question
          ? `I'm not sure "${question}" is either of these — which did you mean?`
          : 'Which would you like?',
      });
      els.actions.replaceChildren();
      for (const { id } of LESSONS) {
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
      launcher?.setEnabled(false);
      ui.setOpen(true);
    },

    lessonEnded() {
      ui.reset();
    },

    /** A card that waits for one of its own buttons. */
    card({ kind, title, body, actions }) {
      renderCard({ kind, title, body });
      renderActions(actions);
      return new Promise(res => { resolveAction = res; });
    },

    /** Render a step. Always leaves an escape hatch in the footer. */
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

    /** Resolves when the user presses a footer button. Raced against waitForClick. */
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
