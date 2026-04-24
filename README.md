# skill-bench.md

> A routing fidelity benchmark for skill-routing.md compatible systems.

## What This Is

Each skill in this repo has exactly one job: emit a unique, unforgeable token when invoked.
A router that correctly selects and loads skill `bench-042` will produce `BENCH-042::7,291,004.83741` and nothing else.

This makes routing accuracy **machine-checkable** with a simple string comparison — no LLM judge, no ambiguous output.

## How It Works

```
Router selects skill → LLM loads skill body → LLM emits token → test runner checks token against manifest
```

Pass rate = `correct_tokens / total_skills_tested × 100%`

## Repo Structure

```
skill-bench.md/
├── README.md
├── manifest.json          ← ground truth: skill ID → expected token
├── skills/
│   ├── bench-001.md
│   ├── bench-002.md
│   └── ... (200 total)
└── runner/
    ├── runner.ts          ← TypeScript test runner
    └── tsconfig.json
```

## Running the Benchmark

```bash
cd runner
npx tsx runner.ts
```

The runner reads `manifest.json`, invokes each skill, and prints a pass/fail report.

## Token Format

```
BENCH-{id}::{unique_number}
```

- `id` — zero-padded 3-digit skill number
- `unique_number` — a high-precision float unique to this skill, seeded for reproducibility

Tokens can be regenerated with a new seed for adversarial testing (v2).

## Status

🟡 **v1** — 200 skills, static tokens, TypeScript runner. See Issues for v2 roadmap.
