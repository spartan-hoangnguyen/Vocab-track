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

## On this page

Open a long article, save three or four words from different parts of it, then
open the panel's **On this page** tab.

A. It should list exactly the words saved on that URL, newest first, with the
   host named in the header. Words saved on other pages must not appear.

B. Click one. The page should scroll to it and flash it orange for a couple of
   seconds. Click another — the previous flash must clear rather than
   accumulate.

C. Click a word whose text is no longer on the page (edit the page in DevTools
   to remove it, or save a word then use the site's search to change the view).
   The row should dim and read "not on page" rather than doing nothing.

D. Switch to a different tab while the panel is open. The list should follow to
   the new page, not stay on the old one.

E. Open the tab on a `chrome://` page, the Chrome Web Store, or a PDF. It
   should say the page cannot be read, not fail silently — there is no content
   script on those.

## Dashboard

Open it from **Open dashboard →** in the side panel.

11. **It loads with your real words.** Totals, due count and median level should
    match what you actually have. A brand-new profile should show zeros and an
    empty "From reading" card rather than an error.

12. **Folders.** Create one, give it a colour, then add a word to it with the
    `+` chip in the All words table. The count on its card should go up. Rename
    it; the tag on the word should follow. Delete it; the word must survive and
    fall back to "From reading".

13. **"From reading" cannot be deleted** and has no Edit link. It is synthesised
    rather than stored, so it exists even on a fresh profile.

14. **Search.** Type part of a saved word — the table filters. Type a word you
    have never saved, e.g. `serendipity`, and it should offer to look it up on
    Cambridge and then appear in the table. ⌘K focuses the box, Escape clears it.

15. **Review.** Space reveals, keys 1–4 grade. Grade one card **Blank** — it must
    come back later in the same session, and the "N of M" counter must grow
    rather than lie. Check a folder's own **Review** link scopes the session to
    that folder.

16. **The panel and the dashboard stay in sync.** With the dashboard open in a
    tab, look a new word up from a page. The dashboard should update on its own,
    without a reload.

17. **Export, then import the same file back.** Nothing should duplicate, and
    your review schedules must be unchanged — import merges and deliberately
    never overwrites `ease`/`interval`/`reps`/`due`. Then edit the JSON to add a
    word by hand and re-import to confirm new entries are added.

18. **Statistics.** With only a few days of data the charts will be mostly empty;
    that is correct, not a bug. Confirm "Review load" folds everything overdue
    into today rather than spreading it backwards.

## If something fails

The extension card's **service worker** link opens the worker's console (gesture
and panel-open errors). Right-click inside the side panel → **Inspect** for the
panel's console, where every `[vocab-track]` lookup error is logged.
