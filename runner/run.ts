#!/usr/bin/env node
/**
 * run.ts — CLI entrypoint for skill-bench.md
 *
 * Usage:
 *   npx tsx runner/run.ts [flags]
 *
 * Core flags:
 *   --suite        routing-flat | routing-seeded | loading-progressive | loading-mixed-depth
 *   --provider     openai | anthropic | gemini | deepseek | groq | cerebras | mock
 *   --model        model name for the chosen provider
 *   --key          API key (or set env var)
 *   --delay        ms to wait after each request completes (default 0)
 *   --concurrency  max in-flight requests at once (default 1 = sequential)
 *
 * Mode flag (routing suites only):
 *   --mode         echo   — prompt shows expected token inline (default)
 *                  recall — prompt hides token; model must return from context
 *                  seeded — HMAC token per run, zero memorisation advantage
 *
 * Extra flags:
 *   --limit N      only run first N skills (smoke test)
 *
 * Safe concurrency defaults by provider:
 *   Groq / Cerebras free tier  : --concurrency 1 --delay 2000
 *   OpenAI / Anthropic / Gemini : --concurrency 5 --delay 0
 *   DeepSeek                    : --concurrency 3 --delay 0
 *
 * Fix log:
 *   2026-04-24  fix  — concurrency guard: semaphore limits in-flight requests.
 *               Concurrent fire without semaphore caused 429 flood on Groq
 *               (167/200 errors) and echo-stuck ghost tokens on OpenAI
 *               (190/200 bench-001 token echoed, latency 192ms→800ms+).
 *   2026-04-24  Fix 1 — token-echo prevention via --mode recall/seeded
 *   2026-04-24  Fix 2 — 429 retry with exponential backoff in router.ts
 *   2026-04-24  Fix 3 — placeholder hallucination detection + HALLUCINATED flag
 *   2026-04-24  feat  — --mode selector, --limit flag, MODE column in CSV
 */

import fs   from 'fs';
import path from 'path';
import { createRouter, Provider, RouterConfig, sleep } from './router.js';
import { runSeededSuite }      from './seeded-runner.js';
import { runProgressiveSuite } from './progressive-runner.js';
import { runWithConcurrency }  from './concurrency.js';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..');

// ---------------------------------------------------------------------------
// Placeholder guard — Fix 3
// ---------------------------------------------------------------------------
const PLACEHOLDER_PATTERNS = [
  /^1234567\./,
  /^0000000\./,
  /^9999999\./,
  /^1111111\./,
  /^1000000\./,
];
function isPlaceholder(token: string): boolean {
  const suffix = token.split('::')[1] ?? '';
  return PLACEHOLDER_PATTERNS.some(p => p.test(suffix));
}

// ---------------------------------------------------------------------------
// Prompt builders by mode
// ---------------------------------------------------------------------------
export type BenchMode = 'echo' | 'recall' | 'seeded';

function buildEchoPrompt(skill: string, token: string): string {
  return (
    `You are running skill-bench suite: routing-flat (echo mode).\n` +
    `Execute skill: ${skill}\n` +
    `Return ONLY this exact token string — no explanation, no punctuation:\n` +
    `${token}`
  );
}

