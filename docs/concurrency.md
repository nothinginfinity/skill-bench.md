# Concurrency Guide

The runner supports parallel requests via `--concurrency N`. The default is
`1` (fully sequential) — the safest option for all providers.

---

## The Problem It Solves

Without a concurrency guard, parallel requests cause two distinct failure
modes (observed in skill-bench runs 7–9):

### Groq / Cerebras free tier — 429 flood
Firing 200 requests concurrently hits the ~30 RPM free-tier wall in under
10 seconds. The retry backoff in `router.ts` helps individual requests, but
concurrency overwhelms the queue entirely. Result: 167/200 errors.

### OpenAI / frontier models — context contamination
gpt-4o returned 190–194/200 responses with the bench-001 ghost token
(`2867825.13278`) when run with high concurrency and no delay. Average
latency spiked from 192ms → 800ms+, indicating the model was queuing
concurrent context and anchoring on the first token it processed.

---

## How the Semaphore Works

`concurrency.ts` exports a `Semaphore` class and a `runWithConcurrency`
helper. The semaphore limits how many async tasks are active at once.
`--delay` applies *after each task completes*, before its slot is released.

```
Concurrency 3, delay 500ms, 10 tasks:

Time →
[task1 ──────][delay]──release
[task2 ────────][delay]──release
[task3 ──][delay]──release
                        [task4 ──────][delay]...
                        [task5 ────────][delay]...
                        [task6 ──][delay]...
```

---

## Safe Defaults by Provider

| Provider | Tier | `--concurrency` | `--delay` | Notes |
|---|---|---|---|---|
| Groq | Free | **1** | **2000** | ~30 RPM limit. Never increase concurrency. |
| Cerebras | Free | **1** | **2000** | Same RPM profile as Groq free. |
| Groq | Paid | 3 | 500 | Check your tier's RPM. |
| Cerebras | Paid | 3 | 500 | Check your tier's RPM. |
| OpenAI | Pay-as-go | **5** | 0 | RPM is high; 5 concurrent is fine. |
| Anthropic | Any | **5** | 0 | Rate limits are per-minute token budget. |
| Gemini | Free | 3 | 200 | Gemini free tier is ~60 RPM. |
| Gemini | Paid | **5** | 0 | Generous limits. |
| DeepSeek | Any | **3** | 0 | Moderate rate limits. |

---

## The Warning

If you pass `--concurrency > 1` with no `--delay` on `groq` or `cerebras`,
the runner prints:

```
⚠️  WARNING: --concurrency 5 with no --delay on groq free tier.
   This will likely trigger 429 rate limits. Recommended: --concurrency 1 --delay 2000
```

This warning exists because the observed failure is silent and misleading —
high concurrency on gpt-4o doesn't error, it just produces garbage results
that look superficially valid (correct format, wrong token).

---

## Reproducing the Failure

To reproduce the exact run 7–9 failure pattern for documentation:

```bash
# Groq 429 flood (don't use --delay, crank concurrency)
tsx run.ts --suite routing-flat --mode echo --provider groq \
  --model llama-3.1-8b-instant --key $GROQ_API_KEY --concurrency 10

# OpenAI context contamination (high concurrency, no delay)
tsx run.ts --suite routing-flat --mode echo --provider openai \
  --model gpt-4o --key $OPENAI_API_KEY --concurrency 20
```

> Do not use these in production runs. They are for failure-mode documentation only.
