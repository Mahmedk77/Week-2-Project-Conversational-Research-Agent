# Test prompt sequence

Paste these one at a time, in order, in the same session (don't clear memory until told to). Each one targets something specific we built or fixed.

## 1. Empty state → first message
**Click a suggestion card** ("What is pgvector?") instead of typing.
- Checks: empty state renders, card click populates + auto-sends, streaming starts, no `__REASONING_TRACE__` delimiter or raw JSON ever visible.

## 2. Basic tool call + reasoning panel
```
What is pgvector?
```
- Checks: knowledge_base_search fires, "Show reasoning" toggle appears, expands inline with clean "Called {tool}" / "Result:" lines (monospace, truncated, no raw markdown symbols).

## 3. Web search tool
```
What's the latest news on AI agents this week?
```
- Checks: web_search tool fires (Tavily), reasoning panel shows a second tool, answer renders without leftover `#`/`**`/`[...]` artifacts from scraped snippets.

## 4. Calculator tool + long-form input
```
What's 234 times 18, and roughly what's 15% of that result? Also explain briefly how that compares to calculating percentages of a raw dataset size in a typical ML preprocessing pipeline.
```
- Checks: calculator tool fires correctly, textarea auto-grows smoothly (no scrollbar arrows), send button stays bottom-aligned, math is correct (should be 4212, then 15% ≈ 631.8).

## 5. Markdown formatting — table + bold + headers
```
Compare LangChain and Supabase in a markdown table with a bold summary and a header
```
- Checks: real `<table>` renders (not raw pipes), horizontal scroll on narrow viewports with fade edges, bold/headers render as actual markdown, table sits on the surface-1 background.

## 6. Multi-tool parallel call
```
What is 156 times 24, and also what is pgvector?
```
- Checks: both calculator and knowledge_base_search fire (ideally in parallel), reasoning panel shows both steps in order, final answer combines both correctly (3744 + pgvector definition).

## 7. Long context / memory stress test
```
Now, what was the latest match Barcelona played, and analyze how they could've done better tactically compared to a standard 4-3-3 setup
```
- Checks: this is turn 5+ in the session — watch for whether context/summary handling holds up (this is the scenario that used to trigger rate-limit errors). Should complete without the "response was interrupted" fallback.

## 8. Follow-up requiring memory continuity
```
Can you remind me what my very first question in this conversation was?
```
- Checks: session memory/summary correctly retains earlier context across many turns, doesn't hallucinate a different first question.

## 9. Dark mode / responsive check (manual, no prompt)
Resize browser to ~375px width (or open dev tools device toolbar) and re-send prompt #5 (the table one).
- Checks: no horizontal page scroll, table scrolls within its own container, reasoning toggle and copy button are comfortably tappable (~44px targets).

## 10. Clear memory
Click **"Clear memory"** in the header.
- Checks: chat resets to empty state, Supabase `agent_memory` row for this session is deleted, next message starts a fresh context (won't remember the Barcelona/first-question stuff from before).

## 11. Post-clear sanity check
```
What is n8n?
```
- Checks: works normally after a memory clear, confirms clearing didn't break the session/fetch logic.

## 12. Error-path check (optional, needs dev tools)
Open browser dev tools → Network tab → set throttling to "Offline", then send any message.
- Checks: should show "Couldn't reach the server. Check your connection and try again." — not a raw fetch error, not blank, not raw HTML.
- Re-enable network after.

## 13. Edge case: empty/whitespace input
Try sending a message that's just spaces, or pressing send with an empty input.
- Checks: send button should be disabled / nothing should be sent (no empty bubble in chat).

## 14. Edge case: very long single word (no spaces)
```
supercalifragilisticexpialidocioussupercalifragilisticexpialidocioussupercalifragilisticexpialidocious
```
- Checks: word wraps/breaks correctly inside the user bubble, doesn't overflow horizontally on mobile.

---

### What to watch across all of the above
- Streaming renders progressively (not all-at-once)
- No raw `__REASONING_TRACE__` text or escaped JSON ever visible
- No console errors (check browser dev tools console)
- Copy button on AI messages works and shows the checkmark briefly
- Font is Lora (serif) throughout, palette is the warm cream/tan theme, no leftover gray/white
