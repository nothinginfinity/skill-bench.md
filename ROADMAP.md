# skill-bench.md — Roadmap

Current state, completed work, and the exact next step so testing can begin
without losing the thread.

---

## Status at a Glance

| Phase | Suite / Module | Status | Output |
|---|---|---|---|
| 1 | `routing-flat` — baseline routing | ✅ built + run | per-model accuracy CSV |
| 2 | `routing-format` — format sensitivity | ✅ built | `.matrix.csv` + `.recommendation.json` |
| 3 | `loading-progressive` — depth compliance | ✅ built | depth accuracy CSV |
| 4 | `adversarial-overlap` — ambiguity robustness | ✅ built | adversarial CSV |
| 5 | `repair/generate-fix.ts` — fix report generator | ✅ built | `skill-fix-{runId}.md` |
| **6** | **Phase 6 retest — verify fix** | **⬅ NEXT** | **post-patch accuracy CSV + delta** |

---

## Phase 6 — Retest After Patch

**What it is:**
Re-run the same `routing-format` suite (all 3 formats) after applying the
`skill-fix-{runId}.md` recommended changes. Compare the new run against the
original run ID to verify the fix worked.

**This phase has no new code.** It is entirely runner re-use.

### Steps

```
1. Run Phase 2 to get the first recommendation.json:
   npm run bench:groq:format          (or whichever provider)

2. Generate the fix report:
   npm run fix:groq                   (chains bench + generate-fix in one command)
   → emits: results/skill-fix-{runId}.md

3. Apply the recommended skill authoring changes.
   (The fix report tells you exactly which fields to add.)

4. Re-run the same suite — Phase 6:
   npm run bench:groq:format          (new run_id, same suite)

5. Generate a second fix report from the new run:
   npm run fix:generate:run {new-runId}
   → emits: results/skill-fix-{new-runId}.md

6. Compare:
   - described accuracy: must be ≥ (Phase 2 described accuracy + 5pp)
   - format_spread: must be < 15pp
   - If both pass → fix is verified ✅
   - If not → escalate to Phase 4 (adversarial-overlap) for residual diagnosis
```

### Pass Criteria

| Metric | Target |
|---|---|
| described accuracy | ≥ Phase 2 described + 5pp |
| format_spread | < 15pp |
| confidence | drops from `high` → `medium` or `low` |

### One-liner comparison (manual for now)

```bash
# Phase 2 run
cat results/routing-format-llama-3.1-8b-instant-{runId-A}.recommendation.json | jq '.described_accuracy, .format_spread_pp'

# Phase 6 run
cat results/routing-format-llama-3.1-8b-instant-{runId-B}.recommendation.json | jq '.described_accuracy, .format_spread_pp'
```

A `compare-runs.ts` script (Phase 6 tooling) can be added to automate this
diff — see "Future Work" below.

---

## Full Pipeline (for reference)

```
Phase 1  routing-flat          → is the model routing at all?
Phase 2  routing-format        → which format does the model respond to?
Phase 3  loading-progressive   → does depth/layer loading hold at depth 3+?
Phase 4  adversarial-overlap   → does ambiguity cause routing failures?
Phase 5  generate-fix          → emit skill-fix-{runId}.md from evidence
Phase 6  retest                → re-run Phase 2 after patch; verify delta
```

You do not need all 6 for every model. The minimum viable loop is:

```
Phase 1 → Phase 2 → Phase 5 → Phase 6
```

Add Phase 3 and 4 only when Phase 6 still fails (residual failures not
explained by format sensitivity alone).

---

## Spec Roadmap (from SPEC.md)

| Version | Focus | Status |
|---|---|---|
| v1 | Flat skill routing, static tokens | ✅ done |
| v2 | Seeded dynamic tokens | ✅ built |
| v3 | Progressive skill depth | ✅ built |
| v4 | Ambiguous / adversarial routing | ✅ built |
| v5 | Public leaderboard + comparison runs | 🔲 not started |
| **v6** | **Format sensitivity + repair pipeline** | **✅ built (this session)** |

---

## Future Work (not started)

| Item | What it is | Unlocks |
|---|---|---|
| `repair/compare-runs.ts` | Diffs two recommendation.json files; emits pass/fail verdict for Phase 6 | Automated Phase 6 |
| `leaderboard/format-matrix.json` | Public leaderboard for model × format compatibility | Community benchmarking |
| `suites/routing-format/` — 200-skill manifest | Remaining 150 skills (current manifest has 50) | Full 200-skill format run |
| `skill-fix` paywall delivery | Mechanism for distributing `skill-fix-{runId}.md` to paying customers | Commercial phase |

---

## Testing Start Checklist

Before your first real run:

- [ ] `npm install` in `runner/`
- [ ] Set env var for your provider (`GROQ_API_KEY`, `OPENAI_API_KEY`, etc.)
- [ ] Smoke test: `npm run smoke:format` (10 skills × 3 formats, mock provider, offline)
- [ ] First real run: `npm run fix:groq` (chains Phase 2 + Phase 5 in one command)
- [ ] Read `results/skill-fix-{runId}.md`
- [ ] Apply recommended changes
- [ ] Re-run: `npm run bench:groq:format` (Phase 6)
- [ ] Compare described accuracy and format_spread between the two run IDs
