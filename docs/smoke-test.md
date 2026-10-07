# Vocab-track — manual smoke test

Everything here needs a real browser. Automated checks cover the pure logic and
the layout (`bash test/run.sh`, seven pages in headless Chrome), but no subagent
can load an unpacked extension, so the Chrome-facing behaviour was never exercised before you run it.

Ranked by how likely it is to break, from the final whole-branch review.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked**
2. Select `~/work/Vocab-track` (the folder containing `manifest.json`)
3. Pin the extension — the toolbar icon toggles the side panel, and is how you
   open a review session

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

19. **YouTube captions.** Open any video, turn subtitles on (`c`), and click a
    word in them. The video must pause on that click, the panel must open with
    that word, and the "Seen in" quote must be the caption line — not the video
    title or a stray bit of page text. Clicking a caption word that is not a
    word (a number, a name with an apostrophe) must do nothing at all, and must
    not pause the video.

20. **The timestamp is the position.** For a word saved from a video, the panel's
    `↩ youtube.com` link must carry `&t=` and open at that second — and must
    *not* carry a `#:~:text=` fragment. Then save a second word later in the
    same video: the *On this page* tab must list both, and clicking each must
    seek the player to its own moment without changing whether it is playing.

21. **The shortcut is actually bound.** Open `chrome://extensions/shortcuts` and
    confirm Vocab-track has one — on macOS `Alt+Shift+R` is Option+Shift+R, and
    if another extension already claims it Chrome assigns nothing and says
    nothing.

22. **Speed read an article.** On a long news article with nothing selected, the
    reader must start at the first paragraph of the body — not a nav link, a
    cookie banner, or the comments. Then select two paragraphs and press it
    again: it must read only those.

23. **Controls.** `space` pauses and resumes, `←` steps back a word, `↑`/`↓`
    change the speed and the number on screen follows. Close and reopen: the
    speed must be remembered.

24. **The page behind must not react.** While the reader is open, `space` must
    not scroll the article or play a video, and the arrows must not scroll it.
    Try this on a YouTube watch page, which listens for exactly those keys.
    Then try it on a video **in fullscreen** — the reader must still paint above
    it.

25. **Escape lands you where you stopped.** Close mid-article: the page should
    be scrolled to the paragraph that was on screen. Also confirm
    double-clicking the flashed word does **not** pop the 📘 lookup button.

26. **A hostile page.** Run it somewhere with aggressive CSS — GitHub, a news
    site with a sticky header — and confirm the reader's own type, colours and
    layout are untouched, and that it covers the page completely.

27. **Mac capture, end to end.** Run `./tools/install-macos.sh`, assign the
    hotkey in System Settings, then select a word in **Preview or Kindle** — not
    Chrome — and press it. A notification must say "Saved to Vocab-track". Open
    the dashboard: a note at the top of Overview must report the word being
    looked up, and it must then appear in All words with its CEFR level.

28. **Capture with Chrome quit.** Quit Chrome entirely, capture two words, then
    start Chrome and open the dashboard. Both must arrive — the queue is a file,
    not a message to a running browser.

29. **A phrase, not a word.** Select "the resilient supply chains" and capture
    it. It must save **resilient** (the longest candidate, since nobody looks up
    "the") and keep the whole phrase as the "seen in" context.

30. **No dead links.** A word captured from Preview must show no `↩` source link
    in the panel or the dashboard — there is no page to go back to. Words saved
    from web pages must still show theirs.

31. **Uninstall is clean.** `./tools/uninstall-macos.sh`, then confirm
    "Save to Vocab-track" is gone from System Settings → Services, and that the
    dashboard still opens without errors.

## Typing the answer

42. **A card asks for the word, not the meaning.** Start a review. The card
    shows the Vietnamese and the definition, the box has focus, and the word
    itself is nowhere on the card. If the word was saved with a sentence, the
    word is replaced by `…` in it.

43. **A correct answer is one keystroke away from done.** Type the word, press
    <kbd>enter</kbd>: it says Correct, Good is ringed, and a second
    <kbd>enter</kbd> moves on. Two keys per card.

