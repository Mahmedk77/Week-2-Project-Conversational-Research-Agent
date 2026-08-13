# Test scripts

Both hit the **real** Groq API and spend real tokens against the free-tier
budget. Prefer one clean run over repeated retries.

## `token-audit.mjs` — where the input tokens go

```bash
npm run test:tokens
```

Reports Groq's own `prompt_tokens` for each layer of the request, and for each
step of the agent loop. Reads the live `SYSTEM_PROMPT` out of
`app/api/agent/route.ts`, so it stays accurate as the prompt changes.

Use it after editing the system prompt or tool descriptions to see the real
cost, rather than estimating from character counts (a ~4 chars/token estimate
undercounts by 15-30% — the message envelope and tool-call JSON don't show up
in raw character counts).

Baseline as measured:

| Layer | Tokens |
|---|---|
| message envelope | 72 |
| tool definitions | 302 |
| system prompt | 419 |
| question | ~19 |
| memory summary (400 chars) | 61 |

One heavy turn (3 model calls, 2 tool calls) = **~2,917 input tokens**, which is
**36% of the 8,000 TPM bucket**. Roughly 2.7 heavy turns per minute per model.

## `loadtest.mjs` — does it hold up under load

Needs the dev server running (`npm run dev`).

```bash
npm run test:load -- smoke      # one turn per prompt class, 20s apart
npm run test:load -- burst 6    # N heavy turns back-to-back, finds the wall
npm run test:load -- convo      # 10 turns, one session, 15s apart
npm run test:load -- soak       # heavy turns every 35s until failure
```

Per turn it reports latency, answer length, which tools fired, and a verdict:

| Verdict | Meaning |
|---|---|
| `OK` | real answer returned |
| `RL_MINUTE` / `RL_DAILY` | rate limited (TPM / TPD) |
| `EMPTY_ANSWER` | stream returned nothing |
| `NO_CONTENT` | every model returned an empty answer |
| `MODEL_TROUBLE` | chain exhausted on tool-parse errors |
| `HTTP_4xx/5xx` | endpoint rejected the request |

It also polls `x-ratelimit-remaining-tokens` between turns, so burn is measured
rather than estimated.

`BASE_URL=http://host:port` overrides the target.

### Known result

`burst` fails on turn 3 with zero pause between heavy turns — that is the
free-tier ceiling (8K TPM / ~2,917 per heavy turn), not a bug. Normal
conversational pacing stays under it.
