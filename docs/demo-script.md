# Demo script

Full script in [PLAN.md §14](../PLAN.md). This file is the rehearsal notes.

## D's standalone visual demonstration

Before the integrated extension is ready, serve the repository root and open
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
   the integrated wrong-location route needs the team decision in the handoff.
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

- [ ] Normal Chrome window, **1440×900**. Measure it. A collapsed toolbar reads
      as a resolver bug on stage.
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
- Step **s6** is `solo` — no highlight, hunt for `Insert → Table of contents` unaided

## Live Steel segment

2–3 steps, ~40 seconds, narrated over the session viewer. A full lesson takes
2–4 minutes to generate, which kills a 5-minute demo — so either keep it
trivially shallow, **or** kick it off at the very start and return to it at the
end as a callback.

## Rehearsal log

_(who ran it, what broke, how long it took)_
