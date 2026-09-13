# Test the current workflow

The merged extension contains the real resolver, teaching adapter, panel and paint.
Use the local fixture to check extension behavior, then a prepared Google Doc to
rehearse the demo lesson. Typing into **Teach me** searches saved lessons and may
ask the running bridge to judge an uncertain match. Generating a new lesson
requires choosing the generation or rejection action.

## 1. Start the local page on Windows

In PowerShell, with Python available on PATH:

```powershell
Set-Location C:\Storage\Repo\zombie
python -m http.server 8765 --bind 127.0.0.1
```

Keep that terminal running. If a server already responds at
[the extension fixture](http://127.0.0.1:8765/docs/extension-fixture.html), use it
instead of starting a second server on the same port. A connection-refused page
means the server is not listening; starting or reloading the extension cannot fix it.

## 2. Load the extension and try the local practice

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select `C:\Storage\Repo\zombie\extension`.
   If Browser Teacher is already installed, use its **Reload** button instead.
3. Refresh [extension-fixture.html](http://127.0.0.1:8765/docs/extension-fixture.html).
   The Browser Teacher chat bar should appear at the bottom.
4. Open DevTools → Console. In the execution-context selector, choose **Browser
   Teacher**, not `top`. Run:

```js
__BT_DEV.off();
fetch('/docs/extension-practice.json')
  .then(response => response.json())
  .then(lesson => __BT_DEV.runLesson(lesson));
```

5. Click **Show me**. Follow the website controls yourself: the primary button,
   nested scroller, menu opener and item, modal opener and confirmation, downpage
   button, and final link. The redirect deliberately ends this practice.

Check that the ghost starts at your observed cursor position, scrolling is smooth,
and a correct click immediately removes the effects. A wrong website control
should give a correction; clicking the teacher panel must not count as an answer.
Scroll a highlighted target out of view: the page remains dim until it returns.
Try **Stop** while scrolling and inside the modal; no later step should reappear.

This practice exercises the actual loaded extension with supplied lesson data.
It does not test lesson generation or matching your question to a published file.
For renderer-only diagnosis, the separate
[paint workshop](http://127.0.0.1:8765/docs/paint-harness.html) imports paint itself;
use the extension fixture for integration testing so there is only one runtime.

## 3. Test the normal question-to-lesson path

Published lessons are listed in `extension/lessons/index.json`. The packaged
library starts with `styles-toc` and `version-history`. In the Browser Teacher
console context, `await __BT_DEV.lessons()` lists the discovered IDs.

Open a **prepared, editable test Google Doc** in the signed-in Chrome window.
For a fresh rehearsal, enter a title and two section headings on separate lines,
with a short paragraph below each. Leave all lines in **Normal text** initially.
Use a document where you can freely change styles and insert a table of contents.
Reload the extension if necessary, then refresh the Doc. Measure the page viewport
with `({ width: innerWidth, height: innerHeight })`; aim for local 1440×900. C's
measured Steel viewport was 1435×809, so do not assume a requested browser window
size equals its content viewport. If controls collapse into overflow, record that
as an application-layout difference.

Type **How do I add an automatic table of contents?** in the chat bar and click
**Teach me**. A confident match opens its preamble, with a **No, I'm not talking about this**
button that hands the question to the authoring bridge instead. An uncertain
question is checked with the bridge's model when `npm run bridge` is running.
Either way the panel offers only lessons that are actually related, or says it
has none: a model that rules every saved lesson out stops the panel launching
one, but it does not hide a near miss local search still believes in — the
choice stays with you, next to **No, I'm not talking about this**. Click **Show me** and
follow the nine steps:

1. Click the highlighted **Styles** opener yourself, including in demo mode.
2. Click the document's title line, then **Got it** in the panel. Canvas text is
   an instruction step because it is not a DOM control the renderer can target.
3. Open **Styles**. Try **Font** once first to check the written correction.
4. Choose **Heading 1** and check that the actual line changed style.
5. Put the caret on a section line and open **Styles** again.
6. Choose **Heading 2** and check the actual line.
7. Find **Insert** without the initial highlight.
8. Open **Page elements**.
9. Choose **Table of contents** and inspect the resulting document.

The final click uses `verify:none`, so independently confirm that the expected
contents were inserted. An ending card alone is not proof of the document outcome.

For the other bundled lesson, type **How can I find and name a version of my
document?** Its four steps are **File → Version history → See version history →
Name this version**. The final click is verified only as a click; the lesson does
not yet teach or verify entering and saving a name. Complete that part manually
when checking the actual outcome, and record the limitation in the rehearsal log.

Try **Stop** once and start again through the question box. **Show me where**
adds visual guidance; it does not click the page for you. No authoring API keys
or cloud session are needed to run these existing lessons.

### Free-choice steps

Ask **how do I change the font style**. Its last step is a *free choice*: the
target carries `"any": true`, so the spotlight covers the whole font list rather
than the one font the explorer happened to click, and picking Georgia is as
correct as picking Arial. Verify both — choose a font other than the highlighted
one and confirm the panel accepts it instead of showing a wrong-click
correction: a correct click leaves a green note ("Yes — that works.") for a
moment before the next step, the counterpart of the red note a wrong one gets.
A step like this always verifies as `none`, because whatever changed on the
page names the value that was chosen.

A choice is defined by where it sits, not by what ARIA the row carries. The
example named in the target is resolved once — by role, or failing that by its
text inside any list (`listbox`, `menu`, `radiogroup`, `grid`, `tree`) — and
from then on any row chosen inside that list counts, whether the page calls it
an option, a checkbox item, or nothing at all. The row is remembered at
mousedown, so a popup that closes or re-renders before the click arrives cannot
lose it. Empty space, the list's search field, disabled rows, readouts and,
when the example has a role, rows of a different role (**More fonts**) do not
complete the step. Nothing in this is specific to Google Docs; the same rule
covers a date picker, a colour grid or a settings radio group on any site.

`any` may also be a pattern. Ask **how do I change the heading**: its last step
carries `"any": "^Heading \\d+$"`, so Heading 1, 2 or 3 all complete it while
Title and Normal text still get their corrections. The emitter derives this
itself: when the goal's own words name the kind of row wanted and only some
rows are that kind, the accepted rows are listed; when nothing in the goal
singles any row out, every row counts; when the goal names one exact value
("zoom to 200%"), the step stays pinned.

The emitter sets the flag for a lesson's final step when the control is one of
several interchangeable options (`option`, `menuitemradio`, `menuitemcheckbox`,
`radio`, or a `menuitem` inside a `listbox`), it has at least three peers in
the same list, and the goal does not name any value in that group.
`extension/lessons/add-date.json` solves the same problem the other way: its
calendar grid has no resolvable option names, so the last step is instruct-only
(`target: null`) and ends on **Got it**.

If a click during a step does nothing at all, it was neither accepted nor
recognised as wrong. In DevTools, switch the console context to *Browser
Teacher* and read `__TEACH.lastClick` — the verdict and the click path with
each element's tag, role and label — or enable *Verbose* to see the same line
logged for every click.

### Search and rejection regression

These are saved lessons, not a chronological list of everything typed. The
picker ranks related tasks and shows at most three; it can show one or none
when the library has fewer useful matches.

1. Reload Browser Teacher at `chrome://extensions`, then refresh the test Doc.
2. Ask **change font size and color**. Expect two or three related font lessons
   and **No, I'm not talking about this**. Unrelated date, image and version
   lessons should be absent.
3. Choose a suggestion. Its preamble must retain the rejection button. Rejecting
   it sends the original question to generation, not the saved lesson's title.
4. Ask **make my document have chapters**. A near-match picker should include the
   table-of-contents lesson. If the bridge selects it, the preamble still lets
   you reject it. A bridge response of "none" must not hide local near matches.
5. Ask **how do I mail merge from a spreadsheet**. With no such saved lesson,
   the previous choices must disappear instead of accumulating.
6. With the bridge stopped, repeat the chapters question and reject the
   suggestions. The panel must explain generation is unavailable and leave
   the question field enabled.

Run `node --test docs/search-tests.cjs` from the repository root for the stable
local ranking cases. `docs/generate-tests.cjs` checks the actual loaded extension
with a stub bridge, including rejection, the three-suggestion cap and replacing
old results. Its requests are routed to a temporary port, so your real bridge
can keep running without receiving test requests.

## 4. Publish a newly generated lesson

This section is optional when testing the existing extension. Cloud authoring uses
a Steel browser session and Anthropic model calls, consuming those services' usage.
Use an editable test document: exploration and replay perform real page actions.

Install the locked pipeline dependencies:

```powershell
Set-Location C:\Storage\Repo\zombie\pipeline
npm ci
```

Configure `pipeline/.env` with `STEEL_API_KEY`, `ANTHROPIC_API_KEY`, `PROFILE_PATH`
and `DEMO_DOC_URL`. Keep actual keys and the signed-in profile out of Git, lesson
files and test reports. An example shape is:

```dotenv
STEEL_API_KEY=your-steel-key
ANTHROPIC_API_KEY=your-anthropic-key
PROFILE_PATH=./profile.json
DEMO_DOC_URL=https://docs.google.com/document/d/YOUR_TEST_DOCUMENT_ID/edit
```

For cloud authoring, capture the signed-in profile if it does not exist:

```powershell
npm run capture-profile
```

Follow the pipeline's session-viewer instructions and sign in yourself. Having
credentials configured does not mean a usable browser profile has been captured.
Then generate a shallow lesson with a concrete observable outcome:

```powershell
npm run author -- --id zoom-150-test --goal "Set the page zoom to 150%" --check-aria "Zoom list. 150% selected." --doc "YOUR_TEST_DOC_URL" --publish
```

The normal authoring path explores, prunes, emits candidate JSON, and replays it.
`--publish` opts into publication only after that run produces complete successful
verification. The pipeline writes candidate JSON into `pipeline/out/`; without
publication it does not add a lesson to the extension.

For a local browser alternative, start a dedicated Chrome profile with CDP, then
sign in and open the test Doc in that window:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=$env:TEMP\bt-chrome"
```

Adjust the executable path if Chrome is installed elsewhere. This is a separate
profile, not an ordinary already-open Chrome session. Add `--local` to the authoring
command to use it instead of Steel; model-based exploration still uses Anthropic.
For example, use the preceding `npm run author` command with `--local --publish`.

To replay and publish an existing candidate separately, use its exact file:

From the `pipeline` directory, replay the exact candidate and publish it only
with a complete matching verification report:

```powershell
Set-Location C:\Storage\Repo\zombie\pipeline
node --env-file=.env author.js verify out/my-lesson.json --local --doc "YOUR_TEST_DOC_URL"
node author.js publish out/my-lesson.json --report reports/my-lesson.verify.json
```

`--local` connects to the dedicated browser at `http://localhost:9222`. Omit it
only when deliberately choosing a configured cloud replay. Use the actual lesson
ID in the report filename. A failed, skipped or stale replay is not publication
evidence. The publisher copies the validated lesson and updates the extension's
index; publishing by itself does not create a browser or call a model.

The pipeline's cached `demo` command still replays real page clicks in a browser.
Use `npm run demo -- --local` for its local-browser mode; cached does not mean
offline, and it is separate from the extension's user-driven demonstration mode.

After publication, **reload the unpacked extension and refresh the website**.
The page caches its library and search index. Confirm the new ID with
`await __BT_DEV.lessons()`, then type the corresponding question into the chat bar
and follow the lesson yourself. This final human run checks the teaching behavior
that automated authoring replay alone cannot prove.

## 5. Run the automated regression suites

From the repository root, with Node, Playwright and its Chromium installed:

```powershell
node docs/paint-tests.cjs
node docs/resolver-tests.cjs
node docs/teaching-tests.cjs
node docs/extension-tests.cjs
```

These runners start their own temporary local servers; they do not need port 8765.
The loaded-extension runner uses a separate disposable browser profile. Set
`CHROME_PATH` to a Chromium or Chrome for Testing executable with unpacked-extension
support if needed; ordinary branded Chrome may ignore the test launch flags.

The extension suite includes actual packaged-index discovery, typed-question
selection, the uncertain-question picker, and trusted website clicks. A publication
check measures a local fixture replay, passes that evidence to the real publisher,
and loads a temporary copy of the extension containing the new lesson. It then
finds and completes that lesson through the question box. Production source files
are unchanged; this checks publication and teaching, not cloud exploration. Its fixture
lessons also cover scrolling, modal sequencing, wrong clicks, cancellation,
navigation and disabled controls. The other suites isolate renderer, resolver
and semantic-adapter behavior.

Read the dated [paint](paint-test-results.md), [resolver](resolver-test-results.md),
[teaching](teaching-test-results.md) and [extension](extension-test-results.md)
reports for the actual run results. Local fixtures do not certify a live website,
and none of these commands claims that a paid/cloud or signed-in live rehearsal ran.

The pipeline also has a local browser suite. After installing its dependencies,
run `npm test` from `pipeline/` (with `CHROME_PATH` set if needed). It checks observed
targets, real fixture clicks, pruning, descriptor generation, replay and verified
publication, plus rejection of failed or stale evidence. It does not call Steel
or Anthropic. See [pipeline test results](pipeline-test-results.md).

## Record a useful failure

Record the lesson ID and step, the expected control, what happened, the viewport,
and whether the problem reproduces on the local fixture. Wrong/missing semantic
targets belong with resolver/lesson work; a correctly identified element with
misplaced or stale visuals belongs with paint. Use
[demo-script.md](demo-script.md)'s rehearsal log for live findings.
