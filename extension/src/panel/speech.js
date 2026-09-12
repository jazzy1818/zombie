// [B] Reading the narration aloud. Off by default, toggled from the window
// header, remembered between sessions.
//
// Worth having rather than decoration: the premise of the product is that the
// user is looking at the Doc, not at us. Spoken narration lets them watch the
// highlighted control while they listen, instead of reading a card and then
// hunting back up to the toolbar.
//
// speechSynthesis is built into the browser — no dependency, no key, and the
// common voices are local so it works with the wifi down. Unlike recognition,
// which isn't.

const KEY = 'browser-teacher:voice';

export const supported = typeof window.speechSynthesis !== 'undefined'
  && typeof window.SpeechSynthesisUtterance !== 'undefined';

export function createSpeech() {
  if (!supported) {
    return { supported: false, enabled: false, toggle: () => false, say() {}, stop() {} };
  }

  const synth = window.speechSynthesis;
  let enabled = false;
  try {
    enabled = localStorage.getItem(KEY) === 'on';
  } catch {
    // Docs runs with storage available, but never let a preference break the panel.
  }

  // getVoices() is empty until the engine has loaded them, and the event may
  // have fired before we got here — so resolve it both ways.
  let voice = null;
  const pickVoice = () => {
    const voices = synth.getVoices();
    if (!voices.length) return;
    voice =
      voices.find(v => v.lang === 'en-US' && v.localService) ||
      voices.find(v => v.lang?.startsWith('en') && v.localService) ||
      voices.find(v => v.lang?.startsWith('en')) ||
      voices[0];
  };
  pickVoice();
  synth.addEventListener?.('voiceschanged', pickVoice);

  function stop() {
    try { synth.cancel(); } catch { /* nothing to cancel */ }
  }

  /**
   * Speak text, replacing whatever was being said. Never blocks — a step must
   * accept the user's click the instant they're ready, not when we stop talking.
   */
  function say(text) {
    if (!enabled || !text) return;
    stop();
    try {
      const u = new SpeechSynthesisUtterance(String(text));
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'en-US';
      u.rate = 0.97;    // a shade under default; this is teaching, not reading out a list
      u.pitch = 1;
      synth.speak(u);
    } catch (e) {
      console.warn('[browser-teacher] speech failed', e);
    }
  }

  return {
    supported: true,
    get enabled() { return enabled; },
    toggle(on = !enabled) {
      enabled = on;
      try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* preference only */ }
      if (!on) stop();
      return enabled;
    },
    say,
    stop,
  };
}
