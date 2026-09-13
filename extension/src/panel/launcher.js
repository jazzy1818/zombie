// [B] The chat bar: a translucent input pinned to the bottom of the screen, and
// hold-Option to speak instead of type. Both funnel into one onPrompt(text) —
// there is one entry into the runner, not two.
//
// Option/Alt specifically, NOT spacebar: Docs types into the canvas, so a held
// spacebar fills the document with spaces unless we swallow the keystroke
// perfectly. Option types nothing.
import { createVoice, supported as voiceSupported } from './voice.js';

const PTT_KEY = 'Alt';

/**
 * @param {ShadowRoot} root
 * @param {object} handlers
 * @param {(text: string) => void} handlers.onPrompt  a question arrived, either path
 */
export function mountBar(root, { onPrompt, onListenStart }) {
  const bar = document.createElement('form');
  bar.className = 'bt-bar';
  bar.innerHTML = `
    <input class="bt-bar-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="Ask how to do something…">
    <button class="bt-bar-mic" type="button" title="Hold Option and speak" aria-label="Hold to speak">
      <span class="bt-mic-dot"></span>
    </button>
    <button class="bt-bar-go" type="submit">Teach me</button>
  `;
  root.appendChild(bar);

  const input = bar.querySelector('.bt-bar-input');
  const mic = bar.querySelector('.bt-bar-mic');
  const go = bar.querySelector('.bt-bar-go');

  if (!voiceSupported) mic.hidden = true;

  let enabled = true;
  let listening = false;
  let restore = '';

  const voice = createVoice({
    onInterim: text => { input.value = text; },
    onFinal: text => {
      setListening(false);
      input.value = '';
      onPrompt(text);
    },
    onError: msg => {
      setListening(false);
      input.value = restore;
      flash(msg);
    },
  });

  function setListening(on) {
    listening = on;
    bar.classList.toggle('is-listening', on);
    input.placeholder = on ? 'Listening…' : 'Ask how to do something…';
  }

  function flash(msg) {
    bar.classList.add('is-error');
    input.placeholder = msg;
    setTimeout(() => {
      bar.classList.remove('is-error');
      input.placeholder = 'Ask how to do something…';
    }, 4000);
  }

  function startListening() {
    if (!enabled || listening || !voice.supported) return;
    onListenStart?.();   // stop reading aloud, or the mic transcribes our own voice
    restore = input.value;
    input.value = '';
    setListening(true);
    voice.start();
  }

  function stopListening() {
    if (!listening) return;
    voice.stop();
  }

  function submit() {
    const q = input.value.trim();
    if (!enabled || !q) return;
    input.value = '';
    onPrompt(q);
  }

  bar.addEventListener('submit', e => { e.preventDefault(); submit(); });

  // The bar's buttons must never take focus off the document — clicking one
  // while a Docs menu is open would dismiss the menu the lesson is pointing at.
  for (const el of [mic, go]) {
    el.addEventListener('mousedown', e => e.preventDefault());
  }

  // Press-and-hold the mic is the mouse equivalent of holding Option.
  let holdTimer = null;
  mic.addEventListener('pointerdown', e => {
    e.preventDefault();
    holdTimer = setTimeout(startListening, 250);
  });
  const endHold = () => { clearTimeout(holdTimer); stopListening(); };
  mic.addEventListener('pointerup', endHold);
  mic.addEventListener('pointerleave', endHold);

  // --- hold Option to talk -------------------------------------------------
  const onKeyDown = e => {
    if (e.key !== PTT_KEY || e.repeat) return;
    startListening();
  };
  const onKeyUp = e => {
    if (e.key !== PTT_KEY) return;
    stopListening();
  };
  // Without this a lost window focus mid-hold leaves the mic open forever.
  const onBlur = () => stopListening();

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  return {
    /**
     * Locked while a lesson runs. The bar stays visible — it reads better than
     * vanishing — but the input is disabled so it can't be focused mid-step,
     * and a stray Option can't restart anything.
     */
    /**
     * @param {boolean} v
     * @param {string} [reason]  why it's locked, shown in place of the prompt.
     *                           A bar that just stops accepting input reads as
     *                           broken; one that says why reads as deliberate.
     */
    setEnabled(v, reason = '') {
      enabled = v;
      input.disabled = !v;
      bar.classList.toggle('is-locked', !v);
      // A bar locked mid-lesson should fade into the background; one locked
      // because the page can't be taught is carrying the only explanation
      // left on screen once the notice is closed, so keep it readable.
      bar.classList.toggle('is-explained', !v && Boolean(reason));
      input.placeholder = v || !reason ? 'Ask how to do something…' : reason;
      if (!v) stopListening();
    },
    focus() { if (enabled) input.focus(); },
    voiceSupported: voice.supported,
  };
}
