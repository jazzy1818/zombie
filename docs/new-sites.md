# Teaching a site that isn't Google Docs

The teaching runtime was never Docs-specific. `teaching/resolution.js` matches on
accessible names and ARIA roles, `queryDeep` walks open shadow roots, and the
manifest already injects on every `http(s)` page. What was Docs-specific was the
*library*: every lesson was implicitly a Docs lesson, and nothing said so.

This is how to add another app, and how to tell when an app can't be added.

## 1. Check the page is teachable at all

Open the app, open DevTools, and switch the console context to **Browser
Teacher** (not `top`):

```js
__BT_DEV.support()
// { ok: true, reason: 'ok', controls: 214, frames: 0 }
```

`controls` counts distinct controls the resolver could be asked to find by
accessible name. That is the only requirement there is. If `ok` is false the
panel has already said so on screen, and `reason` says why:

| reason | what it means | can it be fixed |
|---|---|---|
| `canvas` | the UI is painted on a `<canvas>` — Figma, Miro, Maps | no |
| `framed` | the app renders inside an iframe we can't reach into | open the app at its own URL |
| `unlabelled` | controls exist, none carry an accessible name | no, not from our side |
| `bare` | almost nothing on the page | usually still loading — **Check again** |

## 2. Find the real control names

Never guess a target name. `Insert` in the DOM might be `Insert menu`; GitHub's
Issues tab reads as `Issues 12`; Gmail's is `Inbox 1,203`.

```js
__BT_DEV.probe()              // every nameable control, grouped by scope
__BT_DEV.probe('issue')       // only names containing "issue"
__BT_DEV.probe({ scope: 'menu' })
```

Each row is the `target` a step should carry. **`count` above 1 means the name is
ambiguous and the step needs `nth`** — the most common reason a hand-written
lesson fails on the day. A control that is not currently on screen is not
resolvable and will not be listed, so open the menu or dialog first, then probe
again.

Then check the descriptor you actually wrote:

```js
__BT_DEV.check({ name: 'New issue' })          // scrolls to it, or says no match
__BT_DEV.check({ name: 'Insert', scope: 'menu' })
```

## 3. Write the lesson

Same schema as before (PLAN.md §5), plus two optional fields:

```jsonc
{
  "id": "github-new-issue",
  "sites": ["github.com"],   // REQUIRED for anything that isn't Docs
  "navigates": true,         // only if a step changes the page's route
  "goal": "...",
  "steps": [ ... ]
}
```

**`sites`** is what keeps a Docs lesson off GitHub. A lesson with no `sites` is
treated as a legacy Docs lesson, because every lesson written before this field
existed was one. Accepted: `"github.com"`, `["github.com"]`, a pasted URL, or
`["*"]` for something genuinely app-independent. A parent domain covers its
subdomains (`google.com` matches `docs.google.com`) but never the reverse.

**`navigates`** matters more than it looks. Docs lessons never change the URL, so
the panel cancels a running lesson on any route change — that is how it notices
the user has left. GitHub swaps the whole path to open Issues, and without this
flag a lesson would cancel itself on the click it just asked for. With it, only
leaving the *app* ends the lesson.

## 3b. Where local testing lies to you

Lessons served from a loopback host skip site scoping entirely, so that the
fixture harnesses in this folder keep seeing the whole library. That means
**`127.0.0.1` will never show you the scoping behaviour** — every lesson is
offered there, including Docs lessons on a fixture that looks nothing like Docs.

To exercise scoping against a local server, reach it by a non-loopback name.
`localtest.me` and its subdomains resolve to 127.0.0.1 from public DNS, so:

```
http://localtest.me:8765/docs/extension-fixture.html
```

is the same local server with a hostname the scoping rules actually apply to.
`node docs/sites-tests.mjs` covers the rules themselves.

The support probe is **not** exempt on loopback, so
`docs/unsupported-fixture.html` works straight off `python3 -m http.server`.

## 4. Register and test it

Add the id to `extension/lessons/index.json`, reload the unpacked extension,
refresh the page, and run the lesson yourself end to end. `await
__BT_DEV.lessons()` confirms discovery; `__BT_DEV.run('github-new-issue')` skips
the question box.

A lesson that has not been replayed against the live site by a human is not
done. See §17.5 of PLAN.md — a lesson can pass authoring and still die on stage
because the page was in a different state.

## 5. Generating lessons instead of writing them

The panel sends the page you asked from, and the bridge decides what to open:

| where you asked | what the cloud browser opens |
|---|---|
| Google Docs | `DEMO_DOC_URL`, the prepared document |
| anywhere else | the page you asked from |

**Why not always your page?** The cloud browser is a different identity. It
signs in with a throwaway account that can open the prepared document but not
your personal ones — point it at a private doc of yours and it lands on
"Request access", which looks like a broken login but isn't.

So: an app with a prepared page uses it; everything else follows your URL,
which is what makes public sites work. Set `BT_PREFER_PAGE=1` to always follow
your page, if the cloud browser shares your identity.

```bash
cd pipeline
npm run bridge                    # leave running; the panel finds it on :7777
```

Then ask the panel a question it has no lesson for and press **Work it out for
me**. Or drive it from the CLI, which takes any URL:

```bash
node author.js run --goal "create a new issue" --doc https://github.com/you/repo
node author.js apps               # which apps have a tuned profile
node author.js open --doc <url>   # what the probe sees on a page, before committing
```

### App profiles

[pipeline/apps.js](../pipeline/apps.js) holds everything the pipeline knows
about an app: the selector meaning "loaded", where its toolbar and menu bar
live, and a block of facts for the explorer's prompt. Google Docs, Gmail and
GitHub have entries.

**An unregistered host is not an error.** It gets the generic profile — ARIA
landmarks where they exist, every nameable control otherwise — and its hostname
becomes the lesson's `app`. Adding an entry buys sharper selectors and a better
briefing; it is an optimisation, not a prerequisite for generating a lesson.

Registering one is a single object: `hosts`, a `ready` selector, `minWidth`
below which the app hides controls in an overflow menu, and `facts` — the
things you would tell a person before asking them to explore it.

### Public pages need no account

A public repo, a docs site, a link-shared document — the cloud browser just
opens them. With no saved profile the pipeline explores **signed out** and says
so, rather than refusing to start:

```bash
node author.js run --goal "create a new issue" --doc https://github.com/you/repo
```

If a page does want an account, that is detected and named before the explorer
spends its turn budget clicking around a login form — you get *"the browser was
redirected to a sign-in page"*, not a vague "stuck".

| flag | session |
|---|---|
| *(none)* | saved profile if one exists, otherwise signed out |
| `--anon` | signed out, ignoring any saved profile |
| `--auth` | fail unless a saved profile exists |
| `--local` | your own Chrome over CDP, with whatever it is logged into |

`--anon` is the honest way to check a lesson is reachable by a logged-out
visitor — worth running before publishing a lesson for a public site, since
your own profile may be signed in and hiding that a step needs an account.

### When you do need a login

One profile holds every cookie, so sign into everything at once:

```bash
node author.js capture-profile --sites "Google, GitHub"
```

Use throwaway accounts — cloud browsers trip Google's "this browser may not be
secure" check. `node author.js open --doc <url>` prints which identity it got.

### What generation produces

`app` comes from the profile, so the lesson is automatically scoped to the app
it was explored on. `navigates` is set when any step's click changed the page's
route, which is what keeps a multi-page GitHub lesson from cancelling itself.
Neither needs to be written by hand.
