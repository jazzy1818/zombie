// Generating lessons for apps other than Google Docs.
//
// The pipeline used to hardcode Docs in six files. Everything it knew is now
// one entry in pipeline/apps.js, and an unregistered host falls back to a
// generic profile rather than failing. These tests hold that shape: that a
// registered app keeps its tuned selectors, that an unknown one still gets a
// workable profile, and — the part that actually breaks lessons — that no Docs
// selector leaks into an authored lesson for another app.
//
// No browser and no model: everything here is profile selection and descriptor
// derivation, both of which are pure.
//
//   node docs/apps-tests.mjs

import assert from 'node:assert/strict';
import { appFor, appById, listApps, hostOf, detectLoginWall, waitForApp, diagnoseEmptyPage, choosePage, GENERIC_SELECTORS } from '../pipeline/apps.js';
import { probeSource, PROBE_SOURCE } from '../pipeline/dom-probe.js';
import { deriveVerify, skeleton, deriveTarget } from '../pipeline/emit.js';

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};
const asyncTest = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

const DOCS = appFor('https://docs.google.com/document/d/abc/edit');
const GITHUB = appFor('https://github.com/anthropics/claude-code');
const UNKNOWN = appFor('https://app.example.test/dashboard');

console.log('choosing a profile');
test('a registered host keeps its tuned profile', () => {
  assert.equal(DOCS.id, 'google-docs');
  assert.equal(DOCS.generic, false);
  assert.equal(DOCS.ready, '#docs-toolbar-wrapper');
});
test('an unregistered host still gets a usable profile', () => {
  assert.equal(UNKNOWN.generic, true);
  assert.equal(UNKNOWN.id, 'app.example.test', 'the hostname becomes the app id');
  assert.equal(UNKNOWN.ready, null, 'nothing app-specific to wait for');
  assert.deepEqual(UNKNOWN.selectors, GENERIC_SELECTORS);
});
test('a subdomain inherits its parent app', () =>
  assert.equal(appFor('https://gist.github.com/x').id, 'github'));
test('www is not a different app', () =>
  assert.equal(hostOf('https://WWW.GitHub.com/x'), 'github.com'));
test('a profile is always returned, even for rubbish', () => {
  const app = appFor('not a url');
  assert.ok(app.selectors.control, 'still has something to query');
  assert.equal(app.generic, true);
});
test('appById finds registered apps and refuses invented ones', () => {
  assert.equal(appById('github').id, 'github');
  assert.equal(appById('not-an-app'), null);
});
test('listApps reports every registered app', () => {
  const ids = listApps().map(a => a.id);
  for (const id of ['google-docs', 'gmail', 'github']) assert.ok(ids.includes(id), id);
});

console.log('the injected probe');
// The whole point of parameterising the probe: on GitHub it must not be
// hunting for a Docs element that will never exist.
test('the Docs probe queries the Docs toolbar', () =>
  assert.ok(probeSource(DOCS.selectors).includes('#docs-toolbar-wrapper')));
