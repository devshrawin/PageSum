# PageSum

A Chrome extension that summarises the page you are on, answers questions about it and shows where each claim comes from, using your own Google Gemini API key. It lives in the browser's **side panel** and follows the tab you are looking at.

> **Build status (v1.1.0, work in progress on `feat/v2`):** phases 1 and 2 of `SPEC_V2.md` are implemented: side panel, per-tab state, click-to-source citations, structured extraction, PDF, YouTube, screenshots, embedded frames and the opt-in context cache. Phase 3 (quick actions, guide mode, compare, history, and the Options page for the new settings) is **not built yet**. Sections below describe what works today. The full README rewrite (spec section 20) happens in phase 3.

_Screenshot: add one here._

## Get a free Gemini API key

1. Open https://aistudio.google.com/apikey
2. Click **Create API key**
3. Copy it

The free tier has per-minute and per-day request limits (shown only in AI Studio). On the free tier Google may use your inputs to improve its products, so don't summarise pages with sensitive data.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin PageSum to the toolbar, then click the icon (or press Alt+Shift+S). The side panel opens; paste your API key.

Needs Chrome 116 or newer.

## Site access explained

An extension can only read a page it has been given access to. PageSum asks for the least it can:

- **Click the icon (or Alt+Shift+S) on a tab:** one-time access to that tab (Chrome's `activeTab`).
- **Allow on {site}:** the panel shows this button when it can't read the tab you switched to. It grants access to that one site for good.
- **Allow on all sites:** optional; grants every site so the panel can follow every tab without asking. You choose.

Without a grant the panel shows "PageSum can't read this tab yet" and the three options above. Nothing is read from a tab you haven't allowed. (Revoking grants from the Options page is planned for phase 3; until then use `chrome://extensions` > PageSum > Site access.)

## Use

- The summary streams in when a page has stayed open in the panel for one second. Passing quickly through tabs (Ctrl+Tab) never spends your quota.
- Pick Short, Medium or Detailed. Ask follow-up questions at the bottom (Enter sends, Shift+Enter for a new line). "New chat" clears the conversation and keeps the summary.
- **Clickable sources:** the small numbered markers after claims are citations. Click one and the page scrolls to the passage and highlights it (Esc on the page or in the panel clears it). If the page changed, PageSum looks for the text again; if it is gone you get "That passage isn't on the page any more."
- Select some text on the page first to summarise just the selection.
- **Tables, headings, links:** PageSum reads tables as proper tables, the page outline, the main links and the labels of form fields (never what you typed), and sends that structure to Gemini with the text. Open shadow DOM and embedded frames are read too when the page allows it.
- **PDFs:** open a PDF (a web address or a local file) and PageSum sends the file to Gemini, up to 20 MB. Citations are page numbers; clicking one opens the PDF at that page. For local files turn on "Allow access to file URLs" for PageSum in `chrome://extensions`.
- **YouTube:** on a watch page PageSum gives Gemini the video's public address, so it can watch it. Citations are timestamps; clicking one jumps the video there. Videos over 20 minutes ask first, because they use a lot of your free quota. Gemini can only watch public videos. For a private or unlisted one, open the video's transcript ("...more", then "Show transcript") and press Retry: PageSum reads the transcript from the page instead. (The setting `youtubeMode: "transcript"` always does that.)
- **Screenshots:** when a page is mostly a chart, canvas or image with little text, a notice offers "Read from screenshot". It sends one downscaled JPEG of the visible area (nothing else) and says so in the summary. It needs the icon click on that tab, or the all-sites grant.
- Each tab keeps its own summary and chat. A stream keeps running if you switch tabs. If a page changes after its summary, a notice offers **Re-summarise** (it never re-summarises on its own).

## Settings

Open them with the gear icon (or the extension's Options). Today the Options page shows the v1 settings: API key, model, default length, language, max page characters, auto-summarise, clear cache. The v2 settings exist in storage with defaults and are honoured by the panel, but get their Options UI in phase 3: `citations` on, `structuredExtraction` on, `readFrames` on, `vision` "ask" (or "auto" / "off"), `youtubeMode` "video" (or "transcript"), `explicitCache` off, plus the history and sensitive-guard settings (phase 3).

- **Model:** presets, ids fetched with "Refresh models", or "Custom...".
- **Why Flash-Lite is the default:** `gemini-3.5-flash-lite` has the most generous free daily quota and summaries are an easy task.
- **Explicit context cache (`explicitCache`, off by default, paid tier only):** on the first follow-up question of a long page (about 130,000 characters or more, or a big PDF or video) the page is stored at Google for 15 minutes and later questions send only the new turns. It is not available for Flash-Lite on the free tier; if Google refuses, PageSum remembers that for 24 hours and carries on without it, silently. The cache is deleted on New chat, re-summarise, navigation and tab close. Implicit caching (automatic, free) needs no setting.
- **Max page characters:** 5,000 to 400,000. Longer pages are cut from the end, on a whole-paragraph boundary.

## Privacy and security

- Your API key is stored unencrypted in this browser profile's extension storage and is sent only to `generativelanguage.googleapis.com`, in the `x-goog-api-key` header (never in a URL, never logged).
- What is sent to Google, per feature: the page text (plus its title, metadata, outline, up to 40 link texts and addresses, and form field labels); the PDF file itself for a PDF; the video's public watch address for a YouTube video (and, in transcript mode, the transcript text you opened); one JPEG of the visible area for a screenshot; and, only if you turn the explicit cache on, the same content stored for 15 minutes. There is no analytics and no other server.
- Page text is **untrusted**: it sits inside a nonce-tagged block, the system prompt says never to follow instructions found in it, and a page cannot forge the closing tag or a citation id (`[c12`-style text in a page is defused).
- Model output is rendered by a small markdown parser that builds DOM nodes with `createElement`/`textContent` only. Raw HTML is shown as text and only `http(s)` links are clickable. Citation markers are buttons built the same way. A test enforces that no unsafe HTML API appears anywhere in `extension/`.
- **PageSum never acts on a page.** The code injected into pages cannot click, type, submit, navigate or change a field (a static test checks for it). It only reads text and draws a highlight. It has no message listener, so a web page cannot send it commands.
- Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, the Gemini host. Optional (asked only when you press a button): per-site or all-sites access, and later `tabs` for Compare.
- Summaries are cached in `chrome.storage.session` (cleared when the browser restarts).

## Limitations

PDFs larger than 20 MB are refused, and PDFs that are only in-page blob files can't be read. YouTube videos must be public (or use the transcript). Closed shadow roots and canvas text can't be read (the screenshot covers canvas). Clicking a citation that comes from an embedded frame highlights inside the frame without scrolling the outer page. Closing the panel stops generation.

## Development

Needs Node 21 or newer for the test glob (no install, no dependencies).

```
npm test            # node --test "tests/*.test.js"
powershell -File tools/pack.ps1   # dist/<yyyy-mm-dd>/PageSum-v<version>.zip
```

Layout: `extension/sw.js` (tiny service worker), `extension/sidepanel.*` and `extension/panel/*` (UI modules), `extension/content/*` (classic scripts injected on demand into pages), `extension/lib/*` (pure modules). Everything is plain JS/HTML/CSS with no build step.

Tests need no browser: pure modules are unit-tested; the content scripts run inside `vm` sandboxes against a fake DOM (`tests/helpers/fakedom.js`); `tests/tabs.test.js` drives `panel/tabs.js` with a fake `chrome.*` whose `executeScript` runs the real content scripts; the Gemini client is tested against a mock server (`tests/mock-gemini.js`).

## Manual checklist (needs Chrome and a real key; not run by the builder)

Phase 1 and 2 items, numbered as in SPEC_V2 section 16.4. Record pass/fail in the right column when run.

| # | Check | Result |
|---|---|---|
| 1 | Fresh load shows no errors on `chrome://extensions`. Clicking the icon opens the side panel with the key card. Save the key and the summary streams. Alt+Shift+S also opens it. | not run |
| 2 | Article page: the summary has numbered citation markers. Clicking one scrolls to and highlights the exact paragraph. Esc (on the page or in the panel) clears it. A marker in a chat answer works too. | not run |
| 3 | Edit the DOM in DevTools: move the cited paragraph's text elsewhere and the marker still finds it (fuzzy). Delete the text entirely: the "isn't on the page any more" toast shows. | not run |
| 4 | Switch tabs: the panel follows. Previously summarised tabs restore instantly. A tab with no access shows "can't read this tab yet"; "Allow on {host}" and "Allow on all sites" work. Clicking the icon on that tab works without a grant. | not run |
| 5 | Ctrl+Tab quickly through 5 tabs: no request is sent for tabs shown for less than a second (check the network panel). | not run |
| 6 | SPA (GitHub repo to a file view): in-app navigation resets the conversation for the new URL. Same-URL content changes show "This page changed since the summary." with Re-summarise. | not run |
| 7 | Start a summary on tab A, switch to B and back: A's summary is complete. | not run |
| 8 | Restricted pages (`chrome://extensions`, the Web Store, the new tab page) show the right message. A `blob:` PDF explains why it can't be read. | not run |
| 9 | Wikipedia page with tables: the summary and chat can use table rows, and a table citation highlights the table. | not run |
| 10 | Page with a same-origin iframe (a docs site with an embedded frame): its text appears in the summary under "Embedded frame". A cross-origin frame does not until "Allow on all sites". With partial permission the notice "Embedded frames skipped." shows and the page still summarises. | not run |
| 11 | PDF (https, for example arXiv): the summary has page citations and clicking one opens that page. A local PDF works with file access on and shows the file-access hint with it off. A PDF over 20 MB shows "Too large". A PDF you are not allowed to fetch shows "can't read this tab yet". | not run |
| 12 | Public YouTube video: summary with timestamp citations that seek the video. A video over 20 minutes asks first. An unlisted or private video shows "Video can't be read"; open the transcript, press Retry, and the summary uses the transcript. | not run |
| 13 | Canvas-heavy page: "Read from screenshot" is offered and works after an icon click; it shows "Screenshot not allowed" on a tab reached only by a per-site grant. | not run |
| 20 | Explicit cache on (needs a paid key): the second follow-up's request has `cachedContent` and no `systemInstruction`. On the free-tier Flash-Lite it silently falls back with no error card. | not run |
| + | In the panel and service-worker DevTools the key never appears in a URL or the console. | not run |
| + | Dark mode and a keyboard-only pass of the panel (Tab to citation markers, Enter activates). | not run |
| + | Reload the extension while a highlight is showing: the highlight disappears and the page console shows no errors. | not run |

Status: none of these have been run yet (needs a real browser and key).

## Open questions

Things the builder had to guess or could not verify. SPEC_V2 section 18 lists the larger risks; phase 1 specifics:

- **Version is 1.1.0, not 2.0.0.** A major bump has not been approved, so manifest and `package.json` say 1.1.0 and a test pins `1.1.x`. The spec text that says 2.0.0 was approved is ignored.
- **activeTab with the side panel (spec 18.1, unverified).** Whether `action.onClicked` -> `sidePanel.open` still grants `activeTab`, and whether the grant survives same-origin navigation, could not be checked without Chrome. The needAccess view with per-site grants is the fallback and may end up the main path.
- **Origin patterns use the hostname, not host:port.** "Allow on {site}" requests `https://example.com/*` so a port in the URL can never make `permissions.request` throw. It therefore covers all ports of that host.
- **No `tab.url` without access.** Chrome hides a tab's URL until the extension has access, so a restricted page like `chrome://extensions` can also appear as "can't read this tab yet" if the URL isn't visible. The restricted messages show when the URL is known.
- **Frames (phase 2).** `readFrames` is honoured: the agent is injected into all frames, and a frame is kept only if it has at least 200 characters of text and a viewport of at least 200x100 px. If Chrome refuses `allFrames` because some frames aren't permitted (spec 18.8, unverified), PageSum retries with the main frame and shows "Embedded frames skipped." Frame text follows the main text under an "Embedded frame: {host}" heading; a citation from a frame highlights inside that frame only.
- **PDF bytes (unverified in Chrome).** The panel fetches the URL with `credentials: "include"`; if that fails, the page agent fetches its own URL; local files use XHR. Whether the panel fetch works with only `activeTab`, whether the agent can be injected into the PDF viewer, and whether XHR of `file:` URLs works from the side panel are not verified. A failure shows the access view or the file hint. The page count is estimated from `/Type /Page` objects and is unknown (so page citations aren't range-checked) for PDFs that keep pages in compressed object streams.
- **PDF, screenshot and transcript data stay in memory for the tab** (up to about 27 MB of base64 per PDF tab) so follow-ups don't refetch, and are dropped on navigation or tab close. They are never written to storage; a restored summary refetches the PDF on the next question.
- **YouTube transcript fallback** reads `ytd-transcript-segment-renderer` rows (`.segment-timestamp`, `.segment-text`). That DOM belongs to YouTube and may change; failure shows the "Video can't be read" card, never wrong data. No YouTube internal or caption API is called.
- **Screenshots:** image token cost on Gemini 3.x is unverified. The screenshot is downscaled to at most 1568 px and re-encoded as JPEG 0.7 with an OffscreenCanvas in the panel; over 1.5 MB it is refused. With `vision: "auto"` the capture follows the same one-second rule as auto-summaries.
- **Explicit cache:** the minimum token count for a cache is undocumented, so PageSum only tries above about 32,000 estimated tokens. Estimates are rough (characters / 4; 560 tokens per PDF page, 280 at LOW; 100 per video second). Any failure to create a cache, network errors included, marks the model unsupported for 24 hours, as the spec says.
- **Options UI for the v2 settings** (vision mode, YouTube mode, frames, structured extraction, explicit cache) is phase 3 task 20. Until then they can only be changed by editing the stored settings.
- **Agent-side limit of 700 characters for the highlight text** (spec says strings are capped at 500): chunks can be 600 characters and the fuzzy fallback needs the whole passage.
- **`hasPasswordField` is already reported** by extraction (cheap) for the phase-3 sensitive guard. The guard itself (`classifySensitive`) is not built; `lib/sensitive.js` only has the host-list helpers settings need.
- **Citation ids typed by a page are defused with `[ `** (a space after the bracket). The rule is slightly wider than the spec's (`[t=1:02` is also defused).
- **Identical consecutive text pieces are dropped** by extraction, per the "drop a block identical to the previous block" rule, which also applies after a long block is split.
- **Selection mode** keeps the user's chosen text even inside nav/aside areas (only hard skips apply), and falls back to a single block without a node map if the selection has no usable range.
- **Not verified in a real browser:** side panel layout and height, `executeScript` on real pages and iframes, the Custom Highlight API visuals, smooth-scroll timing of the flash outline, clipboard, the keyboard shortcut, `chrome.permissions.request` prompts, dark mode, screen-reader announcements. Model ids and the live Gemini API were also not exercised.