function buildRecallPrompt(skill: string): string {
  return (
    `You are running skill-bench suite: routing-flat (recall mode).\n` +
    `Execute skill: ${skill}\n` +
    `Return ONLY the canonical token for this skill.\n` +
    `Format: BENCH-{id}::{numeric_token}\n` +
    `No explanation. No punctuation. Token only.`
  );
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? 'true';
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args        = parseArgs(process.argv);
  const suite       = args['suite']       ?? 'routing-flat';
  const provider    = (args['provider']   ?? 'mock') as Provider;
  const model       = args['model']       ?? 'mock';
  const delayMs     = parseInt(args['delay']       ?? '0',  10);
  const concurrency = parseInt(args['concurrency'] ?? '1',  10);
  const limit       = args['limit'] ? parseInt(args['limit'], 10) : Infinity;

  // Mode resolution
  let mode: BenchMode = (args['mode'] as BenchMode) ?? 'echo';
  if (suite === 'routing-seeded') mode = 'seeded';

  // Warn if concurrency > 1 without delay on rate-limited providers
  if (concurrency > 1 && delayMs === 0 && (provider === 'groq' || provider === 'cerebras')) {
    console.warn(
      `⚠️  WARNING: --concurrency ${concurrency} with no --delay on ${provider} free tier.\n` +
      `   This will likely trigger 429 rate limits. Recommended: --concurrency 1 --delay 2000\n`
    );
  }

  const apiKey =
    args['key'] ??
    process.env.OPENAI_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.GROQ_API_KEY ??
    process.env.CEREBRAS_API_KEY;

  const routerConfig: RouterConfig = { provider, model, apiKey };
  const router = createRouter(routerConfig);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir    = path.join(ROOT, 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const outBase     = path.join(outDir, `${suite}-${mode}-${model}-${timestamp}`);
  const csvPath     = `${outBase}.csv`;
  const summaryPath = `${outBase}.summary.json`;

  console.log(`\n═══ skill-bench.md runner ═══`);
  console.log(`Suite:       ${suite}`);
  console.log(`Mode:        ${mode}`);
  console.log(`Provider:    ${provider}`);
  console.log(`Model:       ${model}`);
  console.log(`Concurrency: ${concurrency} (max in-flight)`);
  console.log(`Delay:       ${delayMs}ms after each completion`);
  if (limit < Infinity) console.log(`Limit:       first ${limit} skills`);
  console.log(`Output:      ${csvPath}\n`);

  let summary: Record<string, unknown> = {
    suite, mode, model, provider, timestamp,
    concurrency, delayMs,
  };

  // -------------------------------------------------------------------------
  // routing-flat — supports all 3 modes
  // -------------------------------------------------------------------------
  if (suite === 'routing-flat') {
    const manifestPath = path.join(ROOT, 'manifest.json');
    const manifest     = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      .slice(0, limit === Infinity ? undefined : limit);

    if (mode === 'seeded') {
      const seededResults = await runSeededSuite({
        manifestFile: manifestPath, outputCSV: csvPath, router, delayMs, concurrency,
      });
      const passed = seededResults.filter(r => r.pass).length;
      summary = { ...summary, total: seededResults.length, passed,
        accuracy: ((passed / seededResults.length) * 100).toFixed(1) + '%' };
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
      printSummary(summary, csvPath);
      return;
    }

    type FlatResult = {
      skill: string; expected: string; actual: string;
      pass: boolean; hallucinated: boolean; latency_ms: number; mode: BenchMode;
    };

    // Build tasks array for semaphore runner
    const tasks = manifest.map((entry: { skill: string; token: string }) => async (): Promise<FlatResult> => {
      const prompt = mode === 'echo'
        ? buildEchoPrompt(entry.skill, entry.token)
        : buildRecallPrompt(entry.skill);

      let actual = '';
      let latency_ms = 0;
      try {
        const resp = await router.invoke(prompt);
        actual     = resp.text;
        latency_ms = resp.latency_ms;
      } catch (err) {
        actual = `ERROR: ${(err as Error).message}`;
      }

      const pass         = actual.trim() === entry.token;
      const hallucinated = !pass && isPlaceholder(actual.trim());

      if (!pass) {
        const tag = hallucinated ? '[HALLUCINATED]' : '[FAIL]';
        console.log(`${tag} ${entry.skill}  expected=${entry.token}  got=${actual.trim()}`);
      }

      return { skill: entry.skill, expected: entry.token, actual: actual.trim(),
        pass, hallucinated, latency_ms, mode };
    });

    // Run through semaphore
    const settled = await runWithConcurrency(tasks, concurrency, delayMs);
    const results: FlatResult[] = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const entry = manifest[i];
      return {
        skill: entry.skill, expected: entry.token,
        actual: `ERROR: ${(r as PromiseRejectedResult).reason}`,
        pass: false, hallucinated: false, latency_ms: 0, mode,
      };
    });

    const passed       = results.filter(r => r.pass).length;
    const hallucinated = results.filter(r => r.hallucinated).length;
    const errors       = results.filter(r => r.actual.startsWith('ERROR:')).length;
    const accuracy     = passed / results.length;

    const csv = [
      'skill,expected,actual,pass,hallucinated,latency_ms,mode',
      ...results.map(r =>
        `${r.skill},${r.expected},${r.actual},${r.pass},${r.hallucinated},${r.latency_ms},${r.mode}`
      ),
    ].join('\n');
    fs.writeFileSync(csvPath, csv);

    summary = { ...summary, total: results.length, passed, hallucinated, errors,
      accuracy: (accuracy * 100).toFixed(1) + '%' };

  // -------------------------------------------------------------------------
  // routing-seeded
  // -------------------------------------------------------------------------
  } else if (suite === 'routing-seeded') {
    const manifestPath  = path.join(ROOT, 'manifest.json');
    const seededResults = await runSeededSuite({
      manifestFile: manifestPath, outputCSV: csvPath, router, delayMs, concurrency,
    });
    const passed = seededResults.filter(r => r.pass).length;
    summary = { ...summary, total: seededResults.length, passed,
      accuracy: ((passed / seededResults.length) * 100).toFixed(1) + '%' };

  // -------------------------------------------------------------------------
  // loading-progressive | loading-mixed-depth
  // -------------------------------------------------------------------------
  } else if (suite === 'loading-progressive' || suite === 'loading-mixed-depth') {
    const manifestPath = path.join(ROOT, 'suites/loading-progressive/progressive-manifest.json');
    const results      = await runProgressiveSuite({
      manifestFile: manifestPath, outputCSV: csvPath, router, delayMs, concurrency,
    });
    const n = results.length;
    const routeAcc = results.filter(r => r.route_correct).length / n;
    const depthAcc = results.filter(r => r.depth_correct).length / n;
    const chainAcc = results.filter(r => r.layer_chain_correct).length / n;
    const avgEff   = results.reduce((s, r) => s + r.efficiency, 0) / n;
    summary = { ...summary, total: n,
      routing_accuracy:     (routeAcc * 100).toFixed(1) + '%',
      depth_accuracy:       (depthAcc * 100).toFixed(1) + '%',
      layer_chain_accuracy: (chainAcc * 100).toFixed(1) + '%',
      routing_efficiency:   avgEff.toFixed(3) };

  } else {
    console.error(`Unknown suite: ${suite}`);
    process.exit(1);
  }

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  printSummary(summary, csvPath);
}

function printSummary(s: Record<string, unknown>, csvPath: string) {
  console.log(`\n═══ Summary ═══`);
  console.log(JSON.stringify(s, null, 2));
  console.log(`\nDone. Results: ${csvPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
