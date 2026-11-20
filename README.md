# PageSum

A Chrome extension that summarises the page you are on, answers questions about it and shows where each claim comes from, using your own Google Gemini API key. It lives in the browser's **side panel** and follows the tab you are looking at.

> **Build status (v1.1.0, work in progress on `feat/v2`):** phase 1 of `SPEC_V2.md` is implemented: side panel, per-tab state, tab following and click-to-source citations. Phases 2 and 3 (PDF, YouTube, screenshots, iframes, quick actions, guide mode, compare, history) are **not built yet**. Sections below describe what works today and are marked where later phases will extend them. The full README rewrite (spec section 20) happens in phase 3.

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
- Each tab keeps its own summary and chat. A stream keeps running if you switch tabs. If a page changes after its summary, a notice offers **Re-summarise** (it never re-summarises on its own).

## Settings

Open them with the gear icon (or the extension's Options). Today the Options page shows the v1 settings: API key, model, default length, language, max page characters, auto-summarise, clear cache. The v2 settings already exist in storage with defaults (citations on, read embedded frames on, vision "ask", YouTube "video", explicit cache off, history on, sensitive guard on, empty blocklist) and get their Options UI in phase 3.

- **Model:** presets, ids fetched with "Refresh models", or "Custom...".
- **Why Flash-Lite is the default:** `gemini-3.5-flash-lite` has the most generous free daily quota and summaries are an easy task.
- **Max page characters:** 5,000 to 400,000. Longer pages are cut from the end, on a whole-paragraph boundary.

## Privacy and security

- Your API key is stored unencrypted in this browser profile's extension storage and is sent only to `generativelanguage.googleapis.com`, in the `x-goog-api-key` header (never in a URL, never logged).
- The text of the pages you summarise is sent to Google's Gemini API. There is no analytics and no other server.
- Page text is **untrusted**: it sits inside a nonce-tagged block, the system prompt says never to follow instructions found in it, and a page cannot forge the closing tag or a citation id (`[c12`-style text in a page is defused).
- Model output is rendered by a small markdown parser that builds DOM nodes with `createElement`/`textContent` only. Raw HTML is shown as text and only `http(s)` links are clickable. Citation markers are buttons built the same way. A test enforces that no unsafe HTML API appears anywhere in `extension/`.
- **PageSum never acts on a page.** The code injected into pages cannot click, type, submit, navigate or change a field (a static test checks for it). It only reads text and draws a highlight. It has no message listener, so a web page cannot send it commands.
- Permissions: `activeTab`, `scripting`, `storage`, `sidePanel`, the Gemini host. Optional (asked only when you press a button): per-site or all-sites access, and later `tabs` for Compare.
- Summaries are cached in `chrome.storage.session` (cleared when the browser restarts).

## Limitations (phase 1)

PDFs, YouTube transcripts and videos, embedded iframes, canvas/screenshot reading, and open shadow DOM are not read yet (planned for phase 2). A PDF tab shows "PDFs aren't supported yet." Closing the panel stops generation.

## Development

Needs Node 21 or newer for the test glob (no install, no dependencies).

```
npm test            # node --test "tests/*.test.js"
npm run icons       # regenerates extension/icons/*.png
powershell -File tools/pack.ps1   # dist/<yyyy-mm-dd>/PageSum-v<version>.zip
```

Layout: `extension/sw.js` (tiny service worker), `extension/sidepanel.*` and `extension/panel/*` (UI modules), `extension/content/*` (classic scripts injected on demand into pages), `extension/lib/*` (pure modules). Everything is plain JS/HTML/CSS with no build step.

Tests need no browser: pure modules are unit-tested; the content scripts run inside `vm` sandboxes against a fake DOM (`tests/helpers/fakedom.js`); `tests/tabs.test.js` drives `panel/tabs.js` with a fake `chrome.*` whose `executeScript` runs the real content scripts; the Gemini client is tested against a mock server (`tests/mock-gemini.js`).

## Manual checklist (needs Chrome and a real key; not run by the builder)

Phase 1 items, numbered as in SPEC_V2 section 16.4. Record pass/fail in the right column when run.

| # | Check | Result |
|---|---|---|
| 1 | Fresh load shows no errors on `chrome://extensions`. Clicking the icon opens the side panel with the key card. Save the key and the summary streams. Alt+Shift+S also opens it. | not run |
| 2 | Article page: the summary has numbered citation markers. Clicking one scrolls to and highlights the exact paragraph. Esc (on the page or in the panel) clears it. A marker in a chat answer works too. | not run |
| 3 | Edit the DOM in DevTools: move the cited paragraph's text elsewhere and the marker still finds it (fuzzy). Delete the text entirely: the "isn't on the page any more" toast shows. | not run |
| 4 | Switch tabs: the panel follows. Previously summarised tabs restore instantly. A tab with no access shows "can't read this tab yet"; "Allow on {host}" and "Allow on all sites" work. Clicking the icon on that tab works without a grant. | not run |
| 5 | Ctrl+Tab quickly through 5 tabs: no request is sent for tabs shown for less than a second (check the network panel). | not run |
| 6 | SPA (GitHub repo to a file view): in-app navigation resets the conversation for the new URL. Same-URL content changes show "This page changed since the summary." with Re-summarise. | not run |
| 7 | Start a summary on tab A, switch to B and back: A's summary is complete. | not run |
| 8 | Restricted pages (`chrome://extensions`, the Web Store, the new tab page) show the right message. A `.pdf` URL shows the phase-1 "not supported yet" message. | not run |
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
- **Frames are main-frame only in phase 1.** The settings flag `readFrames` exists but injection is `allFrames:false` until phase 2 adds the frame filter and the retry for partially-permitted frames.
- **Agent-side limit of 700 characters for the highlight text** (spec says strings are capped at 500): chunks can be 600 characters and the fuzzy fallback needs the whole passage.
- **`hasPasswordField` is already reported** by extraction (cheap) for the phase-3 sensitive guard. The guard itself (`classifySensitive`) is not built; `lib/sensitive.js` only has the host-list helpers settings need.
- **Citation ids typed by a page are defused with `[ `** (a space after the bracket). The rule is slightly wider than the spec's (`[t=1:02` is also defused).
- **Identical consecutive text pieces are dropped** by extraction, per the "drop a block identical to the previous block" rule, which also applies after a long block is split.
- **Selection mode** keeps the user's chosen text even inside nav/aside areas (only hard skips apply), and falls back to a single block without a node map if the selection has no usable range.
- **Not verified in a real browser:** side panel layout and height, `executeScript` on real pages and iframes, the Custom Highlight API visuals, smooth-scroll timing of the flash outline, clipboard, the keyboard shortcut, `chrome.permissions.request` prompts, dark mode, screen-reader announcements. Model ids and the live Gemini API were also not exercised.
