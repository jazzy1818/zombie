# Runtime lesson generation results

Run: 2026-09-13T03:49:38.124Z

Browser: 153.0.8010.12

Result: **9/9 checks passed**.

The real extension is loaded from its manifest. The panel, matcher, lesson index, teaching adapter and paint are the production implementations. Only the authoring bridge is stubbed: the real one at `pipeline/bridge.js` drives a cloud browser for minutes per lesson. The stub serves the same routes on the same port.

- PASS: An unmatched question offers to generate when a bridge is reachable
- PASS: A matched question runs its lesson and never contacts the bridge
- PASS: With no bridge running the panel degrades to the plain picker
- PASS: The agent's trail streams into the panel while it works
- PASS: The generated lesson is taught as soon as it arrives
- PASS: Teaching the generated lesson drives the real page, not a mock
- PASS: Asking again is answered from the index without a second cloud run
- PASS: A failing generation reports the reason instead of hanging
- PASS: Stop during generation cancels and leaves nothing running

Uncaught page or extension console errors: 0.

Not covered here: the real bridge end to end against Google Docs, which needs Steel credentials and is verified by hand. See `pipeline/bridge.js`.
