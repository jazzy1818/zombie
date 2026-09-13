# Demo script

The original pitch script is in [PLAN.md §14](../PLAN.md). Use
[testing-workflow.md](testing-workflow.md) for current setup and commands; the
sequence below reflects the integrated extension and current lesson files.

## Integrated extension rehearsal

1. Reload the unpacked `extension/` in Chrome and refresh the website tab.
2. On the local extension fixture, run the practice JSON through the Browser Teacher
   console context as shown in the testing guide. The normal button, nested scroller,
   menu, two-step modal and redirect exercise the real extension's panel and paint.
3. On a prepared editable Google Doc, type **How do I add an automatic table of
   contents?** in the chat bar and choose **Teach me**. The panel offers what the
   question matched rather than starting anything; choose **Add an automatic table
   of contents**, then **Show me**.
4. The user clicks every highlighted control, including the first demonstration.
   At the document-title instruction, click the actual title line, then **Got it**.
5. At s3, deliberately click Font once, then follow the correction. Continue through
   Heading 1 and Heading 2. The solo sequence is **s7 Insert → s8 Page elements →
   s9 Table of contents**. Check the resulting document; reaching the ending card
   alone is not proof that its contents are correct.
6. Rehearse **Stop** during guidance and restart through the chat bar. Confirm no
   old cursor or later step reappears.
7. For the version-history lesson, ask **How can I find and name a version of my
   document?** Its four steps reach **Name this version**. The current final step
   verifies only the click, so entering/saving a name remains a manual outcome check.

These live application steps are a rehearsal checklist, not a claim that this
checkout has been tested in a signed-in Google Docs session.

## D's standalone visual demonstration

For renderer-only diagnosis, serve the repository root and open
`docs/paint-harness.html` as described in [paint-integration.md](paint-integration.md).

1. Click **Highlight primary action**. Explain that A will supply this element;
   the fixture supplies it directly for this isolated demonstration.
2. Let the highlight sit for two seconds, then click **Publish** yourself. The
   page counter increments and all guidance effects disappear.
3. Click **Highlight nested target**. The panel smoothly scrolls to the button,
   then the ghost cursor moves there. Scroll inside that panel: the outline and
   cursor track the button, disappear out of view, and return when it reappears.
   The page stays dimmed throughout.
4. Try **Wrong-click pulse** to show D's red effect. This manually invokes paint;
   the integrated teaching adapter obtains the actual wrong control from the
   trusted click event and supplies it to the same effect.
5. Click **Switch website layout**, then highlight the primary action again.
   The same paint code handles the changed presentation.
6. Click **Clear visuals**. Both spotlight and cursor disappear.
7. Try **Guide me down the page** to see smooth window scrolling.
8. Start **Guide me in a modal**. Wait for the prompt, click the highlighted
   **Open modal fixture** yourself, then follow step 2 to **Confirm in modal**.
9. Start **Try a 3-step guide**. Click Preview, then Options, then Schedule
   publication. A wrong click must not skip a step.
10. Try **Try next-page cleanup** and follow the link. The new page starts without
    the previous guide. Use the browser Back button to return to the workshop.

This demonstrates D's rendering only. Do not present the fixture as a working
resolver, generated lesson, or completed Chrome extension.

## Setup checklist

- [ ] Measure the local **viewport**, targeting **1440×900**. C measured Steel's
      current viewport at **1435×809**, so record both rather than assuming the
      requested window size equals page content size.
- [ ] Prepared Google Doc open, headings NOT yet applied
- [ ] Extension loaded unpacked, panel mounts, no console errors
- [ ] Steel session pre-warmed (or the live run already kicked off — see below)

## The beat that matters

At the first `guided` step, **let two full seconds of silence run** with the
highlight sitting there, waiting. Do not fill it. Do not narrate over it.

That pause is the entire product. If a judge instinctively reaches for their own
trackpad, we've won.

## Deliberate mistakes

- Step **s3**: click the **Font** box on purpose → shows the wrong-click correction
- Steps **s7–s9** are `solo` — hunt through `Insert → Page elements → Table of contents`

## Live Steel segment

2–3 steps, ~40 seconds, narrated over the session viewer. A full lesson takes
2–4 minutes to generate, which kills a 5-minute demo — so either keep it
trivially shallow, **or** kick it off at the very start and return to it at the
end as a callback.

## Rehearsal log

_(who ran it, what broke, how long it took)_