44. **A near miss is marked, not just failed.** Type the word with one letter
    wrong. The wrong letter is the only thing underlined, it says "almost", and
    Hard is the ringed grade — not Good.

45. **Blank means blank.** Press <kbd>enter</kbd> with an empty box: the answer
    appears, it says Skipped, and Blank is ringed.

46. **The number keys grade, they do not type.** After committing, press `3`.
    It grades Good rather than putting a 3 in the box. Before committing, `3`
    must type a 3.

47. **`r` replays the pronunciation** after the answer is showing, and types an
    `r` before it.

48. **A word with no meaning still works.** Import a word whose `vi` and `def`
    are both null. Its card shows the word with a Show answer button, as it did
    before this change.

## Practice, and what it does to the schedule

Practice used to be a dialog over the card that never wrote to the schedule.
Both halves of that changed: the modes are tabs beside the flashcard, and an
answer on a word that is **already due** is a real review.

90. **The modes are tabs, not a dialog.** Start a review. Under the progress
    bar is one row — **Flashcard**, Quiz, Listening, Fill the gap, Speak,
    Card Blast, Mix. Click **Quiz**: the question appears *where the card was*,
    the heading and the row above it do not move, and the *Keep going* cards on
    the right stay exactly where they were. Nothing opens on top of anything.
    <kbd>esc</kbd> puts you back on **Flashcard** with the card as you left it.
    ⛶ **Fullscreen** fills the screen with the panel; <kbd>esc</kbd> there
    leaves both the fullscreen and the tab in one press, so **Exit** is the way
    to the flashcard without losing the screen.

