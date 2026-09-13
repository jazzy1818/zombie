# Runtime lesson generation results

Run: 2026-09-13T09:53:47.996Z

Browser: 141.0.7390.122

Result: **17/17 checks passed**.

The real extension is loaded from its manifest. The panel, matcher, lesson index, teaching adapter and paint are the production implementations. Only the authoring bridge is stubbed: the real one at `pipeline/bridge.js` drives a cloud browser for minutes per lesson. The stub serves the same routes on the same port.

- PASS: An unmatched question offers to generate when a bridge is reachable
- PASS: A matched question runs its lesson and never contacts the bridge
- PASS: With no bridge running an unrelated question is refused honestly, not padded with lessons
- PASS: A near miss offers only the related lesson, plus a way to say it is none of them
- PASS: The bridge's model ruling a lesson out still leaves the near miss on offer
- PASS: A ruled-out question with no near miss offers nothing but generation
- PASS: The bridge's model can pick a lesson, and its preamble offers a way out to generation
- PASS: An ambiguous question keeps only the best two or three related saved tasks
- PASS: Rejecting a selected near match preserves the original question for generation
- PASS: Related suggestions can be rejected when the authoring bridge is offline
- PASS: A new question replaces old suggestions instead of accumulating them
- PASS: The agent's trail streams into the panel while it works
- PASS: The generated lesson is taught as soon as it arrives
- PASS: Teaching the generated lesson drives the real page, not a mock
- PASS: Asking again is answered from the index without a second cloud run
- PASS: A failing generation reports the reason instead of hanging
- PASS: Stop during generation cancels and leaves nothing running

Uncaught page or extension console errors: 0.

Not covered here: the real bridge end to end against Google Docs, which needs Steel credentials and is verified by hand. See `pipeline/bridge.js`.
