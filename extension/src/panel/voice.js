// [B] Push-to-talk via the Web Speech API.
//
// Additive by design. Typing is the primary path and must work with the mic
// blocked, the API missing, or the wifi dead — Web Speech ships audio to
// Google's servers, and conference wifi is on the risk register (PLAN.md §15).
// If anything here throws, the panel falls back to the text input.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const supported = Boolean(Recognition);

/**
 * @param {object} handlers
 * @param {(text: string) => void} handlers.onInterim  live text while held
 * @param {(text: string) => void} handlers.onFinal    final transcript on release
 * @param {(msg: string)  => void} handlers.onError    human-readable failure
 */
export function createVoice({ onInterim, onFinal, onError }) {
  if (!supported) {
    return { supported: false, start() {}, stop() {} };
  }

  let recognition = null;
  let transcript = '';
  let listening = false;

  function start() {
    if (listening) return;
    listening = true;
    transcript = '';

    recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = e => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      transcript = text.trim();
      onInterim?.(transcript);
    };

    recognition.onerror = e => {
      listening = false;
      onError?.(errorMessage(e.error));
    };

    recognition.onend = () => {
      if (!listening) return;
      listening = false;
      if (transcript) onFinal?.(transcript);
      else onError?.("Didn't catch that — type it instead.");
    };

    try {
      recognition.start();
    } catch {
      listening = false;
      onError?.("Couldn't start the mic — type it instead.");
    }
  }

  function stop() {
    if (!listening || !recognition) return;
    // Don't clear `listening` here — onend does the handoff to onFinal.
    try {
      recognition.stop();
    } catch {
      listening = false;
    }
  }

  return { supported: true, start, stop, get listening() { return listening; } };
}

function errorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Mic access is blocked for docs.google.com — type your question instead.';
    case 'network':
      return 'No network for speech recognition — type it instead.';
    case 'no-speech':
      return "Didn't hear anything — hold and speak, or type it instead.";
    default:
      return 'Speech recognition failed — type it instead.';
  }
}
