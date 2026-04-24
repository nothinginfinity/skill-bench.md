# routing-format Suite

Version 2 of `routing-flat`. Tests the same 200 skills across **3 prompt
formats** to answer the core question:

> Does prompt structure change routing accuracy, and does the answer
> differ by model?

This directly informs how skills should be authored for different model tiers.

---

## The 3 Formats

### `bare`
Minimal invocation. The model gets only a skill ID and a one-line instruction.

```
Execute skill: bench-042
Return the skill token. Format: BENCH-{id}::{token}
Output the token only. No explanation.
```

**Tests:** Raw instruction-following with zero scaffolding. The closest to how
a production skill router would call a model in a tight loop.

**Predicted winner:** Frontier models (gpt-4o, grok-3). They have the
instruction-following fidelity to act on a bare command without overthinking.

---

### `delimited`
Explicit context boundary markers wrap the skill invocation.

```
--- BEGIN SKILL EXECUTION ---
Skill ID:      bench-042
Task:          Execute and return canonical token
Output format: BENCH-{id}::{token}
Constraint:    Token only. No prose. No punctuation outside the token.
--- END SKILL EXECUTION ---
```

**Tests:** Whether hard structural delimiters help models reset their context
anchor — directly targeting the ghost-token / echo-stuck failure mode observed
in runs 7-9. Reasoning models (DeepSeek) are hypothesised to benefit most
because delimiters give them a parse target.

**Predicted winner:** DeepSeek-reasoner, and a meaningful improvement for 8B
models over bare.

---

### `described`
Full description of the skill, its purpose, input, and expected output.

```
You are a skill routing agent.

Skill to execute: bench-042
Skill description: Benchmark routing skill #042. Part of the routing-flat
  evaluation suite. Tests whether this model can correctly identify and
  return the canonical token for a named skill.
Input:  Skill ID (bench-042)
Output: Canonical token string in format BENCH-{id}::{numeric_token}
Rule:   Return the token string only. No explanation, no formatting, no
        punctuation beyond the token itself.

Return the token for bench-042 now.
```

**Tests:** Whether reasoning from description improves accuracy for models
that struggle with bare invocation. Specifically tests if small models (8B)
can substitute description-based reasoning for the instruction-following
fidelity they lack.

**Predicted winner:** 8B models. May *hurt* frontier models (gpt-4o scored
90.5% on bare echo — extra context may introduce overthinking).

---

## Hypotheses

Based on runs 1–9 data:

| Model tier | Predicted best format | Reasoning |
|---|---|---|
| **8B** (llama-3.1-8b) | `described` | Compensates for weak IF with description-based reasoning |
| **70B** (llama-3.3-70b) | `bare` or `delimited` | Strong IF; described may add noise |
| **gpt-4o** | `bare` | High IF fidelity; overthinks described |
| **grok-3** | `bare` | Same as gpt-4o; fast, precise IF |
| **DeepSeek-reasoner** | `delimited` | Reasoning chain benefits from parse targets |
| **Claude 3.7** | `described` or `delimited` | Extended thinking benefits from context |

---

## Output

Each run produces:
- `routing-format-bare-{model}-{ts}.csv`
- `routing-format-delimited-{model}-{ts}.csv`
- `routing-format-described-{model}-{ts}.csv`
- `routing-format-{model}-{ts}.summary.json` — cross-format comparison

### Summary JSON shape
```json
{
  "model": "gpt-4o",
  "provider": "openai",
  "formats": {
    "bare":      { "passed": 181, "accuracy": "90.5%", "avg_ms": 192 },
    "delimited": { "passed": 178, "accuracy": "89.0%", "avg_ms": 198 },
    "described": { "passed": 171, "accuracy": "85.5%", "avg_ms": 241 }
  },
  "best_format": "bare",
  "worst_format": "described",
  "format_sensitivity": 5.0
}
```

`format_sensitivity` = accuracy spread between best and worst format.
High sensitivity (>10%) means the model is strongly format-dependent —
skills should be authored in its preferred format.
Low sensitivity (<3%) means the model is format-agnostic.

---

## Implications for Skill Authoring

Once results are in, the matrix drives concrete skill authoring rules:

- **If bare wins across the board:** Skills should be terse invocations.
  Less prose, more signal. The skill-bench.md format should lean minimal.

- **If described wins for 8B:** Production deployments using small models
  need richer skill headers — purpose, input, output spec inline.

- **If delimited wins for reasoners:** All skills should include hard
  boundary markers. This is cheap to add and may be a universal improvement.

- **If results diverge strongly by model:** The runner needs a
  `--format auto` mode that selects format based on detected model tier.
