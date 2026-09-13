// Site scoping — the rules that decide which lessons a page is even offered.
//
// Dependency-free on purpose: the other suites in this folder drive a real
// Chrome through Playwright because they test DOM resolution, but this is pure
// string logic and should stay runnable with `node docs/sites-tests.mjs` on a
// machine with nothing installed.
import assert from 'node:assert/strict';

// Set BEFORE importing sites.js, and set at all.
//
// This suite once passed while the extension was badly broken, because Node
// has no `location` and the module's URL parsing only misbehaved when one
// existed. Every lesson matched every site in Chrome and no test could see it.
// Run as the browser runs: with a page loaded, on a host that owns none of the
// lessons, so anything resolving relative to the current page shows up as a
// lesson appearing where it does not belong.
globalThis.location = { href: 'https://analytics.google.com/analytics/web/#/report' };

const { siteKey, siteLabel, lessonSites, lessonRunsHere, isDevHost, LEGACY_SITE, ANY_SITE }
  = await import('../extension/src/sites.js');

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('a lesson host is never read relative to the current page');
// The regression itself. `siteKey('docs.google.com')` used to resolve against
// the page, yielding the page's own hostname, so scoping silently passed
// everything. Each of these would have failed on the broken build.
test('a bare hostname is not resolved against the page', () =>
  assert.deepEqual(lessonSites({ app: 'google-docs' }), ['docs.google.com']));
test('no lesson leaks onto an unrelated site', () => {
  for (const app of ['google-docs', 'github', 'gmail', 'developers.google.com']) {
    assert.equal(lessonRunsHere({ app }, 'analytics.google.com'), false, app);
    assert.equal(lessonRunsHere({ app }, 'support.microsoft.com'), false, app);
  }
});
test('siteKey refuses a relative string rather than inventing a host', () => {
  assert.equal(siteKey('docs.google.com'), '', 'a bare hostname is not a URL');
  assert.equal(siteKey('/some/path'), '');
  assert.equal(siteKey('#fragment'), '');
});
test('lessons still match their own site', () => {
  assert.equal(lessonRunsHere({ app: 'google-docs' }, 'docs.google.com'), true);
  assert.equal(lessonRunsHere({ app: 'github' }, 'github.com'), true);
});

console.log('siteKey');
test('takes the host out of a URL', () => assert.equal(siteKey('https://github.com/a/b?c#d'), 'github.com'));
test('lowercases and drops www', () => assert.equal(siteKey('https://WWW.GitHub.com/'), 'github.com'));
test('keeps subdomains, which are different apps', () => assert.equal(siteKey('https://docs.google.com/x'), 'docs.google.com'));
test('refuses non-http schemes', () => assert.equal(siteKey('chrome://extensions'), ''));
test('never throws on rubbish', () => assert.equal(siteKey('not a url'), ''));

console.log('lessonSites');
test('a lesson with neither app nor sites is a legacy Docs lesson', () =>
  assert.deepEqual(lessonSites({}), [LEGACY_SITE]));
// `app` is what the pipeline emits and every shipped lesson already carries.
test('a registered app id resolves to its host', () =>
  assert.deepEqual(lessonSites({ app: 'google-docs' }), ['docs.google.com']));
test('github and gmail resolve too', () => {
  assert.deepEqual(lessonSites({ app: 'github' }), ['github.com']);
  assert.deepEqual(lessonSites({ app: 'gmail' }), ['mail.google.com']);
});
// An unregistered app id IS a hostname — that is how apps.js names them.
test('an unregistered app id is taken as a hostname', () =>
  assert.deepEqual(lessonSites({ app: 'notion.so' }), ['notion.so']));
test('sites overrides app when both are present', () =>
  assert.deepEqual(lessonSites({ app: 'github', sites: ['*'] }), ['*']));
test('a blank app falls back to legacy rather than matching nothing', () =>
  assert.deepEqual(lessonSites({ app: '  ' }), [LEGACY_SITE]));
test('accepts a bare string', () => assert.deepEqual(lessonSites({ sites: 'github.com' }), ['github.com']));
test('accepts a pasted URL', () => assert.deepEqual(lessonSites({ sites: ['https://github.com/x'] }), ['github.com']));
test('accepts a host with a path, and a protocol-relative one', () => {
  assert.deepEqual(lessonSites({ sites: ['github.com/a/b'] }), ['github.com']);
  assert.deepEqual(lessonSites({ sites: ['//github.com/a'] }), ['github.com']);
});
test('accepts the wildcard', () => assert.deepEqual(lessonSites({ sites: [ANY_SITE] }), [ANY_SITE]));
test('an empty list is not "runs nowhere"', () => assert.deepEqual(lessonSites({ sites: [] }), [LEGACY_SITE]));

console.log('lessonRunsHere');
const docsLesson = { id: 'styles-toc' };
test('a Docs lesson runs on Docs', () => assert.equal(lessonRunsHere(docsLesson, 'docs.google.com'), true));
test('a Docs lesson is NOT offered on GitHub', () => assert.equal(lessonRunsHere(docsLesson, 'github.com'), false));
test('a wildcard lesson runs anywhere', () => assert.equal(lessonRunsHere({ sites: ['*'] }, 'github.com'), true));
test('a subdomain satisfies a parent-domain lesson', () =>
  assert.equal(lessonRunsHere({ sites: ['google.com'] }, 'docs.google.com'), true));
test('but a parent domain does not satisfy a subdomain lesson', () =>
  assert.equal(lessonRunsHere({ sites: ['docs.google.com'] }, 'google.com'), false));
test('a near-miss host does not count as a subdomain', () =>
  assert.equal(lessonRunsHere({ sites: ['google.com'] }, 'notgoogle.com'), false));
test('nowhere is not somewhere', () => assert.equal(lessonRunsHere(docsLesson, ''), false));
test('a generated GitHub lesson runs on GitHub and nowhere else', () => {
  const lesson = { id: 'gh', app: 'github' };
  assert.equal(lessonRunsHere(lesson, 'github.com'), true);
  assert.equal(lessonRunsHere(lesson, 'docs.google.com'), false);
});

console.log('local fixtures');
// Every harness in docs/ serves from 127.0.0.1 and then types questions at the
// chat bar. Scoping a loopback host would hide the whole library from all of them.
test('loopback hosts are recognised', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'app.localhost']) {
    assert.equal(isDevHost(host), true, host);
  }
});
test('a real host is not a fixture', () => assert.equal(isDevHost('github.com'), false));
test('the whole library is offered on a fixture', () =>
  assert.equal(lessonRunsHere(docsLesson, '127.0.0.1'), true));

console.log('siteLabel');
test('names a known app', () => assert.equal(siteLabel('mail.google.com'), 'Gmail'));
test('falls back to the host', () => assert.equal(siteLabel('example.org'), 'example.org'));

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
