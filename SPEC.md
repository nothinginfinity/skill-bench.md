# skill-bench.md — Benchmark Specification

A **deterministic, machine-verifiable routing and progressive skill loading benchmark framework** for LLM agents, MCP routers, and tool-calling systems.

---

## Benchmark Families

### 1. Verifiable Routing Benchmark
> *Did the system choose the correct skill?*

Measures routing correctness with proof-of-execution tokens. No evaluator bias. Machine-checkable output.

**Token format (v1 static):**
```
BENCH-{id}::{unique_number}
```

**Token format (v2 seeded):**
```
BENCH-{id}::HMAC-SHA256(seed + ":" + skill_id)[0:8]
```

### 2. Progressive Skill Loading Benchmark
> *Did the system choose the correct skill AND load the correct depth?*

Each skill has 1–5 layers. Prompt encodes required complexity. Model must emit the exact progressive token chain.

**Token format:**
```
BENCH-{id}::DEPTH={n}::{l1_token}.{l2_token}...{ln_token}
```

**Layers:**
| # | Name | Tests |
|---|------|-------|
| 1 | identity | shallow skill recognition |
| 2 | parameter | input/output schema awareness |
| 3 | constraint | boundary and policy compliance |
| 4 | reasoning | contextual inference |
| 5 | adversarial | edge-case and trap resistance |

---

## Suite Directory

```
suites/
  routing-flat/           → 200 skills × 1 layer, static tokens
  routing-seeded/         → Dynamic HMAC tokens, zero memorization
  loading-progressive/    → 100 skills, variable depth (1/2/3/5 layers)
  loading-mixed-depth/    → Same as progressive, fully randomized order
  adversarial-overlap/    → Ambiguous/overlapping prompts
  combined-edge-cases/    → Full combined evaluation
```

---

## Scoring Metrics

| Metric | Formula | Suite |
|--------|---------|-------|
| Routing Accuracy | correct_routes / total | all |
| Depth Accuracy | correct_depth / total | progressive |
| Layer Chain Accuracy | correct_layer_tokens / expected | progressive |
| Routing Efficiency | required_layers / loaded_layers | progressive |
| Adversarial Survival | correct / adversarial_cases | adversarial |

**Failure modes:**
- `underload_error` — correct skill, too shallow (stops at L2 when L4 needed)
- `overload_error` — correct skill, too deep (loads L5 when L2 was enough)

---

## Leaderboard Format

```
Model       | Routing | Depth  | Chain  | Efficiency | Adversarial
------------|---------|--------|--------|------------|------------
Model A     |   98%   |  71%   |  68%   |   0.62     |    N/A
Model B     |   91%   |  89%   |  84%   |   0.84     |   79%
```

See `leaderboard/format.json` for full submission schema.

---

## Roadmap

| Version | Focus |
|---------|-------|
| v1 | Flat skill routing, static tokens (✅ done) |
| v2 | Seeded dynamic tokens |
| v3 | Progressive skill depth |
| v4 | Ambiguous / adversarial routing |
| v5 | Public leaderboard + comparison runs |

---

## Key Thesis

**Flat skill routing proves recognition.**  
**Progressive skill loading proves controlled capability activation.**

Together they form a full evaluation grid across:
- **Routing Breadth** — how many skills can the model navigate?
- **Routing Accuracy** — did it choose the correct one?
- **Loading Depth** — how many layers can it correctly activate?
- **Depth Accuracy** — did it activate exactly the right layers?
- **Efficiency** — did it avoid loading unnecessary layers?
- **Robustness** — did it survive ambiguity and adversarial prompts?
