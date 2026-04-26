# skillRoadmap.md
> Tokenized Skill Benchmark — Full Build Plan

The goal: take any real skill file (or a GitHub repo full of them), compress it into a
testable fingerprint, run cheap LLM probes against that fingerprint, score the results,
and return a report that tells you both **how well an LLM follows the skill** and
**how to improve the skill's structure**.

150,000 tokens of skills → ~10,000 tokens of fingerprints → real benchmark scores.

---

## Phase 1 — Skill Tokenizer (The Compressor)

**Goal:** Parse any `.md` skill file and output a structured Skill Fingerprint JSON.
No LLM required. Pure static analysis.

### Input
- A `.md` skill file — uploaded directly OR fetched from a GitHub URL
- Supports single files or an entire repo directory (`/skills/*.md`)

### What the Tokenizer Extracts

```
SKILL::name
  TRIGGERS:      [keywords/phrases that should activate this skill]
  ANTI-TRIGGERS: [phrases that should NOT activate this skill]
  DEPTH:         integer (number of distinct loading layers)
  LAYERS:
    L1: label  → token: xxxx   (short hash of layer content)
    L2: label  → token: xxxx
    ...
  COMPLEXITY:    0.0–1.0  (branching paths ÷ total rules)
  AMBIGUITY:     0.0–1.0  (trigger overlap with other skills in set)
  CONSTRAINTS:   integer  (count of explicit hard rules)
  WORD_COUNT:    integer  (raw token cost of the original file)
  FINGERPRINT_TOKENS: integer  (compressed size)
  COMPRESSION_RATIO:  x:1
```

### Output
- `fingerprints/<skill-name>.fp.json` per skill
- `fingerprints/manifest.json` — full index of all skills in the run with metadata
- Console summary: skill count, avg compression ratio, avg complexity, ambiguity collisions flagged

### Compression Target
| Skill file size | Target fingerprint size |
|---|---|
| ~500 tokens    | ~40 tokens  |
| ~2,000 tokens  | ~80 tokens  |
| ~10,000 tokens | ~200 tokens |
| ~50,000 tokens | ~500 tokens |

> Rule of thumb: 40–60× compression. A 150k token skill suite becomes ~3–4k tokens of fingerprints.

### How Depth Is Scored
Each layer in the original skill file that has:
- A distinct heading or named section
- At least one conditional rule (`if`, `when`, `only`, `never`, `must`)
- A reference to another layer or sub-file

...counts as one depth unit. A skill with 1 flat block of rules = depth 1. A skill with
a routing table + 3 sub-files + conditional loading = depth 4+.

### Deliverables
- `tokenizer/parse-skill.ts` — core parser
- `tokenizer/batch.ts` — runs against a local directory or GitHub repo URL
- `tokenizer/fingerprint.schema.json` — JSON schema for fingerprint output
- `tokenizer/README.md` — usage instructions

---

## Phase 2 — Test Generator (Probe Factory)

**Goal:** Take fingerprints from Phase 1 and auto-generate a set of LLM test probes
for each skill. No human authoring required.

### Probe Types (5–10 per skill)

| Probe Type | Question Template | Scores |
|---|---|---|
| **Trigger** | "User says: `{trigger_phrase}` — which skill should activate?" | Routing accuracy |
| **Anti-trigger** | "User says: `{anti_trigger}` — should this skill activate? Yes/No" | False-positive rate |
| **Layer traversal** | "You loaded layer L1 of `{skill}`. What must you do next?" | Depth following |
| **Constraint recall** | "List the hard rules for `{skill}`. Be specific." | Rule retention |
| **Ambiguity resolution** | "This prompt matches both `{skill_a}` and `{skill_b}`. Which wins and why?" | Discrimination |
| **Boundary test** | "User asks: `{edge_case}` — does `{skill}` apply? Justify." | Boundary judgment |
| **Structural integrity** | "Given this skill fingerprint, what is missing or ambiguous?" | → Improvement flags |

### Difficulty Scaling
Probes are auto-assigned a difficulty tier based on fingerprint attributes:

- **D1 — Surface:** Single trigger match, depth-1 skill, no ambiguity
- **D2 — Mid:** Multi-layer skill, mild trigger overlap with 1 other skill
- **D3 — Deep:** High complexity score, ambiguity > 0.5, depth 3+
- **D4 — Adversarial:** Anti-trigger traps, negation, overlapping triggers across 3+ skills

### Output
- `probes/<skill-name>.probes.json` — all generated probes for a skill
- `probes/suite.json` — full test suite manifest with difficulty distribution
- Console summary: total probes, difficulty breakdown, estimated LLM cost

