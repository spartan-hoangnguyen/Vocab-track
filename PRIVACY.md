# Vocab-track privacy policy

Last updated: 2026-10-12

Vocab-track is a Chrome extension for learning vocabulary while you read. This
page says what it keeps, what it sends, and to whom. It covers the version in
the Chrome Web Store.

## What it keeps, and where

Everything Vocab-track keeps is in `chrome.storage.local`, in the Chrome
profile you installed it in. That is your saved words, the sentence you met
each word in, the address of the page it came from, your review schedule, your
folders, the writing mistakes you make most often, and your settings. None of
it is uploaded. There is no account, no sync and no Vocab-track server.
Removing the extension deletes all of it.

An export is a file you save yourself. It goes where you put it and nowhere
else.

## What leaves your browser

Five things leave your browser, each only when you do something that needs it:

| When | Goes to | What is sent |
|---|---|---|
| You click an English word | `api.datamuse.com` | the word |
| You click any word | `translate.googleapis.com` | the word, for the Vietnamese gloss |
| You stop typing, with the writing check on | `api.languagetool.org` | the sentence you typed |
| You play a pronunciation | the host on the card | nothing — the audio file is streamed from the URL stored with the word |
| You press **Find GIF** on a review card | `api.giphy.com` | the word, or its Vietnamese gloss for a Korean card |

Each of these services gets the request directly from your browser, so it also
sees your IP address, as with any web request. Their own privacy policies
apply to what they do with it.

**The writing check is on when you install.** It checks the English you type
into text boxes on web pages and underlines mistakes. It sends text only from
plain text fields, text areas and editable areas, and only once a field holds
at least 40 characters. It never reads password, email, URL, phone, number or
search fields, or any field the page marks as `autocomplete="off"` or as a
one-time code. To stop it, open the dashboard, go to **Writing**, and untick
**Check my writing as I type**; to stop it on one site only, add that site
under **Off on these sites** on the same page.

**GIFs are off until you add your own GIPHY API key.** The key stays in
`chrome.storage.local` and is never part of an export. Nothing is sent to
GIPHY until you press the button on a review card.

Korean sends nothing to krdict: the **krdict ↗** link opens a tab when you
click it. Opening the dashboard makes no third-party request; its fonts ship
inside the extension.

## What it does not do

- No analytics, no tracking, no advertising.
- It does not sell or transfer your data to anyone, and does not use it for
  anything other than the features above.
- It reads the page you are on only to find the word you clicked, its
  sentence, and your saved words to highlight. It sends nothing on its own.

## Contact

Questions or problems: open an issue at
<https://github.com/spartan-hoangnguyen/Vocab-track/issues>.
