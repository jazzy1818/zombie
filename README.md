# Browser Teacher

Browser Teacher is a Chrome extension that teaches web-app workflows inside the
page where the work happens. Ask how to do something, choose a matching lesson,
and the extension points to the next control. It explains why that control
matters and waits for you to click it.

That last part is deliberate: Browser Teacher does not complete the task for
you. The learner makes every click, so the lesson feels closer to guided
practice than a product tour.

The repository contains two connected pieces:

- **Teaching extension:** searches saved lessons, resolves each semantic target
  against the live page, highlights it, and checks the learner's action.
- **Authoring pipeline:** explores a workflow in a local or Steel cloud browser,
  removes wrong turns, writes a reusable lesson, and can replay it before
  publication.

Saved lessons are plain JSON. They describe controls by meaning and context,
not by screen coordinates, so the same lesson can survive ordinary differences
between the authoring browser and the learner's window.

## Run the extension

You do not need Node.js, an API key, or the authoring bridge to use the lessons
already included in this repository.

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this repository's `extension` folder.
4. Open or refresh an HTTP/HTTPS page. Google Docs is the best place to try the
   bundled lessons.
5. Use the Browser Teacher bar at the bottom of the page. Ask a question such
   as **How do I change the font style?**, click **Teach me**, and choose the
   lesson you want.
6. Click **Show me** when you want visual guidance, then make the highlighted
   click yourself.

After changing extension code or adding a lesson, click **Reload** on
`chrome://extensions` and refresh the page you are testing. Reloading the
website alone does not reload the extension package.

### Run a local smoke test

The repository includes a small practice site that exercises the real resolver,
teaching controller, and visual layer without touching a live application.
From the repository root, run:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

On Windows, use `python` instead of `python3`. Keep the terminal open, then visit
[the extension fixture](http://127.0.0.1:8765/docs/extension-fixture.html). Load
Browser Teacher as described above and refresh the fixture.

In DevTools, switch the Console execution context from `top` to **Browser
Teacher**, then run:

```js
__BT_DEV.off();
fetch('/docs/extension-practice.json')
  .then(response => response.json())
  .then(lesson => __BT_DEV.runLesson(lesson));
```

The practice lesson covers ordinary controls, scrolling, a menu, a modal, a
wrong click, cancellation, and navigation. A fuller manual checklist is in
[docs/testing-workflow.md](docs/testing-workflow.md).

## Generate a new lesson

Generation is optional. It is used when the saved library does not contain a
good match for the learner's question.

### Requirements

- Node.js 24 or newer
- A Steel API key
- An Anthropic API key
- A prepared page where the authoring browser is allowed to perform the task

Install and configure the pipeline:

```bash
cd pipeline
npm ci
cp .env.example .env
```

On Windows PowerShell, replace the last command with:

```powershell
Copy-Item .env.example .env
```

Fill in `pipeline/.env`:

```dotenv
STEEL_API_KEY=your_steel_key
ANTHROPIC_API_KEY=your_anthropic_key
PROFILE_PATH=./profile.json
DEMO_DOC_URL=https://docs.google.com/document/d/your-test-document/edit
```

Both `.env` and `profile.json` are ignored by Git. Keep API keys and saved
browser sessions out of commits.

Public pages can be explored anonymously. For a private Google Doc or another
signed-in workflow, capture a reusable browser profile once:

```bash
npm run capture-profile -- --sites "Google, GitHub"
```

Complete the sign-in in the browser that opens. The resulting profile is used
automatically by later exploration and verification runs.

Start the local bridge and leave it running:

```bash
npm run bridge
```

The bridge listens on `http://localhost:7777`. It keeps API keys outside the
extension and performs model and cloud-browser work on the extension's behalf.
Refresh the target page after starting it. When a question has no confident
saved match, the panel offers **Work it out for me**; when it has near matches,
**None of these** starts the same generation path. A lesson normally takes a
few minutes to explore and write, and the panel can show the live browser or a
recording while it runs.

When generation succeeds, the bridge writes the lesson to
`extension/lessons/` and rebuilds `extension/lessons/index.json`. The current
panel can teach the returned lesson immediately. Reload the unpacked extension
and refresh the site before expecting a newly written lesson to be searchable
in a later session.

### Author from the command line

The same pipeline can be run directly when you want an explicit goal and
completion check:

```bash
npm run author -- --id change-page-zoom-150 --goal "Change page zoom to 150%" --doc "https://docs.google.com/document/d/your-test-document/edit" --check-aria "Zoom list. 150% selected." --publish
```

This explores the task, emits a lesson into `pipeline/out/`, replays it, and
publishes it only when every required step passes. Omit `--publish` while
iterating. Run `node author.js` from `pipeline/` to see the available pipeline
commands.

## How teaching works

```text
question
  -> site-scoped lesson search
  -> learner chooses a lesson
  -> teaching controller resolves the next semantic target
  -> paint layer spotlights the live control
  -> learner clicks
  -> click and outcome verification advance the lesson
```

If local search is uncertain and the bridge is available, the bridge can judge
the best candidates before the panel shows them. A weak text match is not enough
to silently start a lesson, and the learner can reject a suggestion before any
steps run.

During a lesson, the main runtime responsibilities stay separate:

- `extension/src/panel/` owns questions, lesson choices, progress, and bridge
  communication.
- `extension/src/teaching/` coordinates each step and cancellation.
- `extension/src/resolve/` finds visible controls, validates clicks, and checks
  DOM outcomes.
- `extension/src/paint/` owns spotlighting, guidance, scrolling, and feedback.
- `extension/lessons/` contains published lesson JSON and its index.
- `pipeline/` contains exploration, pruning, emission, replay, publication, and
  the local bridge.

The composition is documented in
[docs/extension-integration.md](docs/extension-integration.md). The original
design contracts and project checkpoints remain in [PLAN.md](PLAN.md) and
[CHECKPOINT-1.md](CHECKPOINT-1.md) for development history.

## Test the project

The pipeline's local test suite does not call Steel or Anthropic:

```bash
cd pipeline
npm test
```

The site registry and page-support checks can be run from the repository root:

```bash
node docs/sites-tests.mjs
node docs/support-tests.mjs
node docs/apps-tests.mjs
```

Resolver, teaching, paint, generation, and loaded-extension browser suites are
also included. They need Playwright and a compatible Chromium executable; the
exact commands and expected manual checks are kept in
[docs/testing-workflow.md#6-run-the-automated-regression-suites](docs/testing-workflow.md#6-run-the-automated-regression-suites).

## Current limitations

- Google Docs renders document text on a canvas. Browser Teacher can resolve
  toolbar controls, menus, dialogs, and sidebars, but it cannot target an
  individual word or paragraph in the document body. Those moments have to be
  taught as instructions and checked through a visible DOM side effect when one
  exists.
- Google Docs keeps many hidden menu items in the DOM. Resolution must filter
  for visibility before matching a label.
- Responsive layouts can move controls into overflow menus. Google Docs lessons
  are authored around a `1440x900` viewport; a substantially narrower window
  may expose a genuinely different workflow.
- Generic sites work best when their controls have stable text, ARIA labels, or
  standard roles. Canvas-only interfaces and deeply embedded cross-origin
  frames cannot be taught reliably with the current resolver.

Browser Teacher is a prototype, so a completed lesson is evidence that its
steps ran, not a guarantee that every external application state changed as
intended. For important workflows, keep an explicit final outcome check in the
lesson and rehearse it on the target site before publishing.
