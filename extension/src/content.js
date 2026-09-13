// [B] entry point — a plain classic content script whose only job is to pull
// the real module graph into the content script's isolated world.
//
// Content scripts start as classic scripts. Dynamic import loads the module
// graph; the manifest exposes those module resources on the supported sites.
//
// The frozen import order lives in src/main.js — same four lines, same order,
// just one level further in.
import(chrome.runtime.getURL('src/main.js')).catch(err => {
  console.error('[browser-teacher] failed to load', err);
});
