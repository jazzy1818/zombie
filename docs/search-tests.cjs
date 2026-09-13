const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = readFileSync(path.join(root, 'extension/src/panel/search.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
// Keep the regression corpus stable when the live bridge publishes more lessons.
const lessons = ['add-date', 'add-image', 'change-font-style', 'change-page-zoom-200',
  'paragraph-spacing', 'styles-toc', 'version-history', 'wanna-change-color-of-current', 'wanna-increase-font-size']
  .map(id => JSON.parse(readFileSync(path.join(root, 'extension/lessons', `${id}.json`), 'utf8')));
const extra = { 'styles-toc': ['toc', 'table of contents'], 'version-history': ['version history', 'undo', 'revert'] };

async function lookup(question, library = lessons) {
  const api = await modulePromise;
  const ranked = api.search(question, api.buildIndex(library, extra));
  return { ranked, offered: api.relevant(ranked).map(result => result.id), confident: api.isConfident(ranked) };
}

test('exact saved tasks remain reusable without generation', async () => {
  for (const [question, id] of [
    ['how do I add a table of contents', 'styles-toc'],
    ['how do I change the font style', 'change-font-style'],
    ['how do I adjust paragraph spacing', 'paragraph-spacing'],
    ['how do I add a date', 'add-date'],
  ]) {
    const result = await lookup(question);
    assert.equal(result.ranked[0].id, id, question);
    assert.equal(result.confident, true, question);
  }
});

test('font colour ranks the colour task above the font-family task', async () => {
  const { ranked, offered } = await lookup('how do I change the font colour');
  assert.equal(ranked[0].id, 'wanna-change-color-of-current');
  assert.ok(offered.includes('wanna-change-color-of-current'));
  assert.ok(offered.length >= 2 && offered.length <= 3);
});

test('colour and color produce the same ranking', async () => {
  assert.deepEqual((await lookup('change font colour')).offered, (await lookup('change font color')).offered);
});

test('an ambiguous font question offers related tasks without choosing for the user', async () => {
  const { offered, confident } = await lookup('change font size and color');
  assert.equal(confident, false);
  assert.ok(offered.includes('wanna-increase-font-size'));
  assert.ok(offered.includes('wanna-change-color-of-current'));
  assert.ok(offered.length <= 3);
});

test('a paraphrase still offers the saved lesson as a near match', async () => {
  const { offered, confident } = await lookup('make my document have chapters');
  assert.deepEqual(offered, ['styles-toc']);
  assert.equal(confident, false);
});

test('generic action words cannot turn unrelated saved lessons into suggestions', async () => {
  const library = ['image', 'date', 'chart', 'bookmark'].map(subject => ({
    id: subject, goal: `Add a ${subject}`, steps: [],
  }));
  assert.deepEqual((await lookup('add a podcast', library)).offered, []);
  assert.deepEqual((await lookup('how do I change something')).offered, []);
});

test('suggestions stop at the best three even in a larger library', async () => {
  const library = ['family', 'size', 'color', 'weight', 'spacing'].map(subject => ({
    id: subject, goal: `Change font ${subject}`, steps: [],
  }));
  const { ranked, offered } = await lookup('font', library);
  assert.equal(offered.length, 3);
  assert.deepEqual(offered, ranked.slice(0, 3).map(result => result.id));
});

test('unrelated questions offer no filler and never auto-launch', async () => {
  for (const question of ['add an email draft', 'add a header or footer', 'mail merge from a spreadsheet', 'schedule a post for later']) {
    const result = await lookup(question);
    assert.deepEqual(result.offered, [], question);
    assert.equal(result.confident, false, question);
  }
});

test('a familiar phrase cannot hide a different subject in the request', async () => {
  assert.equal((await lookup('change font style in a spreadsheet')).confident, false);
  assert.equal((await lookup('change chart color')).confident, false);
});

test('minor typos still retrieve the intended saved lesson', async () => {
  assert.equal((await lookup('verison histroy')).offered[0], 'version-history');
});