test('the GitHub probe carries no Docs selector at all', () => {
  const src = probeSource(GITHUB.selectors);
  assert.ok(!src.includes('docs-toolbar-wrapper'), 'toolbar leaked');
  assert.ok(!src.includes('docs-menubar'), 'menubar leaked');
});
test('every profile produces runnable source carrying its own selectors', () => {
  for (const app of [DOCS, GITHUB, UNKNOWN]) {
    const src = probeSource(app.selectors);
    assert.match(src, /^\(function/, app.id);
    // The selectors are serialised into the source, so compare the serialised
    // form — the raw strings contain quotes that JSON escapes.
    assert.ok(src.includes(JSON.stringify(app.selectors)), app.id);
  }
});
test('the legacy PROBE_SOURCE export is still Docs', () =>
  assert.ok(PROBE_SOURCE.includes('#docs-toolbar-wrapper')));

console.log('descriptors the runtime has to resolve');
// deriveVerify writes a selector into shipped lesson data. A Docs selector in
// a GitHub lesson is a verify that can never pass.
const changedStep = to => ({
  delta: { appeared: [], disappeared: [], changed: [{ name: 'Zoom', from: '100%', to }] },
  post: {}, pre: {},
});
test('a Docs label verify is scoped to the Docs toolbar', () => {
  const v = deriveVerify(changedStep('200%'), null, DOCS);
  assert.equal(v.kind, 'label');
  assert.equal(v.selector, '#docs-toolbar-wrapper [aria-label="Zoom"]');
});
test('another app scopes to its own toolbar, not Docs', () => {
  const v = deriveVerify(changedStep('200%'), null, GITHUB);
  assert.equal(v.selector, '[role="toolbar"] [aria-label="Zoom"]');
  assert.ok(!v.selector.includes('docs-'), 'Docs selector leaked into a GitHub lesson');
});
test('no app at all still yields a usable selector', () => {
  const v = deriveVerify(changedStep('200%'), null, undefined);
  assert.equal(v.selector, '[aria-label="Zoom"]');
});
test('a name that cannot be expressed safely degrades to none, not to a guess', () => {
  // A quote in the name would break out of the attribute selector.
  const v = deriveVerify(changedStep('x" ] , script'), null, DOCS);
  assert.ok(v.kind === 'label' || v.kind === 'none');
  if (v.kind === 'label') assert.ok(!v.selector.includes('script'), 'unsafe selector emitted');
});

console.log('targets derived from a generic page');
// A site with no ARIA landmarks puts everything in the `any` bucket. Those
// still have to produce a target the runtime resolver can find.
const pageStep = {
  n: 0,
  target: { id: 7, raw: 'New issue', scope: 'any', name: 'New issue', role: '' },
  pre: { any: [{ id: 7, raw: 'New issue', scope: 'any', name: 'New issue', label: '', role: '', order: 0 }] },
  post: {},
  delta: { appeared: [], disappeared: [], changed: [] },
};
test('a text-labelled page control becomes a scope:any target', () => {
  const t = deriveTarget(pageStep);
  assert.deepEqual(t, { scope: 'any', name: 'New issue' });
});
test('a count badge is stripped out of the target name', () => {
  const badged = {
    ...pageStep,
    target: { ...pageStep.target, raw: 'Issues 12', name: 'Issues' },
    pre: { any: [{ id: 7, raw: 'Issues 12', scope: 'any', name: 'Issues', label: '', role: '', order: 0 }] },
  };
  assert.equal(deriveTarget(badged).name, 'Issues',
    'the badge count changes between authoring and teaching and cannot be in the name');
});

console.log('skeleton');
test('skeleton passes the app through to every verify', () => {
  const steps = skeleton([changedStepWithTarget(), changedStepWithTarget()], GITHUB);
  for (const s of steps) {
    if (s.verify.selector) assert.ok(!s.verify.selector.includes('docs-'), s.id);
  }
});

function changedStepWithTarget() {
  return {
    ...pageStep,
    delta: { appeared: [], disappeared: [], changed: [{ name: 'Zoom', from: 'a', to: 'b' }] },
    action: { reasoning: 'because', expectation: 'it changes' },
  };
}

console.log('public pages need no account');
// A public repo is readable by anybody. Requiring a captured login before the
// pipeline would even open one was a barrier with nothing behind it, so the
// only question left is whether we can tell a public page from a walled one.
const page = (url, password = false) => ({ url: () => url, evaluate: async () => password });

await asyncTest('a public page is not mistaken for a login wall', async () => {
  for (const url of [
    'https://github.com/anthropics/claude-code',
    'https://github.com/orgs/x/settings/logins',
    'https://docs.google.com/document/d/abc/edit',
    'https://developer.mozilla.org/en-US/docs/Web',
  ]) assert.equal(await detectLoginWall(page(url)), null, url);
});

await asyncTest('a redirect to a sign-in page is named', async () => {
  for (const url of [
    'https://github.com/login',
    'https://gitlab.com/users/sign_in',
    'https://accounts.google.com/signin/v2',
  ]) assert.match(await detectLoginWall(page(url)) ?? '', /sign-in page/, url);
});

await asyncTest('an in-place login form is caught without a redirect', async () =>
  assert.match(await detectLoginWall(page('https://app.example.test/', true)) ?? '', /sign-in form/));

await asyncTest('a page we cannot read is not accused of anything', async () => {
  const hostile = { url: () => 'https://example.test/', evaluate: () => Promise.reject(new Error('detached')) };
  assert.equal(await detectLoginWall(hostile), null);
  assert.equal(await detectLoginWall({ url: () => 'not a url', evaluate: async () => false }), null);
});

console.log('waiting for an app to be ready');
// Regression: the bridge now opens whatever page the question was asked from,
// so a registered app's `ready` selector is no longer guaranteed. The Docs
// document list has no editor toolbar, and dying on a raw selector timeout
// there is wrong — the page has plenty to point at.
const fakePage = ({ hasReady = true, controls = 20, url = 'https://docs.google.com/document/u/0/' } = {}) => {
  const page = {
    url: () => url,
    waitForSelector: async () => { if (!hasReady) throw new Error('Timeout 30000ms exceeded.'); },
    waitForTimeout: async () => {},
    evaluate: async () => false,
  };
  const obs = {
    toolbar: [], menu: [], dialog: [],
    any: Array.from({ length: controls }, (_, i) => ({ name: `c${i}` })),
  };
  return { page, probe: async fn => (fn === 'observe' ? obs : null) };
};

await asyncTest('a registered app takes the fast path when its screen is there', async () => {
  await waitForApp(fakePage({ hasReady: true, controls: 0 }), DOCS, { timeout: 1000 });
});

await asyncTest('a Docs page that is not the editor still counts as teachable', async () => {
  // This is the exact failure: #docs-toolbar-wrapper never appears, but the
  // page has twenty controls and a lesson could be authored against it.
  await waitForApp(fakePage({ hasReady: false, controls: 20 }), DOCS, { timeout: 1000 });
});

await asyncTest('a page with nothing on it still fails, but in words', async () => {
  await assert.rejects(
    () => waitForApp(fakePage({ hasReady: false, controls: 0 }), DOCS, { timeout: 1000 }),
    err => {
      assert.ok(!/waitForSelector|Timeout \d+ms/.test(err.message),
        `leaked a Playwright error: ${err.message}`);
      assert.match(err.message, /Google Docs/);
      assert.match(err.message, /docs\.google\.com/, 'names the page it gave up on');
      assert.match(err.message, /canvas or inside an iframe/);
      return true;
    },
  );
});

await asyncTest('an unregistered app never waits on a selector at all', async () => {
  const handle = fakePage({ hasReady: false, controls: 9, url: 'https://app.example.test/' });
  handle.page.waitForSelector = () => { throw new Error('should not be called for a generic app'); };
  await waitForApp(handle, UNKNOWN, { timeout: 1000 });
});

console.log('why a page came back empty');
// The real one: Google serves "Request access" AT the document's own URL,
// rendered after domcontentloaded. The URL never changes and there is no
// password field, so the pre-flight wall check cannot see it — and the page
// then looks like an app with five controls. Blaming a canvas is wrong.
const emptyHandle = (names, { url = 'https://docs.google.com/document/d/abc/edit', anonymous = false } = {}) => ({
  anonymous,
  page: { url: () => url, evaluate: async () => false },
  probe: async () => ({ toolbar: [], menu: [], dialog: [], any: names.map(name => ({ name })) }),
});

await asyncTest('a request-access screen is named as one, not as a canvas', async () => {
  const msg = await diagnoseEmptyPage(
    emptyHandle(['Request access', 'Google apps', 'Google Account']), DOCS, 5);
  assert.match(msg, /sign in or request access/);
  assert.doesNotMatch(msg, /canvas/, 'sent the reader down the wrong path');
});

await asyncTest('it says which account problem it is', async () => {
  const withProfile = await diagnoseEmptyPage(emptyHandle(['Sign in']), DOCS, 3);
  assert.match(withProfile, /expired|wrong account/);
  const signedOut = await diagnoseEmptyPage(emptyHandle(['Sign in'], { anonymous: true }), DOCS, 3);
  assert.match(signedOut, /signed out/);
  assert.match(signedOut, /capture-profile/);
});

await asyncTest('it reports what it actually saw', async () => {
  const msg = await diagnoseEmptyPage(emptyHandle(['Request access', 'Google apps']), DOCS, 2);
  assert.match(msg, /Request access/, 'the control names are the most useful clue');
  assert.match(msg, /docs\.google\.com/);
});

await asyncTest('an ordinary Sign in link does not make a loaded page a wall', async () => {
  // AUTH_NAMES is only consulted on a page that already failed the count, and
  // even then a name has to START like an auth control.
  const msg = await diagnoseEmptyPage(emptyHandle(['Signal strength', 'Login history']), UNKNOWN, 2);
  assert.doesNotMatch(msg, /sign in or request access/);
  assert.match(msg, /canvas or inside an iframe/);
});

await asyncTest('a genuinely blank page still reads as one', async () => {
  const msg = await diagnoseEmptyPage(emptyHandle([]), DOCS, 0);
  assert.match(msg, /Nothing on this Google Docs page/);
  assert.doesNotMatch(msg, /What is on the page/);
});

console.log('which page the cloud browser opens');
// The cloud browser signs in as a throwaway account. It can open the prepared
// DEMO_DOC_URL; it cannot open your personal documents. Following your URL
// unconditionally put it in front of "Request access" and looked like a broken
// login, so: use the prepared page where one exists for that app, follow yours
// where one does not.
const DEMO = 'https://docs.google.com/document/d/PREPARED_DOC_ID/edit';

test('a private doc of yours goes to the prepared document instead', () =>
  assert.equal(choosePage('https://docs.google.com/document/d/MINE/edit?tab=t.0#h', DEMO), DEMO));
test('a public site follows the page you asked from', () => {
  for (const url of ['https://github.com/you/repo', 'https://support.microsoft.com/en-us/x']) {
    assert.equal(choosePage(url, DEMO), url, url);
  }
});
test('no page sent falls back to the prepared one', () =>
  assert.equal(choosePage(undefined, DEMO), DEMO));
test('with no prepared page configured, your page is all there is', () => {
  const mine = 'https://docs.google.com/document/d/MINE/edit';
  assert.equal(choosePage(mine, undefined), mine);
});
test('BT_PREFER_PAGE overrides, for a cloud browser that shares your identity', () =>
  assert.match(choosePage('https://docs.google.com/document/d/MINE/edit', DEMO, true), /MINE/));
test('nothing at all is not a URL', () =>
  assert.equal(choosePage(undefined, undefined), null));

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
