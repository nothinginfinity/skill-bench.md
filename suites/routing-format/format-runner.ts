/**
 * format-runner.ts — routing-format suite runner
 *
 * Tests the same skills in 3 prompt formats to build a model × format
 * compatibility matrix. This directly informs how to author skills for
 * different model tiers.
 *
 * Formats:
 *   bare       — skill ID only, minimal scaffolding
 *   delimited  — hard boundary markers (--- SKILL / --- END SKILL ---)
 *   described  — full skill description: purpose, input, output, constraints
 *
 * Usage:
 *   tsx format-runner.ts --format all --provider openai --model gpt-4o --key $KEY
 *   tsx format-runner.ts --format bare --provider groq --model llama-3.1-8b-instant --key $KEY --delay 2000
 *
 * Output:
 *   results/routing-format-{model}-{timestamp}.bare.csv
 *   results/routing-format-{model}-{timestamp}.delimited.csv
 *   results/routing-format-{model}-{timestamp}.described.csv
 *   results/routing-format-{model}-{timestamp}.matrix.csv   ← compatibility matrix
 *   results/routing-format-{model}-{timestamp}.summary.json
 */

import fs   from 'fs';
import path from 'path';
import { createRouter, Provider, RouterConfig } from '../router.js';
import { runWithConcurrency }                   from '../concurrency.js';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');

export type FormatName = 'bare' | 'delimited' | 'described';
export const ALL_FORMATS: FormatName[] = ['bare', 'delimited', 'described'];

// ---------------------------------------------------------------------------
// The 3 prompt builders — the core of the experiment
// ---------------------------------------------------------------------------

/**
 * Format A — BARE
 * Minimal. Skill ID + return-token instruction only.
 * No description, no delimiters, no scaffolding.
 *
 * Hypothesis: frontier models (gpt-4o, grok-3, claude) win here.
 * 8B models echo-stuck because nothing resets their context anchor.
 */
export function buildBarePrompt(skillId: string, token: string): string {
  return [
    `Execute skill: ${skillId}`,
    `Return ONLY this token — no explanation, no punctuation:`,
    `${token}`,
  ].join('\n');
}

/**
 * Format B — DELIMITED
 * Hard context boundary markers wrap the prompt.
 * Forces an explicit open/close around every skill invocation.
 *
 * Hypothesis: reasoning models (DeepSeek-reasoner) and structured-output
 * models perform best. The delimiters help models that interpret structure
 * as scope boundaries.
 */
export function buildDelimitedPrompt(skillId: string, token: string): string {
  return [
    `--- BEGIN SKILL: ${skillId} ---`,
    `TASK: Execute this skill and return its token.`,
    `TOKEN: ${token}`,
    `INSTRUCTION: Return ONLY the TOKEN value above. Exact match. No prose.`,
    `--- END SKILL: ${skillId} ---`,
  ].join('\n');
}

/**
 * Format C — DESCRIBED
 * Full skill description: ID, category, purpose, input type, output format,
 * constraints. Model must read and follow structured spec.
 *
 * Hypothesis: 8B models improve significantly (reasoning from description
 * vs bare recall). Frontier models may overthink and add prose.
 * DeepSeek-reasoner excels (uses the spec as a reasoning chain).
 */
