// [B] The two ways in: a floating icon you click to type, and hold-Option to
// speak. Both funnel into exactly one onPrompt(text) — there is one entry into
// the runner, not two.
//
// Option/Alt specifically, NOT spacebar: Docs types into the canvas, so a held
// spacebar fills the document with spaces unless we swallow the keystroke
// perfectly. Option types nothing.
import { createVoice, supported as voiceSupported } from './voice.js';

const PTT_KEY = 'Alt';

/**
 * @param {ShadowRoot} root     the panel's shadow root (shared, so one stylesheet)
 * @param {object} handlers
 * @param {() => void}            handlers.onOpen    icon clicked — open the ask card
 * @param {(text: string) => void} handlers.onPrompt  a question arrived, from either path
 * @param {(text: string) => void} handlers.onInterim live speech, for display
 * @param {(msg: string)  => void} handlers.onError
 */
export function mountLauncher(root, { onOpen, onPrompt, onInterim, onError }) {
  const button = document.createElement('button');
  button.className = 'bt-launcher';
  button.type = 'button';
  button.title = voiceSupported
    ? 'Ask a question — or hold Option and speak'
    : 'Ask a question';
  button.innerHTML = `<span class="bt-launcher-glyph">?</span>`;
  root.appendChild(button);

  const voice = createVoice({
    onInterim,
    onFinal: text => {
      setListening(false);
      onPrompt(text);
    },
    onError: msg => {
      setListening(false);
      onError(msg);
    },
  });

  let enabled = true;
  let listening = false;

  function setListening(on) {
    listening = on;
    button.classList.toggle('is-listening', on);
  }

  function startListening() {
    if (!enabled || listening || !voice.supported) return;
    setListening(true);
    onOpen();
    voice.start();
  }

  function stopListening() {
    if (!listening) return;
    voice.stop();
  }

  // --- click to type -------------------------------------------------------
  button.addEventListener('click', () => {
    if (!enabled || listening) return;
    onOpen();
  });

  // Press-and-hold the icon does the same as holding Option — free mouse
  // equivalent for anyone who doesn't want a hand on the keyboard.
  let holdTimer = null;
  button.addEventListener('mousedown', e => {
    e.preventDefault();   // never take focus off the document — see panel.js
    if (!voice.supported) return;
    holdTimer = setTimeout(startListening, 300);
  });
  const endHold = () => {
    clearTimeout(holdTimer);
    stopListening();
  };
  button.addEventListener('mouseup', endHold);
  button.addEventListener('mouseleave', endHold);

  // --- hold Option to talk -------------------------------------------------
  // Capture phase so we see it before Docs does, though Option alone types
  // nothing so there is nothing to suppress.
  const onKeyDown = e => {
    if (e.key !== PTT_KEY || e.repeat) return;
    startListening();
  };
  const onKeyUp = e => {
    if (e.key !== PTT_KEY) return;
    stopListening();
  };
  // If the window loses focus mid-hold we'd never see keyup, and the mic would
  // stay open with no way to close it.
  const onBlur = () => stopListening();

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  return {
    /** Disabled while a lesson runs — a stray Option must not restart anything. */
    setEnabled(v) {
      enabled = v;
      button.classList.toggle('is-hidden', !v);
      if (!v) stopListening();
    },
    voiceSupported: voice.supported,
    destroy() {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      button.remove();
    },
  };
}
