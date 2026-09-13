# Test the current workflow

The merged extension contains the real resolver, teaching adapter, panel and paint.
Use the local fixture to check extension behavior, then a prepared Google Doc to
rehearse the demo lesson. **Teach me** searches the published library first. When
there is no confident match and the local authoring bridge is running, it also
offers **Work it out for me**, which generates a new lesson in a cloud browser.

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
**Teach me**. A confident match opens its preamble; an uncertain question shows
up to four published lesson choices. Click **Show me** and follow the nine steps:

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

## 5. Watch a lesson being generated

Use the configured pipeline from section 4. Start its local bridge:

```powershell
Set-Location C:\Storage\Repo\zombie\pipeline
npm run bridge
```

If the bridge is already running an older version, let any active generation
finish, stop that bridge with **Ctrl+C**, then run the command again. Reload
Browser Teacher at `chrome://extensions` and refresh the website as well.

1. Ask a question that is not already in your lesson library, then click
   **Work it out for me**. A cached lesson does not start a cloud browser.
2. Click the underlined **Opening a cloud browser…** row. A separate floating
   **Cloud browser** window opens immediately; its waiting message changes to
   Steel's live iframe when the session becomes available. The row then reads
   **Watch cloud browser**.
3. Watch the AI explore. Drag the window by its header or resize its bottom-right
   corner. The embedded window is for viewing; it does not forward your clicks
   or keystrokes to the browser the AI is controlling.
4. Click **−** (Minimize cloud browser), or press **Escape** while the viewer has
   keyboard focus. Its iframe unloads while lesson generation continues. Click
   the status row again to resume watching the same active session.
5. If the pipeline retries or verifies in a fresh browser, the open viewer
   follows that session automatically. When a browser closes, its live stream
   changes to a recording player. Use **Play**, **Pause**, or the timeline to
   review what happened. The player waits briefly before loading and retries
   automatically while Steel prepares the recording. **Retry** remains available
   if processing takes longer than the automatic retry window.
6. A **Watch recording** button appears near the chat bar (at the top edge in a
   narrow window) and stays available
   after generation succeeds or fails while you work through the lesson. Minimize
   the viewer, then use this button to reopen it. With multiple attempts, the
   **Session** selector lets you review earlier recordings or return to the live
   browser. The generating panel's **Watch cloud browser** row always returns
   to the current live attempt, even after you selected an earlier recording.
   Viewing a recording does not start another cloud session. Clicking **Done**
   closes the viewer and removes its recording button and history.
7. If a newly created live browser is not ready, the viewer reconnects
   automatically. **Retry live view** reconnects just the player; it does not
   restart the AI's work. If playback still cannot start, use
   **Open Steel player in a tab**. That
   opens Steel's own player, whose interaction controls depend on Steel. A local
   CDP run or a bridge that does not supply an embeddable URL shows an unavailable
   message while generation can continue. Recordings also provide **Open session
   in Steel** as a fallback to the dashboard's session preview.

The replay button belongs to the current task on this webpage. **Done**, **Stop**, a new
question or lesson, website navigation, or page refresh clears that local history.
Close, Not now and viewer Minimize keep recordings already received. The
bridge retains replay links in memory for 24 hours; restarting it expires those
links. Steel's dashboard remains the place to find older recordings. The bridge
uses the configured Steel key to fetch recording playlists and streams media
through local routes; the extension receives no API key.

The bridge's panel-generation path saves the lesson into the extension library
and teaches it immediately. Its default skips automatic replay; the CLI authoring
and verified-publication flow in section 4 remains available. Confirm the actual
website outcome yourself. **Stop** ends the panel's wait and clears the viewer and recording history;
it does not cancel the already-running backend job. Minimizing only hides the view.

The live embed uses Steel's documented `debugUrl` and `interactive=false` option.
Completed-session playback uses Steel's HLS recording API with the packaged
HLS.js player. See [Steel live session embeds](https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions)
and [past-session playback](https://docs.steel.dev/overview/sessions-api/embed-sessions/past-sessions).

## 6. Run the automated regression suites

From the repository root, with Node, Playwright and its Chromium installed:

```powershell
node docs/paint-tests.cjs
node docs/resolver-tests.cjs
node docs/teaching-tests.cjs
node docs/extension-tests.cjs
node docs/generate-tests.cjs
node --test --test-isolation=none pipeline/session-viewer-tests.mjs
node --test --test-isolation=none pipeline/session-replay-tests.mjs
node --test --test-isolation=none pipeline/replay-player-tests.mjs
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

The [generation report](generate-test-results.md) covers the real extension with
an ephemeral bridge stub and an inert Steel-player fixture, including viewer
minimize/reopen, retries, completed-session history, cleanup, restricted page CSP and small viewports. It
uses a disposable extension copy and leaves the running port-7777 bridge alone.
The Node viewer and replay suites check session metadata, retained recordings,
authenticated playlist rewriting, media streaming and cleanup without cloud
or model calls. These checks do not prove live Steel video playback; use the
manual generation steps above for that final end-to-end check.

The [replay report](replay-test-results.md) records the separate successful
read-only playback check against an existing completed Steel session.

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
