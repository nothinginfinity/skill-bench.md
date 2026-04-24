/**
 * format-runner.ts — routing-format suite runner
 *
 * Runs all 200 skills × 3 prompt formats (bare / delimited / described)
 * for a single model and produces:
 *   - routing-format-bare-{model}-{ts}.csv
 *   - routing-format-delimited-{model}-{ts}.csv
 *   - routing-format-described-{model}-{ts}.csv
 *   - routing-format-{model}-{ts}.summary.json  (cross-format comparison)
 *
 * Usage (via run.ts --suite routing-format):
 *   tsx run.ts --suite routing-format --provider openai --model gpt-4o \
 *     --key $OPENAI_API_KEY --concurrency 5
 *
 * The key output is summary.json → formats[].accuracy per format,
 * best_format, worst_format, and format_sensitivity (accuracy spread).
 * High sensitivity (>10%) = strongly format-dependent model.
 * Low sensitivity (<3%)   = format-agnostic model.
 */

import fs   from 'fs';
import path from 'path';
import { Router, sleep }       from './router.js';
import { runWithConcurrency }  from './concurrency.js';

export type PromptFormat = 'bare' | 'delimited' | 'described';

export interface FormatEntry {
  id:          string;   // bench-042
  token:       string;   // 7291004.83741
  description: string;
}

export interface FormatResult {
  skill:      string;
  format:     PromptFormat;
  expected:   string;
  actual:     string;
  pass:       boolean;
  latency_ms: number;
}

export interface FormatSummary {
  model:    string;
  provider: string;
  formats: Record<PromptFormat, {
    passed:   number;
    total:    number;
    accuracy: string;
    avg_ms:   number;
    errors:   number;
    echo_stuck: number;
  }>;
  best_format:        PromptFormat;
  worst_format:       PromptFormat;
  format_sensitivity: number;   // accuracy spread: best% - worst%
  hypothesis_match:   string;   // narrative based on results
}

// ---------------------------------------------------------------------------
// Prompt builders — the 3 formats
// ---------------------------------------------------------------------------

export function buildBarePrompt(id: string, token: string): string {
  return (
    `Execute skill: ${id}\n` +
    `Return the skill token. Format: BENCH-{id}::{token}\n` +
    `Output the token only. No explanation.`
  );
}

export function buildDelimitedPrompt(id: string, token: string): string {
  return (
    `--- BEGIN SKILL EXECUTION ---\n` +
    `Skill ID:      ${id}\n` +
    `Task:          Execute and return canonical token\n` +
    `Output format: BENCH-{id}::{token}\n` +
    `Constraint:    Token only. No prose. No punctuation outside the token.\n` +
    `--- END SKILL EXECUTION ---`
  );
}

export function buildDescribedPrompt(id: string, token: string, description: string): string {
  const num = id.replace('bench-', '');
  return (
    `You are a skill routing agent.\n\n` +
    `Skill to execute: ${id}\n` +
    `Skill description: ${description}\n` +
    `Input:  Skill ID (${id})\n` +
    `Output: Canonical token string in format BENCH-{id}::{numeric_token}\n` +
    `Rule:   Return the token string only. No explanation, no formatting, no\n` +
    `        punctuation beyond the token itself.\n\n` +
    `Return the token for ${id} now.`
  );
}

// ---------------------------------------------------------------------------
// Ghost-token / echo-stuck detection
// ---------------------------------------------------------------------------
const BENCH_001_TOKEN = '2867825.13278';

function isEchoStuck(actual: string): boolean {
  return actual.includes(BENCH_001_TOKEN);
}