91. **A mode that cannot run says why, and still takes Tab.** Scope a review to
    a folder holding three words (a folder card's own **Review** link). **Quiz**
    is greyed. Tab to it anyway — it takes focus, and VoiceOver (⌘F5) reads
    *Quiz — Needs four words with a meaning* rather than just "dimmed". Click
    it: nothing starts, and the flashcard is still what is on screen.

92. **The round is yours to size.** **Length** offers 10 / 25 / All. Change it
    mid-round: the round restarts at the new length and the counter's
    denominator agrees with it — or with the number of words the mode can
    actually ask, when the folder holds fewer than that. Reopen the dashboard tomorrow — the length you
    chose is still chosen. <kbd>h</kbd> takes the hint, <kbd>?</kbd> gives up.

93. **The badge is the day's count.** Answer three Quiz questions, then go back
    to **Flashcard**: the Quiz tab carries `3/10`. Ten answers turn it into
    `✓ 10`. The badge is per mode, so Listening's is still empty.

94. **The summary drills what you missed.** Get two questions wrong on purpose.
    The end of the round lists both words with what the question told you, and
    **Drill the misses** asks exactly those two again — no third word.

95. **A due word is really reviewed.** Note a word that is due today: DevTools
    → Application → Extension storage → local → `words`, and write down its
    `stability`, `interval` and `due`. Answer it right in **Listening**. All
    three must move — `due` at least a day out — and a `history:<today>` key
    must now hold a `[word, quality, time]` row for it (`store.js:159`)
    carrying the grade: **4** from Listening or Speak, which ask you to
    produce the word — **5** if Listening was answered inside its six seconds —
    **3** from Quiz or Fill's pick variant, which offer you four to choose
    between, and **3** again if you pressed <kbd>h</kbd> first, however fast
    you then answered. Go back to
    **Flashcard**: the word is gone from the queue, because it is no longer
    due.

96. **A word that is not due is not touched.** Put one word whose `due` is a
    week out in a folder of its own, review that folder, and answer it right in
    **Listening** ten times over — **Again** at the end of each round. Its
    `stability`, `difficulty`, `interval`, `reps` and `due` must read exactly
    as they did before, and `history:<today>` must hold no row for it. Scope
    matters here: the queue asks due words first, so an unscoped round of ten
    never reaches a word that is a week out. The same must hold for a card you
    have never been shown — an imported word with `reps: 0`: practice moves a
    schedule, it never begins one.

97. **A game is still a game.** Play **Card Blast** on that same due word: blast
    one card, let one fall. Nothing in `words` changes and no `history:` row
    appears — only the tab's own badge and the best score, which is kept per
    language, so an English best does not show in a Korean session.

## The toolbar icon

40. **It toggles.** Click the pinned icon: the side panel opens. Click it
    again: the panel closes. A third click reopens it. This needs the
    extension reloaded — `openPanelOnActionClick` is set on worker wake, so a
    profile that ran an older build keeps the old behaviour until then.

41. **The dashboard is still reachable.** With the panel open, click
    **Open dashboard →**. It opens, and clicking it again from the panel
    returns to that same tab rather than opening a second one.

## Writing

These need a reload of the extension: `nativeMessaging` aside, the writing
check adds a new `host_permission` and a new content script, and Chrome does
not apply either to a tab that was already open.

32. **It underlines in a plain textarea.** Open a GitHub issue comment box,
    type two sentences with a mistake in each (`I have went there and buyed
    two apple.`), stop typing. About a second later the wrong words get a red
    wavy underline, and the underline sits **under those words**, not beside
    them. Scroll the textarea: the underlines scroll with the text.

33. **It underlines in a rich editor.** Same in a Gmail compose window. Then
    resize the window — the underlines must stay on their words.

34. **The fix applies and undoes.** Click an underlined word, pick a
    replacement. The field text changes, and **Cmd-Z puts it back**. In Gmail,
    confirm the draft still sends the corrected text (it is the framework
    seeing the edit that this checks).

35. **Short and secret fields are never checked.** Type into a search box, a
    username field and a password field. Nothing is ever underlined, and the
    worker console shows no request for them. Then type 40+ characters into a
    search box — still nothing.

36. **The switch works everywhere at once.** With a compose window open in one
    tab, turn the toggle off in **Dashboard → Writing**. Go back and type: no
    underlines, without reloading the tab. Turn it back on.

37. **Per-site off.** Add the hostname in **Dashboard → Writing**, then type on
    that site. Nothing is checked. Remove it again.

38. **The mistake count is the point.** After correcting a few errors, open
    **Dashboard → Writing**. The list names rules you actually broke, ordered
    by how often. Leave one error uncorrected and keep typing around it for
    half a minute: its count must **not** climb with every pause.

39. **The rate limiter holds.** Open five tabs with compose boxes and type in
    all of them. Nothing breaks, and at worst a check is skipped and comes
    back on the next pause; the worker console must not fill with 429s.

## Word lists

49. **The import does not freeze the dashboard.** **Dashboard → Import** →
    `data/ielts-c1-c2.json`. The note reads *Imported: 1945 new, 0 merged*
    within a few seconds, not a minute — one write, not one per word.

50. **It arrives as a course, not a wall.** Open **Review**. The session is
    twenty cards, not two thousand. **Folders** shows *IELTS C1* and
    *IELTS C2* with their full counts.

51. **A folder can be studied, not just browsed.** Click *IELTS C1* in
    **Folders**. The header shows **Review N due**; press it and the review
    card says *Review · IELTS C1* and only asks C1 words. Finish them, come
    back: the button now reads **Learn 20 new**, and pressing it starts twenty
    words you have never seen. Finish those and the end screen offers
    **Learn 20 more** without leaving the review.

52. **An imported card is a real card.** A card shows the Vietnamese gloss, the
    definition, and an example sentence with the word blanked to `…` — never
    the word itself. After committing, the play button speaks it.

53. **Importing twice changes nothing.** Import the same file again: the note
    reads *0 new, 1945 merged*, and a card you had already graded keeps its
    schedule (its due date does not jump back to today).

## Quiz a highlighted word

54. **A highlighted word is clickable.** On a page with saved words painted
    yellow, click one. The panel opens on **Quiz** with that word and four
    Vietnamese meanings. If it opens on **Word** instead, `quizOptions`
    returned null — you have fewer than four saved words with a translation.

55. **A saved word inside a link does not navigate.** Save a word that appears
    inside an `<a>` on some page, reload, and click it. The panel must quiz you
    and the browser must stay on the page.

56. **The 📘 button must not quiz the line below.** Select a word on a line
    directly above a highlighted one and click 📘. The panel shows the word you
    *selected*, not the highlighted word the button was sitting over.

57. **Selecting still beats clicking.** Drag-select across a highlighted word.
    The 📘 button appears and no quiz fires from the click that ends the drag.

58. **Code blocks stay inert.** A saved word inside a syntax-highlighted code
    sample is not highlighted, so clicking it must do nothing at all — no
    panel, no `preventDefault` stealing the click.

59. **A wrong answer corrects you.** Pick a wrong meaning: it goes red, the
    right one goes green, the rest freeze. **Full entry →** shows the whole
    dictionary entry; **Next word** asks about another.

60. **The quiz never grades you.** Note a word's due date in the dashboard,
    answer it wrong in the quiz three times, and check again — the date, ease
    and interval must be unchanged. The schedule only moves in **Review**.

61. **The tab stands alone.** With nothing clicked, open **Quiz** from the tab
    bar. A question appears by itself, drawn from the words that are due.

## Retiring a word, and the whole entry on the card

62. **Don't ask again takes a word out of the rotation.** Start a review and
    note the **Due today** figure on the overview. Press **Don't ask again** on
    a card: the next
    card appears at once, and the overview figure is one lower. The session
    counter (`49 of 75`) moves on rather than repeating the word.

63. **A skipped word is not deleted.** Open **All words**: the word is still
    there, with a *Skipped ↩* tag beside its folders. Search still finds it,
    and it still highlights yellow on the page it came from.

64. **It survives a reload.** Reload the dashboard and start a review: the
    skipped word is never offered, including from **Learn 20 more** and from a
    folder-scoped review of a folder it belongs to.

65. **The way back is one click.** Click the *Skipped ↩* tag. The tag goes, and
    the next review asks about the word again.

66. **The Cambridge button never leaks the answer.** On a card you have not
    answered, there is no **Cambridge ↗** anywhere on it — the card asks for the
    English word and that URL contains it. Answer, and the button appears under
    the word; it opens that word's Cambridge page in a new tab.

67. **Full entry holds what the prompt had no room for.** Answer a card for a
    word with more than one Cambridge sense (`strategy`, `leverage`). **Full
    entry** opens to the meanings beyond the first — each with its level and
    example — and the synonym/opposite chips. The first definition, which was
    already the prompt, is not repeated. Open it on one card and grade: the next
    card's drawer is open too.

68. **A thin word offers no drawer.** A word saved while Cambridge was down has
    one definition and no cross-references — its card must show no **Full
    entry** control at all, not an empty one.

69. **Tag a word right after you learn it.** Answer a card. A **# Tag** button
    appears next to the play button (never before the answer). Press `t`: the
    picker opens with the 16 preset topics, greyed as suggestions. Type `polit`
    and press Enter — *Politics & Government* is ticked. Press `3` while the
    picker is open: nothing is graded.

70. **A new name makes a new folder.** Type `IELTS Task 2`, press Enter. It is
    created and ticked. Press Enter on the empty box: the picker closes, the
    card's button reads *# Politics & Government, IELTS Task 2*, and the card is
    still waiting for its grade.

71. **Tags are folders.** On the Overview, both folders appear with one word;
    the other presets do not. Open one: the word is in it. Untick a tag from the
    word card's **+** in All words: the word leaves that folder, the folder stays.

72. **File a word while you read.** Look a word up from a page. Under the links
    in the side panel, **Topics** has an *Add a topic…* box. Pick *Science* from
    its suggestions: it becomes a chip at once, with no Enter needed. Type a new
    name and press Enter: that folder appears on the dashboard's Overview. Click
    a chip to take the word back out.
73. **Folder progress.** On the Overview every folder with words shows a
    three-part bar and `N learned · N learning · N new`. Grade a new word in a
    folder: its "new" count drops by one and "learning" rises by one.
74. **Pin a folder.** Hover a folder card and click 📌. The card moves up under
    **Pinned** and leaves All folders. Click 📌 again: it goes back, and the
    Pinned heading disappears.
75. **Suggestions.** With words due, **Suggested for you** shows up to three
    folders, each with its reason (`12 due today`, `3 misses in practice`,
    `8 in progress · 40% learned`). A pinned folder is never suggested.
    Check both themes.
76. **FSRS scheduling.** Review a new word and press Good. Inspect the page
    (DevTools → Application → Extension storage → local): the word now has
    `stability`, `difficulty` and `lastReview`, and is due in 2 days. A key
    `history:<today>` holds a `[word, 4, time]` row.
77. **Old words keep their schedule.** A word reviewed before this change
    still shows its old due date on the Words table until you grade it again.
78. **Mastery preview.** On the review's Mastery card, the faint arc grows as
    words get longer intervals, before anything is mastered. Once a word is one
    Good away from mastery, the line under the ring says how many and when.
79. **Review forecast.** Statistics → Review load: each bar is one day, with
    the lighter top being new words. Hover a bar: `N reviews + N new`. Under
    the chart: the average a day and the busiest day. Learn 20 new words, come
    back: the next two weeks grow, including days 2 and ~13 after today.

## Korean: what the browser does with Hangul

Two questions the automated suite cannot reach at all, because neither is about
anything this repo computes — both are about what Chrome itself does with the
text. `lang/ko/index.js` was written without knowing either answer.

80. **Double-click segmentation.** Open a Korean article and double-click a
    noun carrying a 조사 — `책을`, `학교에서`, `친구에게`. **Write down which
    one Chrome selected**: the whole 어절 (`책을`) or the bare noun (`책`).
    Chrome segments with ICU, which has a Korean dictionary in it, so either is
    plausible, and the answer decides how much of the 조사 stripper the click
    path exercises at all. Whichever it selects, the word saved must be `책` —
    `lemma()` strips the particle when there is one and is the identity when
    there is not. A key of `책을` in storage (DevTools → Application →
    Extension storage → local) means the pack never ran on that path: either
    `LANG.detect` did not match the script, or `resolveWord` was handed the
    selection without `lemma()`. Then drag-select just `책` on the same page —
    it must merge into the one entry rather than make a twin.

81. **An IME Enter must not grade the card.** Start a Korean review, switch to
    2-Set Korean, and type the answer. While the last syllable is still
    composing — underlined, not yet committed — press Enter **once**. It must
    commit the syllable and do nothing else: the card stays unanswered with the
    whole word in the box, and a second Enter is what submits it. If one Enter
    both commits and grades, the answer was checked with a jamo still pending,
    so a correct word is marked wrong and `suggestedGrade` turns that into a 0.
    The shape of the guard `practice-blast.js:207` carries —
    `if (e.key !== 'Enter' || e.isComposing) return;` — is a **keydown**
    listener, and that is the shape the fix has to take. `#rv-type` is a form
    whose only Enter path is the `submit` handler at `dashboard.js:1245`, and a
    `SubmitEvent` has no `isComposing` at all, so the same line copied there
    would read `undefined` and never fire. The card needs its own keydown
    listener on the input. Try both the macOS IME and Chrome's own; they do not
    always agree.

## Korean: the starter list, and folders that know their language

The one place the language scoping can be checked against real data rather
than a fixture. Import first; 82 is the acceptance test for the whole change.

82. **A Korean import lands, and says where.** Dashboard → **Import &
    export** → import `data/ko/starter.json` from an **English** session. The
    note must read *Imported: 3896 new, 0 merged with existing entries. In
    Korean — switch the language toggle to see them.* Nothing on screen changes
    yet, and that sentence is the only reason that is not alarming: the words
    are filed under Korean folders and the session is showing English.

83. **The toggle reaches the folder grid, not just the words.** Flip to **한**.
    *All folders* shows **초급 669**, **중급 1,395**, **고급 1,832**, plus
    *From reading* and *Starred*. **IELTS C1, IELTS C2, Phrasal A1 and Phrasal
    A2 must all be gone** — that is the bug this change exists for, and an
    empty card with a `0 words` count is the old behaviour, not the new one.
    The subtitle counts the folders you can see. Flip back to **EN**: the
    English folders return and the three Korean ones go.

84. **A card from the list.** In **한**, open 초급 and review one. The meaning
    is a Vietnamese gloss; the level chip reads 초급, not a CEFR band; the
    level bars on the Overview are labelled 초급/중급/고급 and have words in
    them. The pronunciation row on the side panel says **한국어**, never UK.
    About seven cards in ten also carry a collocation with the word blanked
    out; the rest ask from the gloss alone.

85. **A folder scope cannot outlive its language.** In **EN**, open *IELTS C1*
    so the words view is scoped to it. Flip to **한** without leaving the view:
    the title falls back to *All words* rather than sitting over an empty list
    under an English folder's name. *From reading* survives the same flip — it
    belongs to every language.

86. **The tag picker offers only this card's language.** Review a Korean card,
    press **t**. *IELTS C1* must not be in the list; 초급 must be. Do the same
    on an English card and the offers swap. Typing an English folder's name by
    hand still files it there — that is the deliberate way to make one folder
    hold both, and once it does, it shows in both sessions.

87. **A failed translation names itself.** Open DevTools on the side panel,
    Network tab, and set it to **Offline**. Look up a new Korean word. The
    card must carry a red banner reading *Translation failed… look the word
    up again to retry*, with the browser's own error text on the end — not a
    bare `—`, which is what a word with no translation looks like. Go back
    online, look the same word up again: the banner goes and the gloss fills
    in.

88. **A word whose gloss never arrived repairs itself.** Find a Korean word
    saved with **—** where the Vietnamese gloss should be (the translation
    endpoint rate-limits, so one will turn up). Click it again on a page, or
    look it up from the dashboard. The gloss fills in, and DevTools → Network
    shows exactly one `translate_a/single` request. Click a word that already
    has a gloss: no request at all, and the gloss does not change.

89. **The Korean voice is the good one.** Press ▶ on a Korean card. It must
    not be a novelty voice — Eddy, Rocko and Grandma are cartoon voices macOS
    ships beside Yuna, and Chrome used to pick among all nine. Download
    **Yuna (Enhanced)** (System Settings → Accessibility → Spoken Content →
    System Voice → Manage Voices → Korean) and press ▶ again: it should switch
    to the enhanced recording without any setting being touched.

## Chinese: lookup

90. **Double-click segmentation.** Open a Simplified Chinese article
    (zh.wikipedia.org) and double-click inside a two-character word such as
    `学生` or `中文`. **Write down what Chrome selected.** Chrome breaks words
    with ICU, the same dictionary `Intl.Segmenter` uses in `lang/zh/index.js`,
    so it should select the same unit the highlighter matches — `学生`, not one
    character and not the whole sentence. ICU glues some one-character words
    to a neighbour (`我是`, `他在`), so a double-click there selects both
    characters; drag-select to get one.
    *Answer (fill in):* ______

91. **A Chinese word saves under zh with a gloss.** Select `学生` → the 📘
    button appears. Click it: the panel shows the Vietnamese gloss *học sinh*,
    no "lookup failed" warning, and a *full entry ↗* link to mdbg.net. In
    DevTools → Application → Extension storage → local, the entry carries
    `lang: "zh"`, and the panel's Network tab shows the `translate_a/single`
    request with `sl=zh-CN`. Look up an English and a Korean word next: their
    requests still say `sl=en` and `sl=ko`.

92. **Japanese with kana is not offered.** On a Japanese page, select `食べる`
    → no 📘 button. A kanji-only selection (`学生` on a Japanese page) does get
    one and is treated as Chinese — a known limit.

## If something fails

The extension card's **service worker** link opens the worker's console (gesture
and panel-open errors). Right-click inside the side panel → **Inspect** for the
panel's console, where every `[vocab-track]` lookup error is logged.
