# skill-bench.md — Public Leaderboard

Last updated: **2026-04-24** — [Seed Run](./runs/2026-04-24-seed-run.json)

> Scores marked `(sim)` are from the initial seed run using simulated routing to establish baseline format.
> Replace with live API runs using `npx tsx runner/run.ts`.

---

## Suite: routing-flat (200 skills × 1 layer)

| Model | Provider | Routing Accuracy | Avg Latency | Run ID |
|---|---|---|---|---|
| gpt-4o | openai | 95.0% `(sim)` | 820ms | 4e706aec |
| claude-3-7 | anthropic | 95.0% `(sim)` | 950ms | 81031d22 |
| gemini-2-flash | gemini | 90.0% `(sim)` | 410ms | 5568357e |

---

## Suite: loading-progressive (100 skills, depth 1–5)

| Model | Provider | Routing | Depth | Chain | Efficiency | Avg Latency | Run ID |
|---|---|---|---|---|---|---|---|
| claude-3-7 | anthropic | 100% `(sim)` | 80% | 70% | 1.20 | 1442ms | 81031d22 |
| gemini-2-flash | gemini | 100% `(sim)` | 80% | 50% | 0.98 | 909ms | 5568357e |
| gpt-4o | openai | 100% `(sim)` | 70% | 60% | 0.84 | 1321ms | 4e706aec |

> **Efficiency > 1.0** = over-loading (loaded more layers than needed). **< 1.0** = under-loading. **1.0** = perfect.

---

## How to Submit a Run

1. Clone the repo
2. Run: `npx tsx runner/run.ts --suite loading-progressive --provider openai --model gpt-4o --key $OPENAI_API_KEY`
3. Submit your `.summary.json` from `results/` as a PR to `leaderboard/runs/`

See [`leaderboard/format.json`](./format.json) for full submission schema.
