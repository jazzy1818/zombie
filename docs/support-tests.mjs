// Can this page be taught? — the classification behind the panel's refusal.
//
// Runs against a hand-built fake DOM rather than a browser, because the thing
// under test is a decision, not a rendering: given a page shaped like Figma,
// like an iframe wrapper, like an icon-only toolbar, does the panel refuse it
// and does it name the right obstacle? None of that needs Chromium, and a
// suite that needs Chromium is a suite nobody runs.
//
// The visual half — that the card appears, reads well and locks the chat bar —
// is checked by hand against docs/unsupported-fixture.html.
//
//   node docs/support-tests.mjs

import assert from 'node:assert/strict';

/* --------------------------------------------------------- a fake document */

const VIEWPORT = { width: 1440, height: 900 };

function el(localName, attrs = {}, children = []) {
  const { text = '', width = 80, height = 30, role, ...rest } = attrs;
  const node = {
    nodeType: 1,
    localName,
    isConnected: true,
    children,
    parentElement: null,
    shadowRoot: null,
    inert: false,
    attrs: { ...rest, ...(role ? { role } : {}) },
    textContent: text,
    innerText: text,
    getAttribute: name => node.attrs[name] ?? null,
    hasAttribute: name => node.attrs[name] !== undefined,
    getRootNode: () => document,
    checkVisibility: () => width > 0 && height > 0,
    getBoundingClientRect: () => ({ width, height }),
    matches: selector => selectorMatches(node, selector),
    scrollIntoView() {},
  };
  node.ownerDocument = document;
  for (const child of children) child.parentElement = node;
  return node;
}

/**
 * Enough CSS selector support for CONTROL and the probe's own queries, and no
 * more. Deliberately dumb: if it ever needs to grow much past this, the test
 * belongs in the Playwright suite instead.
 */
function selectorMatches(node, selector) {
  return selector.split(',').map(s => s.trim()).some(part => {
    if (part === '*') return true;
    const attr = part.match(/^\[([\w-]+)\]$/);
    if (attr) return node.hasAttribute(attr[1]);
    const tagAttr = part.match(/^(\w+)\[([\w-]+)\]$/);
    if (tagAttr) return node.localName === tagAttr[1] && node.hasAttribute(tagAttr[2]);
    if (part === 'input:not([type="hidden"])') return node.localName === 'input' && node.getAttribute('type') !== 'hidden';
    return node.localName === part;
  });
}

const document = {
  nodeType: 9,
  children: [],
  getElementById: () => null,
  querySelectorAll(selector) {
    const out = [];
    (function visit(container) {
      for (const child of container.children || []) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    })(document);
    return out;
  },
};
document.ownerDocument = document;
document.defaultView = { innerWidth: VIEWPORT.width, innerHeight: VIEWPORT.height };

globalThis.document = document;
globalThis.window = document.defaultView;
globalThis.location = { href: 'https://example.test/app' };

// probeSupport bails on a document with no body, and queryDeep walks down from
// the document, so the page has to hang off a real body like the live one does.
const body = el('body', { width: VIEWPORT.width, height: VIEWPORT.height });
document.children = [body];
document.body = body;

const setPage = nodes => {
  body.children = nodes;
  for (const node of nodes) node.parentElement = body;
};

/* ------------------------------------------------------------------- cases */

const { probeSupport, REASON, explain } = await import('../extension/src/panel/support.js');

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const namedButtons = n => Array.from({ length: n }, (_, i) =>
  el('button', { 'aria-label': `Action ${i + 1}` }));

console.log('a teachable page');
test('an ordinary app is supported', () => {
  setPage([el('div', {}, namedButtons(20))]);
  const report = probeSupport();
  assert.equal(report.ok, true);
  assert.equal(report.reason, REASON.OK);
  assert.equal(report.controls, 20);
});
test('distinct names are what count, not element count', () => {
  // Twelve buttons, three names. A lesson can only ask for a name, so the
  // page is thinner than its markup suggests — and below the bar.
  setPage([el('div', {}, Array.from({ length: 12 }, (_, i) =>
    el('button', { 'aria-label': `Action ${i % 3}` })))]);
  assert.equal(probeSupport().controls, 3);
});
test('six named controls is enough', () => {
  setPage([el('div', {}, namedButtons(6))]);
  assert.equal(probeSupport().ok, true);
});
test('five is not', () => {
  setPage([el('div', {}, namedButtons(5))]);
  assert.equal(probeSupport().ok, false);
});

console.log('canvas apps');
test('a viewport-filling canvas is refused as a canvas app', () => {
  setPage([el('canvas', { width: VIEWPORT.width, height: VIEWPORT.height })]);
  const report = probeSupport();
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.CANVAS);
});
test('a small chart on a normal page does not condemn it', () => {
  setPage([el('div', {}, [el('canvas', { width: 300, height: 200 }), ...namedButtons(10)])]);
  assert.equal(probeSupport().ok, true);
});

console.log('framed apps');
test('an app inside a big iframe is refused as framed', () => {
  setPage([el('iframe', { width: VIEWPORT.width, height: VIEWPORT.height })]);
  const report = probeSupport();
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FRAMED);
});
test('a page that merely contains a frame is still teachable', () => {
  setPage([el('div', {}, [el('iframe', { width: 400, height: 300 }), ...namedButtons(10)])]);
  const report = probeSupport();
  assert.equal(report.ok, true);
  assert.equal(report.frames, 1, 'the frame is still reported, it just is not the verdict');
});

console.log('unlabelled apps');
test('controls with no names are refused as unlabelled', () => {
  setPage([el('div', {}, Array.from({ length: 20 }, () => el('button', {})))]);
  const report = probeSupport();
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.UNLABELLED);
  assert.equal(report.controls, 0);
});
test('a page with nothing on it is bare, not unlabelled', () => {
  setPage([el('p', { text: 'Just prose.' })]);
  assert.equal(probeSupport().reason, REASON.BARE);
});

console.log('names the runner would actually accept');
test('an invisible control is not a control', () => {
  setPage([el('div', {}, [...namedButtons(5), el('button', { 'aria-label': 'Hidden', width: 0, height: 0 })])]);
  assert.equal(probeSupport().controls, 5);
});
test('a non-action role is not something to point at', () => {
  // A toolbar's own concatenated text is not a button's name; findTarget
  // refuses these unless a target names the role, so the probe must too.
  setPage([el('div', {}, [...namedButtons(5), el('div', { role: 'toolbar', 'aria-label': 'Main toolbar' })])]);
  assert.equal(probeSupport().controls, 5);
});
test('text content names a control when aria-label does not', () => {
  setPage([el('div', {}, Array.from({ length: 8 }, (_, i) => el('button', { text: `Button ${i}` })))]);
  assert.equal(probeSupport().controls, 8);
});

console.log('what the user is told');
test('every reason has its own sentence', () => {
  const seen = new Set();
  for (const reason of Object.values(REASON)) {
    const sentence = explain({ reason }, 'GitHub');
    assert.ok(sentence.length > 20, reason);
    seen.add(sentence);
  }
  assert.equal(seen.size, Object.values(REASON).length - 1,
    'ok shares the fallback sentence; every real obstacle is distinct');
});
test('the site is named rather than called "this page"', () => {
  assert.match(explain({ reason: REASON.CANVAS }, 'Figma'), /Figma/);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
