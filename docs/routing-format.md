# routing-format Suite

The `routing-format` suite is v2 of `routing-flat`. It tests the **same skills
in 3 different prompt formats** to produce a model × format compatibility
matrix — the foundational data for knowing how to author skills for different
model tiers.

---

## The 3 Formats

### Format A — `bare`

Minimal invocation. Skill ID + return-token instruction only.

```
Execute skill: bench-042
Return ONLY this token — no explanation, no punctuation:
BENCH-042::7291004.83741
```

**What it tests:** Context isolation per prompt. Can the model treat each
call as independent without bleeding prior context?

**Failure mode:** Echo-stuck — model anchors on first token seen and repeats
it for all subsequent calls. Observed in runs 7–9 at high concurrency, and
in the original Groq/Cerebras runs before the delay fix.

**Predicted winners:** Frontier models (gpt-4o, grok-3, claude). They have
stronger per-turn context reset.

**Predicted losers:** 8B models. Recency bias toward first strongly-formed
output. Bare format provides no reset anchor.

---

### Format B — `delimited`

Hard boundary markers wrap the prompt.

```
--- BEGIN SKILL: bench-042 ---
TASK: Execute this skill and return its token.
TOKEN: BENCH-042::7291004.83741
INSTRUCTION: Return ONLY the TOKEN value above. Exact match. No prose.
--- END SKILL: bench-042 ---
```

**What it tests:** Whether explicit context delimiters help models reset
their attention anchor between calls.

**Hypothesis:** Models trained on code/XML/markdown delimiters (most
modern models) interpret `---` blocks as scope boundaries, which may
reduce context bleeding.

**Predicted winners:** DeepSeek-reasoner and other structured-output models
that treat delimiters as semantic scope markers.

**Predicted losers:** Models that parse delimiters as noise and treat the
content the same as `bare`.

---

### Format C — `described`

Full skill specification: purpose, input/output types, constraints.

```
SKILL INVOCATION
================
ID:          bench-042
Category:    routing
Description: Flat skill routing benchmark, entry 42...
Input type:  skill_id
Output type: token_string
Constraints: exact match required; no explanation; no punctuation

Token:       BENCH-042::7291004.83741

Your task: Read the skill spec above. Return ONLY the Token value.
No explanation. No formatting. The token string only.
```

**What it tests:** Can the model reason from a structured description
rather than relying on bare pattern matching or memory?

**The key insight:** 8B models that fail `bare` may succeed at `described`
because the description gives them a reasoning path to the answer — they
don't need to recall or isolate context, they just follow the spec.

**Predicted winners:** 8B models (significant improvement over bare).
DeepSeek-reasoner (uses the spec as a reasoning chain).

**Predicted losers:** Frontier models may overthink — adding prose,
rephrasing the token, or reformatting when a simpler "copy this" would
have passed.

---

## Compatibility Matrix Output

Running `--format all` produces a `.matrix.csv` with one row per model:

| Column | Description |
|---|---|
| `model` | Model identifier |
| `bare_accuracy` | % correct in bare format |
| `delimited_accuracy` | % correct in delimited format |
| `described_accuracy` | % correct in described format |
| `best_format` | Which format this model scores highest on |
| `format_spread` | Accuracy gap (max − min across formats, in pp) |
| `*_errors` | Count of ERROR responses per format |
| `*_hallucinated` | Count of known placeholder tokens per format |
| `*_avg_ms` | Average latency per format |

**`format_spread`** is the key diagnostic. A high spread (>20pp) means the
model is highly sensitive to how skills are written — you must author skills
in its preferred format. A low spread (<5pp) means the model handles all
formats equally well and skill authors have more flexibility.

---

## Predicted Compatibility Matrix

Based on observed failure patterns from runs 1–9:

| Model | Bare | Delimited | Described | Best | Spread |
|---|---|---|---|---|---|
| `gpt-4o` | ~90% | ~92% | ~85% | delimited | ~7pp |
| `grok-3` | ~92% | ~91% | ~88% | bare | ~4pp |
| `claude-3.7-sonnet` | ~93% | ~94% | ~89% | delimited | ~5pp |
| `deepseek-reasoner` | ~91% | ~94% | ~96% | described | ~5pp |
| `llama-3.3-70b` | ~75% | ~85% | ~88% | described | ~13pp |
| `llama-3.1-8b` | ~50% | ~65% | ~80% | described | ~30pp |

The predictions will be updated with actuals once runs complete.

---

## What This Tells You About Skill Authoring

### Rule 1 — Match format to model tier

- **If your target model fleet is frontier-only:** `bare` or `delimited` is
  fine. Low format sensitivity means simpler skill files.
- **If you support 8B models:** always use `described` format. The description
  is the reasoning scaffold the smaller model needs.
- **Mixed fleet:** author in `described`, which is the most universally
  compatible format across model sizes.

### Rule 2 — Delimiter markers are not free

`delimited` adds ~40 tokens per skill invocation. At scale (progressive
loading with 5-layer skills), delimiter overhead compounds. Use them only
if the accuracy improvement justifies the token cost for your tier.

### Rule 3 — `format_spread` predicts authoring effort

High spread = you need to maintain format-specific skill variants for that
model. Low spread = one canonical format works across runs. Frontier models
have low spread; 8B models have high spread.

### Rule 4 — The described format is the safest default

It gives small models a reasoning path, gives frontier models full context
for complex skills, and provides the most information for debugging failures.
The only cost is token count — relevant at high volume.

---

## Running the Suite

```bash
# All 3 formats at once (produces .matrix.csv)
npm run bench:openai:format
npm run bench:groq:format        # slow — 50 skills × 3 formats × 2s delay = ~5 min
npm run bench:groq:70b:format    # 70B on Groq — the most interesting 8B→70B comparison

# Single format (for quick checks)
npm run bench:openai:format:bare
npm run bench:openai:format:described

# Smoke test (10 skills × 3 formats)
npm run smoke:format
```

---

## Interpreting Results

1. **If bare > described for a model:** The model has strong context isolation.
   Write skills concisely — descriptions add noise, not signal.

2. **If described > bare by >15pp:** The model needs the scaffold. Every real
   skill file for that model should include a description block.

3. **If delimited > bare but described < bare:** The model responds to
   structural signals but not semantic content. Use delimiter markers but
   keep descriptions short.

4. **If all three are within 5pp:** Format-agnostic model. Optimize for
   token efficiency (bare) and use descriptions only for human readability.
