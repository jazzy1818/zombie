// SHARED — Contract 4, window.__TEACH. PLAN.md §6.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │  THIS FILE IS A STUB. At CHECKPOINT 1, A and D sit down together and     │
// │  replace the body below with the reference implementation in PLAN.md §6. │
// │  It is the only file two people touch, and it is touched exactly once.   │
// │  Until then this stub lets B build the panel against fake successes.     │
// └──────────────────────────────────────────────────────────────────────────┘

const sleep = ms => new Promise(r => setTimeout(r, ms));

window.__TEACH = {
  highlight: async t => (console.log('HL', t), true),
  clear: () => console.log('CLEAR'),
  moveCursor: async t => console.log('CURSOR', t),
  demo: async t => (console.log('DEMO', t), await sleep(800)),
  waitForClick: async t => (await sleep(1500), 'correct'),
  verify: async v => true,
  flashCorrect: () => console.log('OK'),
  setCursorVisible: v => console.log('CURSORVIS', v),
};