### Cost Estimate
At ~200 tokens per probe (prompt + expected answer), a 40-skill suite generates
~400 probes = ~80,000 tokens. At current frontier model pricing (~$0.005/1k tokens input):
**~$0.40 per full benchmark run.** Small models (Groq 8B): ~$0.02.

### Deliverables
- `test-gen/generate-probes.ts` — probe factory from fingerprint
- `test-gen/difficulty-scorer.ts` — assigns D1–D4 tiers
- `test-gen/cost-estimator.ts` — pre-run cost estimate
- `test-gen/README.md`

---

## Phase 3 — Runner + Report (Score + Improve)

**Goal:** Send probes to an LLM, score responses against fingerprint ground truth,
and output a human-readable report with a skill score AND actionable improvement suggestions.

### Runner

Supports any OpenAI-compatible API endpoint:
- OpenAI (gpt-4o, gpt-4o-mini)
- Anthropic (claude-3-5-sonnet via proxy)
- Groq (llama-3.1-8b, llama-3.3-70b)
- xAI (grok-3)
- Local (Ollama, LM Studio)

Each probe is sent as a structured system + user message. Responses are parsed and
scored automatically against the fingerprint's expected answers.

### Scoring

| Metric | How It's Measured | Weight |
|---|---|---|
| `trigger_accuracy` | % of trigger probes correctly routed | 25% |
| `anti_trigger_rate` | % of false positives avoided | 15% |
| `depth_score` | % of layer traversal probes answered correctly | 20% |
| `constraint_recall` | % of hard rules mentioned in recall probes | 20% |
| `discrimination` | % of ambiguity probes correctly resolved | 20% |

**Composite Score:** weighted average → 0–100 integer.

### Improvement Report

After scoring, each skill gets a report section:

```
SKILL: chart
Score: 74/100  [■■■■■■■□□□]

TRIGGER GAPS (3 found):
  - "draw me a chart" → no trigger matched  [add: "draw"]
  - "visualize this data" → routed to wrong skill  [fix trigger overlap with dataviz]
  - "make a graph of..." → not in trigger set  [add: "graph", "make a graph"]

AMBIGUITY COLLISIONS (1 found):
  - Overlaps with `dataviz` skill on triggers: ["chart", "plot", "graph"]
  - Suggestion: add anti-trigger to `chart` for "raw data table"

DEPTH ISSUES (1 found):
  - L3 has no explicit constraints — LLM guessed randomly
  - Suggestion: add at least 2 hard rules to L3

CONSTRAINT GAPS (2 found):
  - Rule "never use dollar signs for math" present in file but not recalled
  - Suggestion: move to L1 (top of file) for better retention

OVERALL SUGGESTION:
  Restructure triggers section. Move hard rules earlier. Reduce L3 ambiguity.
  Estimated score after fixes: 88/100
```

### UI (Final Polish)
- Paste a GitHub URL **or** drop `.md` files
- Pick a model + enter API key (stored in memory only, never persisted)
- Click **Run Benchmark**
- See: per-skill score, composite suite score, improvement report
- Export: `results.json` + `report.md`

### Deliverables
- `runner/run.ts` — main benchmark runner
- `runner/scorer.ts` — response scoring logic
- `runner/report-gen.ts` — improvement report generator
- `runner/ui/` — single HTML interface (GitHub URL input + file drop + results view)
- `runner/README.md`

---

## Full File Structure (End State)

```
skill-bench.md/
├── skillRoadmap.md          ← this file
├── tokenizer/
│   ├── parse-skill.ts
│   ├── batch.ts
│   ├── fingerprint.schema.json
│   └── README.md
├── test-gen/
│   ├── generate-probes.ts
│   ├── difficulty-scorer.ts
│   ├── cost-estimator.ts
│   └── README.md
├── runner/
│   ├── run.ts
│   ├── scorer.ts
│   ├── report-gen.ts
│   ├── ui/
│   │   └── index.html
│   └── README.md
├── fingerprints/            ← generated at runtime, gitignored
├── probes/                  ← generated at runtime, gitignored
└── results/                 ← generated at runtime, gitignored
```

---

## Success Criteria

| Milestone | Done When |
|---|---|
| Phase 1 complete | Any `.md` skill file → valid fingerprint JSON in < 1 second |
| Phase 2 complete | 40-skill suite → full probe set generated, cost estimated, no human authoring |
| Phase 3 complete | Probe results → score + improvement report in < 60 seconds, any model |
| Full pipeline | GitHub URL in → benchmark report out, end to end |