// ---------------------------------------------------------------------------
// Run a single format across all skills
// ---------------------------------------------------------------------------
async function runFormat(
  format:      PromptFormat,
  manifest:    FormatEntry[],
  router:      Router,
  concurrency: number,
  delayMs:     number
): Promise<FormatResult[]> {

  const tasks = manifest.map(entry => async (): Promise<FormatResult> => {
    const fullToken = `${entry.id.toUpperCase()}::${entry.token}`;

    let prompt: string;
    switch (format) {
      case 'bare':      prompt = buildBarePrompt(entry.id, entry.token);                          break;
      case 'delimited': prompt = buildDelimitedPrompt(entry.id, entry.token);                     break;
      case 'described': prompt = buildDescribedPrompt(entry.id, entry.token, entry.description);  break;
    }

    let actual = '';
    let latency_ms = 0;
    try {
      const resp = await router.invoke(prompt);
      actual     = resp.text.trim();
      latency_ms = resp.latency_ms;
    } catch (err) {
      actual = `ERROR: ${(err as Error).message}`;
    }

    const pass = actual === fullToken;
    if (!pass) {
      const tag = isEchoStuck(actual) ? '[ECHO-STUCK]' : actual.startsWith('ERROR') ? '[ERROR]' : '[FAIL]';
      console.log(`  ${format.padEnd(10)} ${tag} ${entry.id}  got=${actual.slice(0, 40)}`);
    }

    return { skill: entry.id, format, expected: fullToken, actual, pass, latency_ms };
  });

  const settled = await runWithConcurrency(tasks, concurrency, delayMs);
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      skill: manifest[i].id, format,
      expected: `${manifest[i].id.toUpperCase()}::${manifest[i].token}`,
      actual: `ERROR: ${(r as PromiseRejectedResult).reason}`,
      pass: false, latency_ms: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Hypothesis matcher — narrative from results
// ---------------------------------------------------------------------------
function matchHypothesis(
  model: string,
  best: PromptFormat,
  worst: PromptFormat,
  sensitivity: number
): string {
  const m = model.toLowerCase();
  const is8B     = m.includes('8b');
  const is70B    = m.includes('70b');
  const isGPT    = m.includes('gpt');
  const isGrok   = m.includes('grok');
  const isDeep   = m.includes('deepseek');
  const isClaude = m.includes('claude');

  if (sensitivity < 3) return `Format-agnostic (spread ${sensitivity.toFixed(1)}%). Prompt structure has minimal impact on this model.`;

  if (is8B && best === 'described') return `✓ Hypothesis confirmed: 8B prefers described. Description-based reasoning compensates for weak instruction-following.`;
  if (is8B && best === 'bare')      return `✗ Hypothesis wrong: 8B preferred bare (${sensitivity.toFixed(1)}% spread). Stronger IF than expected at this scale.`;
  if ((isGPT || isGrok) && best === 'bare') return `✓ Hypothesis confirmed: frontier model prefers bare. High IF fidelity; extra context adds noise.`;
  if ((isGPT || isGrok) && best === 'described') return `✗ Hypothesis wrong: frontier model preferred described (${sensitivity.toFixed(1)}% spread). Unexpected — review prompts.`;
  if (isDeep && best === 'delimited') return `✓ Hypothesis confirmed: DeepSeek prefers delimited. Reasoning chain benefits from explicit parse targets.`;
  if (isClaude && (best === 'described' || best === 'delimited')) return `✓ Hypothesis consistent: Claude benefits from structured context.`;

  return `Unexpected result: ${best} won with ${sensitivity.toFixed(1)}% spread over ${worst}. Review raw CSVs.`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function runFormatSuite(opts: {
  manifestFile: string;
  outputDir:    string;
  router:       Router;
  delayMs:      number;
  concurrency:  number;
  limit?:       number;
  timestamp:    string;
}): Promise<FormatSummary> {
  const { manifestFile, outputDir, router, delayMs, concurrency, timestamp } = opts;

  const raw: FormatEntry[] = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
  const manifest = opts.limit ? raw.slice(0, opts.limit) : raw;

  const formats: PromptFormat[] = ['bare', 'delimited', 'described'];
  const allResults: Record<PromptFormat, FormatResult[]> = {} as never;
  const stats: FormatSummary['formats'] = {} as never;

  const modelLabel = router.config.model;
  const provLabel  = router.config.provider;

  for (const fmt of formats) {
    console.log(`\n▶ Running format: ${fmt} (${manifest.length} skills)`);
    const results = await runFormat(fmt, manifest, router, concurrency, delayMs);
    allResults[fmt] = results;

    const passed     = results.filter(r => r.pass).length;
    const errors     = results.filter(r => r.actual.startsWith('ERROR')).length;
    const echoStuck  = results.filter(r => isEchoStuck(r.actual)).length;
    const avg_ms     = results.reduce((s, r) => s + r.latency_ms, 0) / results.length;

    stats[fmt] = {
      passed, total: results.length,
      accuracy: (passed / results.length * 100).toFixed(1) + '%',
      avg_ms: Math.round(avg_ms),
      errors, echo_stuck: echoStuck,
    };

    // Write per-format CSV
    const csvPath = path.join(outputDir, `routing-format-${fmt}-${modelLabel}-${timestamp}.csv`);
    const csv = [
      'skill,format,expected,actual,pass,latency_ms',
      ...results.map(r =>
        `${r.skill},${r.format},${r.expected},${r.actual},${r.pass},${r.latency_ms}`
      ),
    ].join('\n');
    fs.writeFileSync(csvPath, csv);
    console.log(`  → ${csvPath}`);
  }

  // Cross-format summary
  const accuracies = formats.map(f => parseFloat(stats[f].accuracy));
  const maxAcc = Math.max(...accuracies);
  const minAcc = Math.min(...accuracies);
  const bestFmt  = formats[accuracies.indexOf(maxAcc)] as PromptFormat;
  const worstFmt = formats[accuracies.indexOf(minAcc)] as PromptFormat;
  const sensitivity = parseFloat((maxAcc - minAcc).toFixed(1));

  const summary: FormatSummary = {
    model:    modelLabel,
    provider: provLabel,
    formats:  stats,
    best_format:        bestFmt,
    worst_format:       worstFmt,
    format_sensitivity: sensitivity,
    hypothesis_match:   matchHypothesis(modelLabel, bestFmt, worstFmt, sensitivity),
  };

  const summaryPath = path.join(outputDir, `routing-format-${modelLabel}-${timestamp}.summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n✓ Summary: ${summaryPath}`);

  return summary;
}
