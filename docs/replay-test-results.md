# Completed-session replay checks

Run: 2026-09-13. Browser: Chromium 151.0.7922.34.

## Recording preparation and automatic recovery

**6/6 passed** using the production replay player, HLS.js and replay proxy in
real Chromium, with a locally generated 64 × 64 solid-blue MP4 fixture:

```powershell
node --test --test-isolation=none pipeline/replay-player-tests.mjs
```

Set `CHROME_PATH` if the test browser is installed elsewhere. The fixture contains
no user recording or document; this suite makes no Steel or model requests.
Playwright's browser clock advances the waits while actual local HTTP requests
and media decoding run normally.

- The player waits **1.5 seconds** before its initial request and recovers
  automatically when a processing response becomes playable media.
- Persistent failures stop after **five attempts**, using 1.5, 2.5, 4 and 6-second
  retry delays. Manual **Retry recording** starts a fresh attempt and can recover.
- An available manifest and initialization metadata do not count as ready while
  media fragments are still processing. Readiness requires playable video data.
- A stalled load is aborted when the **45-second overall startup budget** expires.
- `pagehide` cancels both the initial delay and a queued retry.
- `pagehide` aborts an active manifest request and prevents later attempts.

Playable media cancels startup timers and starts muted playback automatically.
The merge validation checks that playback advances and that manual retry can
recover. Existing playback controls remain active without the startup deadline
interrupting an already playable recording.

## Offline backend checks

**29/29 passed** across the session lifecycle and replay suites:

```powershell
node --test --test-isolation=none pipeline/session-viewer-tests.mjs pipeline/session-replay-tests.mjs
```

The tests cover retained recordings, retry/verification history, cleanup, local
player assets, processing/retry responses, rewritten HLS playlists, media byte
ranges, expired/unknown links, and rejection of unrelated hosts or sessions.
They verify that Steel keys and signed upstream media URLs stay server-side.
Their upstream responses are fixtures; they create no cloud sessions.

## Earlier existing Steel recording check

A separate read-only check, before the automatic-retry change, used an
already-released Steel session and the actual
replay service/player on an ephemeral local port. It created no session, ran no
model, modified no document, and left the user's running bridge untouched.

- Video decoded at **1440 × 900**, with a **28.15-second** duration.
- Playback advanced beyond half a second and reached video `readyState=4`.
- Escape emitted the minimize request. Native fullscreen retains its own Escape
  behavior.
- **Zero page errors and zero upstream failures** occurred.
- Upstream requests used only `api.steel.dev` and `fly.storage.tigris.dev`.

No API keys, signed media URLs, session IDs, recording files, or document content
were written into this report. This measures one available completed recording;
new recordings can take time to finish processing, and availability depends on
Steel and the running bridge.

## Extension integration

See [the generation/viewer report](generate-test-results.md) for production UI
checks, including recording retention, playback controls, minimize/reopen,
attempt selection, navigation, keyboard focus, and responsive layout.
Recordings stay available for the current task while teaching; **Done** and
**Stop** clear the recording button and history. Close, Not now and viewer
Minimize preserve recordings already received for that task.

Chrome's Local Network Access policy blocks a public HTTPS webpage from directly
embedding the HTTP loopback player. The extension therefore supplies a packaged
wrapper before navigating its inner iframe to the local player. The independent
compatibility audit verified that this path loads local HTML, executes its script,
and performs local fetches without changing browser security settings.
