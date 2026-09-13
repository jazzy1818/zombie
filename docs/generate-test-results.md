# Runtime lesson generation results

Run: 2026-09-13T07:52:17.797Z

Browser: 151.0.7922.34

Unpacked extension: ooeejodeleomehdkhfiaoiphpecnoomg

Result: **56/56 checks passed**.

The real extension is loaded from its manifest in a disposable copy. Only the bridge base URL is changed to a local server on an operating-system-assigned port. The production extension files and live bridge on port 7777 are untouched. The panel, matcher, lesson index, teaching adapter, paint and viewer are the production implementations. Stub job responses replace cloud authoring; deterministic live-player and recording-player HTML exercise the real iframe lifecycle and controls without paid cloud sessions.

For the public HTTPS fixture only, authoring JSON routes (`/health`, `/generate`, `/jobs/...`) are supplied through the test fixture because fresh-browser local-network permissions can block the existing content-script authoring request. Replay iframe navigation and its local player requests remain real network requests through the production extension wrapper. This verifies HTTPS replay access without claiming to verify authoring local-network permission setup.

- PASS: An unmatched question offers to generate when a bridge is reachable
- PASS: A partial match offers its shortlist and puts "None of these" last
- PASS: "None of these" sends the original question to the cloud browser
- PASS: A question matching nothing offers no guesses, only generation
- PASS: A matched question is offered, and choosing it never contacts the bridge
- PASS: With no bridge running the panel degrades to the plain picker
- PASS: The agent's trail streams into the panel while it works
- PASS: The generated lesson is taught as soon as it arrives
- PASS: Teaching the generated lesson drives the real page, not a mock
- PASS: Asking again is answered from the index without a second cloud run
- PASS: A failing generation reports the reason instead of hanging
- PASS: Stop during generation cancels and leaves nothing running
- PASS: The cloud viewer opens while waiting, then becomes live without a new progress entry
- PASS: The viewer loads cross-origin content even when the website CSP disallows frames and connections
- PASS: A public HTTPS website can open and reopen a completed recording under restrictive CSP
- PASS: The web-accessible recording wrapper rejects arbitrary local and remote destinations
- PASS: Playback waits for a real player signal and rejects the wrong source and origin
- PASS: Playback errors recover in place while a closed session stays closed
- PASS: Minimize unloads the viewer and keyboard reopen preserves the same generation job
- PASS: A retry replaces the live URL without requiring more progress or another generation request
- PASS: The primary live trigger leaves recording history and reopens the second attempt
- PASS: A second-attempt startup error reconnects its iframe automatically and becomes ready
- PASS: A second live connection recovers from get-state without requiring another ready event
- PASS: A silent second-attempt startup uses the bounded readiness timeout and recovers
- PASS: Minimizing cancels a scheduled second-attempt reconnect until the user reopens it
- PASS: Selecting an older recording cancels the second live attempt reconnect
- PASS: Switching to another live session cancels retries for the previous browser
- PASS: Live reconnects stop after three retries and a manual retry can recover
- PASS: Second-attempt autoplay blocking stays explicit and a manual retry opens a fresh live view
- PASS: Second-attempt playback ignores late messages from an earlier session view
- PASS: A closed remote session unloads its stale iframe and presents the viewer state
- PASS: Unavailable viewer metadata removes the old frame while the authoring job continues
- PASS: A disconnected bridge unloads a stale viewer and recovers on the next successful poll
- PASS: A completed generation retains its recording until the user clicks Done
- PASS: A failed generation retains its recording after closing the error panel
- PASS: Switching a completed viewer to its recording preserves the website focus
- PASS: A minimized recording trigger transfers keyboard focus to the arriving lesson
- PASS: Recording processing and recovery continue independently after job polling has ended
- PASS: Escape inside a recording minimizes it while untrusted minimize messages are ignored
- PASS: Closed attempts remain selectable while a newer cloud browser is running
- PASS: Stop clears a released recording and stops waiting for the remaining authoring work
- PASS: Starting a new lesson clears the previous recording history
- PASS: A new cached question clears previous recordings without generating again
- PASS: A new generation clears old recording history and ignores a delayed old job result
- PASS: Late recording readiness cannot restore history after a new generation replaces it
- PASS: Route navigation after declining a lesson clears retained recording history
- PASS: A full redirect clears retained recordings from the previous page
- PASS: Recording URLs must use the bridge port and exact opaque replay-player path
- PASS: Recorded-session controls and the persistent launcher remain usable on a narrow viewport
- PASS: Stop closes the viewer and stops polling without starting a lesson later
- PASS: Closing the teaching panel also releases the viewer and its polling
- PASS: Replacing generation with a lesson removes the viewer and blocks old job callbacks
- PASS: Same-page route navigation clears the viewer and prevents stale job updates
- PASS: A full page redirect removes the previous cloud browsing context and polling
- PASS: Untrusted, credential-bearing and non-HTTPS viewer URLs never become iframe requests
- PASS: The cloud window fits a narrow viewport and its minimize action stays keyboard accessible

Unexpected page or extension console errors: 0.

Expected negative-path console reports: 2.
- [browser-teacher] Error: I explored but could not find a reliable way to do that.
- [browser-teacher] Error: I explored but could not find a reliable way to do that.

Scope: this proves the production UI can load live and recorded player iframes under restrictive page CSP, consume job metadata, retain recordings until Done, Stop or a new task, and clean up stale views across lifecycle transitions. Live fixtures model per-session ready, connected/state, autoplay-blocked, error and silent-start signals with real retry timers; they do not perform WebRTC or prove actual video/autoplay recovery. Recording HTML is a deterministic fixture; the backend suite separately checks the actual replay player and authenticated HLS proxy. These checks do not prove live Steel availability, authentication, video encoding, or current framing response headers.

Screenshots, temporary extension copies and disposable browser profiles are saved under ignored `docs/.paint-artifacts/`. Run with Playwright on `NODE_PATH` and a Chromium/Chrome for Testing executable in `CHROME_PATH`.
