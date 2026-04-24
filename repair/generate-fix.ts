/**
 * generate-fix.ts — Phase 5 skill-fix report generator
 *
 * Reads the artifacts from a completed routing-format run and emits
 * a skill-fix-{runId}.md report. Every claim in the report is backed
 * by a specific data point from the CSVs — no opinion, no filler.
 *
 * Usage:
 *   tsx repair/generate-fix.ts --run-id 2026-04-24T08-00-00
 *   tsx repair/generate-fix.ts --run-id 2026-04-24T08-00-00 --results ./results --out ./results
 *
 * Required input files (all produced by format-runner.ts --format all):
 *   results/routing-format-{model}-{runId}.recommendation.json
 *   results/routing-format-{model}-{runId}.bare.csv
 *   results/routing-format-{model}-{runId}.delimited.csv
 *   results/routing-format-{model}-{runId}.described.csv
 *
 * Output:
 *   results/skill-fix-{runId}.md
 */

import fs   from 'fs';
import path from 'path';
import type { Recommendation, FormatResult, FormatName } from '../suites/routing-format/format-runner.js';

const ALL_FORMATS: FormatName[] = ['bare', 'delimited', 'described'];

// ---------------------------------------------------------------------------
// CSV parser — minimal, no deps
// ---------------------------------------------------------------------------
function parseFormatCSV(content: string): FormatResult[] {
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h.trim()] = (cols[i] ?? '').trim(); });
    return {
      skill:        row['skill'],
      expected:     row['expected'],
      actual:       row['actual'],
      pass:         row['pass'] === 'true',
      hallucinated: row['hallucinated'] === 'true',
      latency_ms:   parseFloat(row['latency_ms'] ?? '0'),
      format:       row['format'] as FormatName,
    };
  });
}

// ---------------------------------------------------------------------------
// Worst performer analysis
// Cross-format failures: skills that failed in 2 or more formats
// ---------------------------------------------------------------------------
interface SkillFailSummary {
  skill:        string;
  fail_count:   number;          // how many formats it failed (max 3)
  formats_failed: FormatName[];
  formats_passed: FormatName[];
}

