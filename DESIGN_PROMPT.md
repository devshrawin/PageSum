# PageSum: design prompt

Paste everything below the line into your design tool (Claude design, v0, Figma AI, etc.).

---

Design a polished, premium UI for **PageSum**, a Chrome extension (Manifest V3). The user clicks the toolbar icon, a popup opens, and the current web page is summarised by Google Gemini (user's own API key). They can then ask follow-up questions about the page in a chat. It's a daily-use utility for people who read a lot: students, researchers, professionals. Feel: calm, fast, trustworthy, quietly delightful. Think Linear / Raycast / Arc / Notion AI polish, not a default Bootstrap popup. Current version is functional but plain (system font, flat grey cards, unicode glyph icons, one indigo accent), so push well past that.

## Deliverables
1. **Popup**: fixed 420px wide, 320 to 600px tall, internal scroll. Design every state below, in **light and dark** (follows OS).
2. **Options page**: full tab, centred column about 640px.
3. **Toolbar icon + logo mark**: must read at 16px; light/dark toolbar variants; plus 128px store icon.
4. **Design tokens**: colour (light/dark), type scale, spacing (4px base), radii, shadows, motion durations/easings. Output as CSS custom properties.
5. **Component sheet**: buttons (primary/secondary/ghost/danger/icon), segmented control, input, textarea, select, checkbox, toast, notice banner, chat bubbles, markdown content styles, skeleton loader, spinner.

## Popup states to design
1. **Loading / reading page**: skeleton shimmer for the summary card (not just a spinner), page title in header.
2. **First run, needs API key**: friendly 3-step setup (open aistudio.google.com/apikey, create key, paste), password field with show/hide, Save, "More settings" link, privacy line: "Stored unencrypted in this browser on this device. Only sent to Google."
3. **Idle** (auto-summarise off): one clear "Summarise this page" call to action with page title and favicon.
4. **Streaming summary**: text appears progressively with a subtle caret/fade; Stop button visible; copy/regenerate disabled until done.
5. **Summary done**: TL;DR callout on top, then key-point bullets, optional headings. Toolbar: Short / Medium / Detailed segmented control, Regenerate, Copy (with a "Copied" confirmation state).
6. **Chat**: user bubbles (right, tinted), model answers (left, full-width markdown), streaming, Send button, auto-growing textarea, Enter to send / Shift+Enter newline, "New chat" link, current model name as small muted label.
7. **Restricted page** (chrome://, Web Store, PDF): lock illustration plus a plain explanation.
8. **Not enough text**: empty state with "Try anyway".
9. **Error cards**: bad key, quota exceeded (with "try again in N s"), network, blocked by safety filter, model not found (with "Switch to Flash-Lite" action). Friendly copy, one clear action each, never alarming red walls.
10. **Selection mode**: notice banner "Summarising your selection" when text is selected on the page.
11. **Truncation notice**: slim banner "Long page: summarised the first 60,000 characters".

## Visual direction
- Typeface: one refined sans (Inter / Geist / Plus Jakarta Sans via system fallback stack is fine, no font download in the extension), optional serif for the TL;DR for an editorial feel. Tight, readable type scale: 12 / 13 / 14 / 16 / 20.
- Colour: keep an indigo-to-violet accent family but make it richer (subtle gradient on the primary button and logo only). Warm-neutral greys, not blue-grey. Dark mode is true dark with soft elevation, not just inverted.
- Surfaces: layered cards with 1px hairline borders, soft shadow, 12px radius. Generous whitespace, 12 to 16px padding.
- Icons: a consistent 1.5px-stroke line icon set (settings, refresh, copy, check, stop, send, lock, sparkle). No emoji or unicode glyphs.
- Motion: 120 to 200ms ease-out, shimmer skeleton, streaming text fade-in, button press feedback, respect prefers-reduced-motion.
- Header: favicon + page title (truncated) + small settings gear. Optionally domain in muted text under title.
- Markdown styling inside answers: headings, bullets, numbered lists, bold, inline code, code blocks, blockquotes, links (underline on hover, open in new tab).

## Options page sections
API key (field, show/hide, Save, Test key, Remove key, status message); Model (dropdown, Refresh models, custom model id field); Summary (default length, output language field "Leave empty to match the page", max characters, "Summarise automatically when the popup opens" toggle); Data (Clear cached summaries). Show saved-toast and inline validation states. Use switches rather than checkboxes for toggles.

## Constraints
- Plain HTML/CSS/JS, no framework, no build step, no external fonts/CDN/images (everything inline or bundled). Must work offline apart from the Gemini call.
- Accessible: WCAG AA contrast in both themes, visible focus rings, 44px-ish touch targets where possible, aria-live for streaming, full keyboard flow.
- Must fit 420px width without horizontal scroll; footer chat input stays pinned.
- Do not change behaviour or copy meaning; this is a visual and interaction redesign.

## Output format
Give me: (a) a short design rationale, (b) the token CSS, (c) high-fidelity mockups or HTML/CSS for each popup state and the options page in light and dark, (d) the logo/icon as SVG. If you produce code, keep the existing element IDs and classes from popup.html / options.html so the existing JS keeps working.
