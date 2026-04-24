# Benchmark Modes

Every routing suite run takes a `--mode` flag that controls how the prompt is
constructed and what capability is actually being tested.

```
npx tsx runner/run.ts --suite routing-flat --mode <echo|recall|seeded> ...
```

---

## `echo` (default)

The expected token is shown **inline in the prompt**. The model only needs to
copy it back verbatim.

```
Execute skill: bench-042
Return ONLY this exact token string:
BENCH-042::7291004.83741
```

**What it tests:** Pure instruction-following. Can the model read a token and
repeat it exactly — correct prefix, correct suffix, nothing added?

**Failure pattern from our run:** `llama-3.1-8b` repeated bench-001's token
(`2867825.13278`) for every subsequent skill. It latched on to the first token
it saw in the context window and echoed that instead of the one in the current
prompt. This means it failed even the *easiest* possible version of the task.

**Good for:** Baseline qualification. A model that can't pass echo mode has no
business running recall or progressive suites.

---

## `recall`

The token is **not shown**. The model must return the canonical token for the
skill from its own knowledge or by following the format spec.

```
Execute skill: bench-042
Return ONLY the canonical token for this skill.
Format: BENCH-{id}::{numeric_token}
```

**What it tests:** Whether the model has internalised the skill<→token mapping,
or at minimum can produce a well-formed response without being handed the answer.

**Expected outcome for small models:** Near-zero accuracy (they have no way to
know the tokens). This is intentional — recall mode is designed for fine-tuned
or retrieval-augmented models that have been trained on the manifest.

**Good for:** Measuring knowledge retention after fine-tuning, or testing
RAG-augmented routers.

---

## `seeded`

A unique UUID seed is generated per run. The expected token is computed as:

```
BENCH-{id}::{HMAC-SHA256(seed:skill_id).slice(0,8)}
```

The model is given the seed and the HMAC formula and asked to compute it.

**What it tests:** Instruction-following *and* basic computation/reasoning.
Since the token changes every run, the model cannot memorise or cache answers.

**Failure pattern:** Small models produce the right format but wrong HMAC value,
or produce a correctly-structured token for the wrong skill ID.

**Good for:** Anti-memorisation testing. The cleanest signal for comparing
models on routing fidelity across runs.

---

## Mode × Model capability matrix

| Model tier | echo | recall | seeded |
|---|---|---|---|
| **8B instruction-tuned** (llama-3.1-8b) | Fails (echo-stuck) | Fails | Fails |
| **70B instruction-tuned** (llama-3.3-70b) | Should pass | Fails | Partial |
| **Frontier** (gpt-4o, claude-3.7, gemini-2.0-flash) | Passes | Partial | Passes |
| **Fine-tuned on manifest** | Passes | Passes | Passes |

---

## CSV output columns

| Column | Description |
|---|---|
| `skill` | Skill ID (bench-001 … bench-200) |
| `expected` | Correct token from manifest |
| `actual` | Model's raw response |
| `pass` | `true` if exact match |
| `hallucinated` | `true` if `actual` matches a known placeholder pattern |
| `latency_ms` | Request round-trip time |
| `mode` | `echo` / `recall` / `seeded` |

---

## Recommended test sequence for a new model

1. **Smoke test** — `--mode echo --limit 10` (fast, cheap, baseline check)
2. **Full echo** — `--mode echo` (200 skills, measures instruction-following floor)
3. **Full seeded** — `--suite routing-seeded` (anti-memorisation, best signal)
4. **Progressive** — `--suite loading-progressive` (depth loading, hardest)

Only advance to the next suite if the previous one passes at >80%.
