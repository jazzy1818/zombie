// [B] entry point — a plain classic content script whose only job is to pull
// the real module graph into the content script's isolated world.
//
// Why not `"type": "module"` in the manifest: Chrome only honours that from
// 111+, and where it is honoured it additionally demands that every statically
// imported file be web-accessible. A dynamic import from a classic script needs
// neither, so this works on any Chrome we're likely to meet on a demo laptop.
//
// The frozen import order lives in src/main.js — same four lines, same order,
// just one level further in.
import(chrome.runtime.getURL('src/main.js')).catch(err => {
  console.error('[browser-teacher] failed to load', err);
});