function findWorstPerformers(
  resultsByFormat: Record<FormatName, FormatResult[]>,
  topN = 10
): SkillFailSummary[] {
  // Build skill → format results map
  const skillMap: Record<string, Record<FormatName, boolean>> = {};

  for (const fmt of ALL_FORMATS) {
    for (const r of resultsByFormat[fmt]) {
      if (!skillMap[r.skill]) skillMap[r.skill] = {} as Record<FormatName, boolean>;
      skillMap[r.skill][fmt] = r.pass;
    }
  }

  return Object.entries(skillMap)
    .map(([skill, fmtResults]) => {
      const formats_failed = ALL_FORMATS.filter(f => fmtResults[f] === false);
      const formats_passed = ALL_FORMATS.filter(f => fmtResults[f] === true);
      return { skill, fail_count: formats_failed.length, formats_failed, formats_passed };
    })
    .filter(s => s.fail_count >= 2)
    .sort((a, b) => b.fail_count - a.fail_count || a.skill.localeCompare(b.skill))
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Per-format stats helper
// ---------------------------------------------------------------------------
interface FormatStats {
  total:        number;
  passed:       number;
  failed:       number;
  errors:       number;
  hallucinated: number;
  accuracy:     number;  // 0–100
  avg_ms:       number;
}

function statsFor(results: FormatResult[]): FormatStats {
  const total        = results.length;
  const passed       = results.filter(r => r.pass).length;
  const errors       = results.filter(r => r.actual.startsWith('ERROR:')).length;
  const hallucinated = results.filter(r => r.hallucinated).length;
  const avg_ms       = results.reduce((s, r) => s + r.latency_ms, 0) / total;
  return {
    total, passed,
    failed:  total - passed,
    errors,
    hallucinated,
    accuracy: parseFloat((passed / total * 100).toFixed(1)),
    avg_ms:   parseFloat(avg_ms.toFixed(0)),
  };
}

// ---------------------------------------------------------------------------
// Markdown report builder
// ---------------------------------------------------------------------------
function buildReport(
  rec: Recommendation,
  statsByFormat: Record<FormatName, FormatStats>,
  worst: SkillFailSummary[]
): string {
  const { model, provider, run_id, best_format, worst_format,
          format_spread_pp, confidence, recommendation,
          reason, gains, skill_authoring_rule, next_suite,
          paywall_artifact } = rec;

  const bare  = statsByFormat['bare'];
  const delim = statsByFormat['delimited'];
  const desc  = statsByFormat['described'];

  const confidenceBadge = confidence === 'high'   ? '🔴 HIGH'
                        : confidence === 'medium' ? '🟡 MEDIUM'
                        :                           '🟢 LOW';

  // ── Summary paragraph ──────────────────────────────────────────────────
  const summaryLines = [
    `Your \`${model}\` skill files currently route at **${bare.accuracy}%** accuracy in bare format.`,
  ];
  if (gains.described_vs_bare > 0) {
    summaryLines.push(
      `Switching to described format raises accuracy by **+${gains.described_vs_bare}pp** to ${desc.accuracy}%.`
    );
  } else if (gains.delimited_vs_bare > 0) {
    summaryLines.push(
      `Switching to delimited format raises accuracy by **+${gains.delimited_vs_bare}pp** to ${delim.accuracy}%.`
    );
  }
  summaryLines.push(
    `${recommendation}`
  );

  // ── Worst performers table ──────────────────────────────────────────────
  let worstTable = '';
  if (worst.length > 0) {
    const rows = worst.map(s =>
      `| \`${s.skill}\` | ${s.fail_count}/3 | ${s.formats_failed.join(', ')} | ${s.formats_passed.join(', ') || '—'} |`
    );
    worstTable = [
      '| Skill | Formats Failed | Failed In | Passed In |',
      '|---|---|---|---|',
      ...rows,
    ].join('\n');
  } else {
    worstTable = '_No skill failed in 2+ formats. Cross-format failures are isolated._';
  }

  // ── Required changes field template ────────────────────────────────────
  const fieldTemplate = best_format === 'described' ? [
    '```yaml',
    '# Add these fields to every skill file:',
    'description:  "<what the skill does, 1–2 sentences>"',
    'input_type:   "<what the caller provides>"',
    'output_type:  "<what the skill returns>"',
    'constraints:',
    '  - "exact match required"',
    '  - "no explanation"',
    '  - "no punctuation"',
    '```',
  ].join('\n') : best_format === 'delimited' ? [
    '```',
    '# Wrap every skill invocation with boundary markers:',
    '--- BEGIN SKILL: {skill_id} ---',
    'TASK: Execute this skill and return its token.',
    'TOKEN: {token}',
    'INSTRUCTION: Return ONLY the TOKEN value above. Exact match. No prose.',
    '--- END SKILL: {skill_id} ---',
    '```',
  ].join('\n') : [
    '```',
    '# Bare format is already optimal for this model.',
    '# Ensure skill invocations use the minimal pattern:',
    'Execute skill: {skill_id}',
    'Return ONLY this token — no explanation, no punctuation:',
    '{token}',
    '```',
  ].join('\n');

  // ── Verification command ────────────────────────────────────────────────
  const providerFlag = provider === 'groq' ? 'groq' : provider === 'openai' ? 'openai' : provider;
  const rerunCmd     = `npm run bench:${providerFlag}:format`;
  const threshold    = parseFloat((desc.accuracy + 5).toFixed(1));

  // ── Assemble report ─────────────────────────────────────────────────────
  const lines: string[] = [
    `# Skill Fix Report — \`${model}\``,
    ``,
    `**Run ID:** \`${run_id}\`  `,
    `**Provider:** ${provider}  `,
    `**Suite:** routing-format  `,
    `**Confidence:** ${confidenceBadge} (format_spread = ${format_spread_pp}pp)`,
    ``,
    `---`,
    ``,
    `## Summary`,
    ``,
    summaryLines.join(' '),
    ``,
    `---`,
    ``,
    `## Evidence`,
    ``,
    `| Format | Accuracy | Passed | Failed | Errors | Hallucinated | Avg Latency |`,
    `|---|---|---|---|---|---|---|`,
    `| bare      | ${bare.accuracy}%  | ${bare.passed}  | ${bare.failed}  | ${bare.errors}  | ${bare.hallucinated}  | ${bare.avg_ms}ms  |`,
    `| delimited | ${delim.accuracy}% | ${delim.passed} | ${delim.failed} | ${delim.errors} | ${delim.hallucinated} | ${delim.avg_ms}ms |`,
    `| described | ${desc.accuracy}%  | ${desc.passed}  | ${desc.failed}  | ${desc.errors}  | ${desc.hallucinated}  | ${desc.avg_ms}ms  |`,
    ``,
    `**Best format:** \`${best_format}\`  `,
    `**Worst format:** \`${worst_format}\`  `,
    `**Format spread:** ${format_spread_pp}pp  `,
    ``,
    `> ${reason}`,
    ``,
    `**Gains:**`,
    `- delimited vs bare: **${gains.delimited_vs_bare > 0 ? '+' : ''}${gains.delimited_vs_bare}pp**`,
    `- described vs bare: **${gains.described_vs_bare > 0 ? '+' : ''}${gains.described_vs_bare}pp**`,
    `- described vs delimited: **${gains.described_vs_delimited > 0 ? '+' : ''}${gains.described_vs_delimited}pp**`,
    ``,
    `---`,
    ``,
    `## Worst Performers`,
    ``,
    `Skills that failed in 2 or more formats — highest-priority fixes:`,
    ``,
    worstTable,
    ``,
    `---`,
    ``,
    `## Required Changes`,
    ``,
    `**Authoring rule:** ${skill_authoring_rule}`,
    ``,
    fieldTemplate,
    ``,
    `---`,
    ``,
    `## Verification`,
    ``,
    `After patching, re-run the same suite:`,
    ``,
    `\`\`\`bash`,
    rerunCmd,
    `\`\`\``,
    ``,
    `**Pass threshold:** described accuracy ≥ **${threshold}%**  `,
    `**Format spread target:** < 15pp  `,
    ``,
    `If described accuracy does not reach ${threshold}%, escalate to \`${next_suite}\` to`,
    `identify whether layer-depth failures compound the format sensitivity.`,
    ``,
    `---`,
    ``,
    `_Generated by skill-bench.md · repair/generate-fix.ts · artifact: \`${paywall_artifact}\`_`,
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1] ?? 'true'; i++; }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args      = parseArgs(process.argv);
  const runId     = args['run-id'];
  const resultsDir = path.resolve(args['results'] ?? './results');
  const outDir    = path.resolve(args['out'] ?? './results');

  if (!runId) {
    console.error('Error: --run-id is required.');
    console.error('Example: tsx repair/generate-fix.ts --run-id 2026-04-24T08-00-00');
    process.exit(1);
  }

  // ── Locate input files ──────────────────────────────────────────────────
  // recommendation.json contains model name — glob for it
  const allFiles = fs.readdirSync(resultsDir);
  const recFile  = allFiles.find(f =>
    f.includes(runId) && f.endsWith('.recommendation.json')
  );

  if (!recFile) {
    console.error(`Error: No recommendation.json found for run-id "${runId}" in ${resultsDir}`);
    console.error('Run format-runner.ts --format all first to generate the required artifacts.');
    process.exit(1);
  }

  const recPath = path.join(resultsDir, recFile);
  const rec: Recommendation = JSON.parse(fs.readFileSync(recPath, 'utf-8'));

  // Derive model slug from filename: routing-format-{model}-{runId}.recommendation.json
  const modelSlug = recFile
    .replace('routing-format-', '')
    .replace(`-${runId}.recommendation.json`, '');

  console.log(`\n═══ Phase 5: skill-fix generator ═══`);
  console.log(`Run ID:  ${runId}`);
  console.log(`Model:   ${modelSlug}`);
  console.log(`Reading: ${recPath}`);

  // ── Load per-format CSVs ────────────────────────────────────────────────
  const resultsByFormat = {} as Record<FormatName, FormatResult[]>;

  for (const fmt of ALL_FORMATS) {
    const csvName = `routing-format-${modelSlug}-${runId}.${fmt}.csv`;
    const csvPath = path.join(resultsDir, csvName);
    if (!fs.existsSync(csvPath)) {
      console.error(`Error: Missing ${csvPath}`);
      console.error(`Run format-runner.ts --format ${fmt} to generate it.`);
      process.exit(1);
    }
    resultsByFormat[fmt] = parseFormatCSV(fs.readFileSync(csvPath, 'utf-8'));
    console.log(`Loaded:  ${csvName} (${resultsByFormat[fmt].length} rows)`);
  }

  // ── Compute stats + worst performers ───────────────────────────────────
  const statsByFormat = {} as Record<FormatName, FormatStats>;
  for (const fmt of ALL_FORMATS) {
    statsByFormat[fmt] = statsFor(resultsByFormat[fmt]);
  }

  const worst = findWorstPerformers(resultsByFormat, 10);
  console.log(`\nWorst performers (failed 2+ formats): ${worst.length} skills`);

  // ── Build + write report ────────────────────────────────────────────────
  const report    = buildReport(rec, statsByFormat, worst);
  const outName   = `skill-fix-${runId}.md`;
  const outPath   = path.join(outDir, outName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, report);

  console.log(`\n── Report ──`);
  console.log(`  Confidence:  ${rec.confidence.toUpperCase()}`);
  console.log(`  Best format: ${rec.best_format}  (spread: ${rec.format_spread_pp}pp)`);
  console.log(`  Worst performers in report: ${worst.length}`);
  console.log(`  Output: ${outPath}`);
  console.log(`\nDone. Artifact: ${outName}`);
}

main().catch(err => { console.error(err); process.exit(1); });
