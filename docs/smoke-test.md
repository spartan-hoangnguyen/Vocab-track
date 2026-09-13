# Vocab-track — manual smoke test

Everything here needs a real browser. Automated checks cover the pure logic
(`bash test/run.sh`, 55 assertions), but no subagent can load an unpacked
extension, so the Chrome-facing behaviour was never exercised before you run it.

Ranked by how likely it is to break, from the final whole-branch review.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked**
2. Select `~/work/Vocab-track` (the folder containing `manifest.json`)
3. Pin the extension — the toolbar icon is how you open a review session

While iterating: reload the card after changing `manifest.json` or
`service-worker.js`; reload the card *and* the page after changing
`content-script.js`; reopen the panel after changing `sidepanel.*` or `lib.js`.

## The checks

1. **Floating button position.** Open a long English article, select a word in
   the middle of it. The 📘 button must appear just below the word. If it
   appears at the bottom of the page instead, the `all:revert` ordering in
   `content-script.js` has regressed. Also try a page whose `<body>` has a CSS
   `transform` or `position: relative` — the button's coordinate maths assumes
   the initial containing block.

2. **Highlighting.** This is the one core feature with no evidence either way:
   `CSS.highlights` plus `document.adoptedStyleSheets` from a content script's
   isolated world could not be verified outside a browser. Save a word, reload
   that page, and confirm the yellow highlight paints. If it does not, the
   likely cause is the isolated-world stylesheet not being adopted by the page
   document; the fallback is a `<style>` element, which the spec deliberately
   avoided. Also try a page that assigns `document.adoptedStyleSheets` itself.

3. **Unknown word.** Look up `zzqqxwv`. The panel must say it is not in the
   dictionary and save nothing. If it saves an entry whose play button
   pronounces "articulate", the not-found detection has regressed — Cambridge
   redirects unknown words to its index page, whose Word-of-the-Day block
   supplies a stray IPA and mp3.

4. **Toolbar opens Review.** Look up a word, close the panel, then click the
   toolbar icon. It must open on Review, not redisplay the word you just looked
   up.

5. **Audio.** Play a word with a Cambridge mp3. If the CDN refuses the request
   from an extension origin, `speechSynthesis` should speak it instead —
   confirm you hear something either way.

6. **Two words in quick succession.** Look one up, and before it finishes look
   up another. Both must appear in the Words tab.

7. **Grade, re-look-up, grade again.** Build a review queue, look the same word
   up again from a different page, then grade the card. The word must still
   highlight on both pages — this exercises the patch-based write path.

8. **Code blocks.** Visit a page with a syntax-highlighted code sample
   containing one of your saved words. It must not be highlighted inside the
   code block.

9. **A word with no CEFR level.** Look up `ubiquitous`. Level shows `—`; IPA,
   definition and translation still appear.

10. **Iframes — a known gap, not a bug.** Selections inside an embedded reader
    or comment widget produce no button, because `all_frames` is unset in the
    manifest. Decide whether you want it on.

## If something fails

The extension card's **service worker** link opens the worker's console (gesture
and panel-open errors). Right-click inside the side panel → **Inspect** for the
panel's console, where every `[vocab-track]` lookup error is logged.