export function buildDescribedPrompt(
  skillId: string,
  token: string,
  description: string,
  inputType: string,
  outputType: string,
  constraints: string[]
): string {
  return [
    `SKILL INVOCATION`,
    `================`,
    `ID:          ${skillId}`,
    `Category:    routing`,
    `Description: ${description}`,
    `Input type:  ${inputType}`,
    `Output type: ${outputType}`,
    `Constraints: ${constraints.join('; ')}`,
    ``,
    `Token:       ${token}`,
    ``,
    `Your task: Read the skill spec above. Return ONLY the Token value.`,
    `No explanation. No formatting. The token string only.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-format result type
// ---------------------------------------------------------------------------
export interface FormatResult {
  skill:       string;
  expected:    string;
  actual:      string;
  pass:        boolean;
  hallucinated: boolean;
  latency_ms:  number;
  format:      FormatName;
}

// ---------------------------------------------------------------------------
// Placeholder guard
// ---------------------------------------------------------------------------
const PLACEHOLDER_PATTERNS = [/^1234567\./, /^0000000\./, /^9999999\./, /^1111111\./];
function isPlaceholder(token: string): boolean {
  const suffix = token.split('::')[1] ?? '';
  return PLACEHOLDER_PATTERNS.some(p => p.test(suffix));
}

// ---------------------------------------------------------------------------
// Run a single format pass
// ---------------------------------------------------------------------------
export async function runFormatPass(
  format: FormatName,
  manifest: ManifestEntry[],
  router: ReturnType<typeof createRouter>,
  concurrency: number,
  delayMs: number,
  onProgress?: (skill: string, pass: boolean, format: FormatName) => void
): Promise<FormatResult[]> {
  const tasks = manifest.map(entry => async (): Promise<FormatResult> => {
    let prompt: string;
    switch (format) {
      case 'bare':
        prompt = buildBarePrompt(entry.id, entry.token);
        break;
      case 'delimited':
        prompt = buildDelimitedPrompt(entry.id, entry.token);
        break;
      case 'described':
        prompt = buildDescribedPrompt(
          entry.id, entry.token,
          entry.description, entry.input_type, entry.output_type, entry.constraints
        );
        break;
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

    const pass         = actual === entry.token;
    const hallucinated = !pass && isPlaceholder(actual);
    onProgress?.(entry.id, pass, format);

    return { skill: entry.id, expected: entry.token, actual, pass, hallucinated, latency_ms, format };
  });

  const settled = await runWithConcurrency(tasks, concurrency, delayMs);
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      skill: manifest[i].id, expected: manifest[i].token,
      actual: `ERROR: ${(r as PromiseRejectedResult).reason}`,
      pass: false, hallucinated: false, latency_ms: 0, format,
    };
  });
}

// ---------------------------------------------------------------------------
// Matrix builder — model × format accuracy table
// ---------------------------------------------------------------------------
export function buildMatrix(
  model: string,
  resultsByFormat: Record<FormatName, FormatResult[]>
): MatrixRow {
  const row: MatrixRow = { model } as MatrixRow;
  for (const fmt of ALL_FORMATS) {
    const results = resultsByFormat[fmt];
    const passed  = results.filter(r => r.pass).length;
    const total   = results.length;
    const errors  = results.filter(r => r.actual.startsWith('ERROR:')).length;
    const hallucinated = results.filter(r => r.hallucinated).length;
    const avg_ms  = results.reduce((s, r) => s + r.latency_ms, 0) / total;
    row[`${fmt}_accuracy`]    = parseFloat((passed / total * 100).toFixed(1));
    row[`${fmt}_passed`]      = passed;
    row[`${fmt}_errors`]      = errors;
    row[`${fmt}_hallucinated`] = hallucinated;
    row[`${fmt}_avg_ms`]      = parseFloat(avg_ms.toFixed(0));
  }
  // Best format for this model
  const accuracies = ALL_FORMATS.map(f => ({ f, acc: row[`${f}_accuracy`] as number }));
  row.best_format = accuracies.reduce((a, b) => a.acc >= b.acc ? a : b).f as FormatName;
  row.format_spread = parseFloat((
    Math.max(...accuracies.map(a => a.acc)) -
    Math.min(...accuracies.map(a => a.acc))
  ).toFixed(1));
  return row;
}

interface MatrixRow {
  model: string;
  bare_accuracy: number;       bare_passed: number;       bare_errors: number;       bare_hallucinated: number;       bare_avg_ms: number;
  delimited_accuracy: number;  delimited_passed: number;  delimited_errors: number;  delimited_hallucinated: number;  delimited_avg_ms: number;
  described_accuracy: number;  described_passed: number;  described_errors: number;  described_hallucinated: number;  described_avg_ms: number;
  best_format: FormatName;
  format_spread: number;
  [key: string]: unknown;
}

interface ManifestEntry {
  id: string;
  token: string;
  description: string;
  input_type: string;
  output_type: string;
  constraints: string[];
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------
function resultsToCSV(results: FormatResult[]): string {
  return [
    'skill,expected,actual,pass,hallucinated,latency_ms,format',
    ...results.map(r =>
      `${r.skill},${r.expected},${r.actual},${r.pass},${r.hallucinated},${r.latency_ms},${r.format}`
    ),
  ].join('\n');
}

function matrixToCSV(rows: MatrixRow[]): string {
  const headers = [
    'model',
    'bare_accuracy','bare_passed','bare_errors','bare_hallucinated','bare_avg_ms',
    'delimited_accuracy','delimited_passed','delimited_errors','delimited_hallucinated','delimited_avg_ms',
    'described_accuracy','described_passed','described_errors','described_hallucinated','described_avg_ms',
    'best_format','format_spread',
  ];
  return [
    headers.join(','),
    ...rows.map(row => headers.map(h => row[h] ?? '').join(',')),
  ].join('\n');
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
  const args        = parseArgs(process.argv);
  const provider    = (args['provider']   ?? 'mock') as Provider;
  const model       = args['model']       ?? 'mock';
  const delayMs     = parseInt(args['delay']       ?? '0',  10);
  const concurrency = parseInt(args['concurrency'] ?? '1',  10);
  const limit       = args['limit'] ? parseInt(args['limit'], 10) : Infinity;
  const formatArg   = args['format'] ?? 'all';
  const formats: FormatName[] = formatArg === 'all' ? ALL_FORMATS : [formatArg as FormatName];

  if (concurrency > 1 && delayMs === 0 && (provider === 'groq' || provider === 'cerebras')) {
    console.warn(`⚠️  WARNING: --concurrency ${concurrency} with no --delay on ${provider} free tier.`);
  }

  const apiKey =
    args['key'] ??
    process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ??
    process.env.GEMINI_API_KEY ?? process.env.DEEPSEEK_API_KEY ??
    process.env.GROQ_API_KEY   ?? process.env.CEREBRAS_API_KEY;

  const router = createRouter({ provider, model, apiKey } as RouterConfig);

  const manifestPath = path.join(ROOT, 'suites/routing-format/format-manifest.json');
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    .slice(0, limit === Infinity ? undefined : limit);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir    = path.join(ROOT, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outBase   = path.join(outDir, `routing-format-${model}-${timestamp}`);

  console.log(`\n═══ routing-format suite ═══`);
  console.log(`Provider:    ${provider}`);
  console.log(`Model:       ${model}`);
  console.log(`Formats:     ${formats.join(', ')}`);
  console.log(`Skills:      ${manifest.length}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Delay:       ${delayMs}ms\n`);

  const resultsByFormat: Partial<Record<FormatName, FormatResult[]>> = {};

  for (const fmt of formats) {
    console.log(`\n── Format: ${fmt.toUpperCase()} ──`);
    let done = 0;
    const results = await runFormatPass(
      fmt, manifest, router, concurrency, delayMs,
      (skill, pass, f) => {
        done++;
        const icon = pass ? '✓' : '✗';
        process.stdout.write(`\r  ${icon} ${done}/${manifest.length} [${f}]`);
      }
    );
    process.stdout.write('\n');

    const passed = results.filter(r => r.pass).length;
    console.log(`  Accuracy: ${passed}/${manifest.length} (${(passed/manifest.length*100).toFixed(1)}%)`);

    const csvPath = `${outBase}.${fmt}.csv`;
    fs.writeFileSync(csvPath, resultsToCSV(results));
    console.log(`  Saved: ${csvPath}`);

    resultsByFormat[fmt] = results;
  }

  // Build matrix if all 3 formats ran
  if (formats.length === 3) {
    const matrix = buildMatrix(model, resultsByFormat as Record<FormatName, FormatResult[]>);
    const matrixPath = `${outBase}.matrix.csv`;
    fs.writeFileSync(matrixPath, matrixToCSV([matrix]));
    console.log(`\n── Compatibility Matrix ──`);
    console.log(`  Bare:       ${matrix.bare_accuracy}%`);
    console.log(`  Delimited:  ${matrix.delimited_accuracy}%`);
    console.log(`  Described:  ${matrix.described_accuracy}%`);
    console.log(`  Best format: ${matrix.best_format}  (spread: ${matrix.format_spread}pp)`);
    console.log(`  Matrix saved: ${matrixPath}`);

    const summary = {
      suite: 'routing-format', model, provider, timestamp,
      concurrency, delayMs, skills: manifest.length,
      bare_accuracy:      `${matrix.bare_accuracy}%`,
      delimited_accuracy: `${matrix.delimited_accuracy}%`,
      described_accuracy: `${matrix.described_accuracy}%`,
      best_format:        matrix.best_format,
      format_spread:      `${matrix.format_spread}pp`,
    };
    fs.writeFileSync(`${outBase}.summary.json`, JSON.stringify(summary, null, 2));
    console.log(`  Summary: ${outBase}.summary.json`);
  }

  console.log(`\nDone.`);
}

main().catch(err => { console.error(err); process.exit(1); });
