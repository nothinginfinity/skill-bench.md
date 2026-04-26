#!/usr/bin/env node
/**
 * run.ts — CLI entrypoint for skill-bench.md
 *
 * Usage:
 *   npx tsx runner/run.ts [flags]
 *
 * Suites:
 *   routing-flat        — N skills, echo/recall/seeded mode
 *   routing-format      — N skills × 3 formats (bare/delimited/described)
 *   routing-seeded      — HMAC token per run, anti-memorisation
 *   loading-progressive — depth loading (1-5 layers)
 *   loading-mixed-depth — same, randomised order
 *
 * Flags:
 *   --suite        Suite name (above)
 *   --manifest     Path OR https:// URL to a manifest JSON file.
 *                  Overrides all hardcoded manifest paths.
 *                  If omitted, falls back to previous defaults.
 *   --provider     openai | anthropic | gemini | deepseek | groq | cerebras | mock
 *   --model        Model name
 *   --key          API key
 *   --delay        ms after each request completes (default 0)
 *   --concurrency  max in-flight requests (default 1)
 *   --mode         echo | recall | seeded  (routing-flat only)
 *   --limit N      first N skills only
 *
 * Fix log:
 *   2026-04-26  fix   — --manifest flag: accept file path or URL, wire all suites
 *   2026-04-24  feat  — routing-format suite (3 prompt formats × N skills)
 *   2026-04-24  fix   — concurrency semaphore guard
 *   2026-04-24  fix   — 429 retry with exponential backoff
 *   2026-04-24  fix   — token-echo prevention (--mode recall/seeded)
 *   2026-04-24  fix   — placeholder hallucination detection
 */

import fs   from 'fs';
import path from 'path';
import { createRouter, Provider, RouterConfig, sleep } from './router.js';
import { runSeededSuite }      from './seeded-runner.js';
import { runProgressiveSuite } from './progressive-runner.js';
import { runWithConcurrency }  from './concurrency.js';
import { runFormatSuite }      from './format-runner.js';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..');

const PLACEHOLDER_PATTERNS = [/^1234567\./, /^0000000\./, /^9999999\./, /^1111111\./, /^1000000\./];
function isPlaceholder(token: string): boolean {
  const suffix = token.split('::')[1] ?? '';
  return PLACEHOLDER_PATTERNS.some(p => p.test(suffix));
}

export type BenchMode = 'echo' | 'recall' | 'seeded';

function buildEchoPrompt(skill: string, token: string): string {
  return `You are running skill-bench suite: routing-flat (echo mode).\nExecute skill: ${skill}\nReturn ONLY this exact token string — no explanation, no punctuation:\n${token}`;
}
function buildRecallPrompt(skill: string): string {
  return `You are running skill-bench suite: routing-flat (recall mode).\nExecute skill: ${skill}\nReturn ONLY the canonical token for this skill.\nFormat: BENCH-{id}::{numeric_token}\nNo explanation. No punctuation. Token only.`;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1] ?? 'true'; i++; }
  }
  return args;
}

// ---------------------------------------------------------------------------
// loadManifest — accepts a file path OR an https:// URL
// ---------------------------------------------------------------------------
async function loadManifest(source: string): Promise<unknown[]> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`↓ Fetching manifest from URL: ${source}`);
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status} ${res.statusText} — ${source}`);
    const data = await res.json() as unknown[];
    console.log(`  ✓ ${data.length} skills loaded from URL`);
    return data;
  }
  const data = JSON.parse(fs.readFileSync(source, 'utf-8')) as unknown[];
  console.log(`  ✓ ${data.length} skills loaded from file: ${source}`);
  return data;
}

// ---------------------------------------------------------------------------
// resolveManifest — returns the final manifest source to use for each suite,
// preferring --manifest if supplied, falling back to hardcoded defaults.
// ---------------------------------------------------------------------------
function resolveManifest(args: Record<string, string>, suite: string): string {
  if (args['manifest']) return args['manifest'];

  // Legacy defaults — unchanged behaviour when --manifest is omitted
  if (suite === 'routing-format')                                    return path.join(ROOT, 'suites/routing-format/format-manifest.json');
  if (suite === 'loading-progressive' || suite === 'loading-mixed-depth') return path.join(ROOT, 'suites/loading-progressive/progressive-manifest.json');
  return path.join(ROOT, 'manifest.json');  // routing-flat, routing-seeded
}

async function main() {
  const args        = parseArgs(process.argv);
  const suite       = args['suite']       ?? 'routing-flat';
  const provider    = (args['provider']   ?? 'mock') as Provider;
  const model       = args['model']       ?? 'mock';
  const delayMs     = parseInt(args['delay']       ?? '0', 10);
  const concurrency = parseInt(args['concurrency'] ?? '1', 10);
  const limit       = args['limit'] ? parseInt(args['limit'], 10) : Infinity;

  let mode: BenchMode = (args['mode'] as BenchMode) ?? 'echo';
  if (suite === 'routing-seeded') mode = 'seeded';

  if (concurrency > 1 && delayMs === 0 && (provider === 'groq' || provider === 'cerebras')) {
    console.warn(`⚠️  WARNING: --concurrency ${concurrency} with no --delay on ${provider} free tier.\n   Recommended: --concurrency 1 --delay 2000\n`);
  }

  const apiKey =
    args['key'] ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ??
    process.env.GEMINI_API_KEY ?? process.env.DEEPSEEK_API_KEY ??
    process.env.GROQ_API_KEY ?? process.env.CEREBRAS_API_KEY;

  const router = createRouter({ provider, model, apiKey } as RouterConfig);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir    = path.join(ROOT, 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const manifestSource = resolveManifest(args, suite);

  console.log(`\n═══ skill-bench.md runner ═══`);
  console.log(`Suite:       ${suite}`);
  if (suite !== 'routing-format') console.log(`Mode:        ${mode}`);
  console.log(`Provider:    ${provider}`);
  console.log(`Model:       ${model}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Delay:       ${delayMs}ms`);
  console.log(`Manifest:    ${manifestSource}`);
  if (limit < Infinity) console.log(`Limit:       first ${limit} skills`);

  // -------------------------------------------------------------------------
  // routing-format — 3-format suite
  // -------------------------------------------------------------------------
  if (suite === 'routing-format') {
    // For URL manifests we need to write a temp file since runFormatSuite
    // currently reads from a file path. We handle URLs here then pass the path.
    let manifestFile = manifestSource;
    if (manifestSource.startsWith('http://') || manifestSource.startsWith('https://')) {
      const data = await loadManifest(manifestSource);
      const tmp  = path.join(outDir, `_manifest-tmp-${timestamp}.json`);
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      manifestFile = tmp;
    }

    const summary = await runFormatSuite({
      manifestFile, outputDir: outDir, router, delayMs, concurrency,
      limit: limit === Infinity ? undefined : limit,
      timestamp,
    });
    console.log('\n═══ Summary ═══');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // -------------------------------------------------------------------------
  // All other suites — load manifest now (supports URL or file)
  // -------------------------------------------------------------------------
  const rawManifest = await loadManifest(manifestSource);
  const manifest    = (limit === Infinity ? rawManifest : rawManifest.slice(0, limit)) as Array<{skill: string; token: string; id?: string}>;

  // Normalise entries: mattpocock manifest uses {id, token}, routing-flat uses {skill, token}
  const normalised = manifest.map(e => ({
    skill: e.skill ?? e.id ?? '(unknown)',
    token: e.token,
  }));

  const outBase     = path.join(outDir, `${suite}-${mode}-${model}-${timestamp}`);
  const csvPath     = `${outBase}.csv`;
  const summaryPath = `${outBase}.summary.json`;
  let summary: Record<string, unknown> = { suite, mode, model, provider, timestamp, concurrency, delayMs, manifest: manifestSource };

  if (suite === 'routing-flat') {
    if (mode === 'seeded') {
      // Write a normalised temp file for seeded runner (it reads from disk)
      const tmp = path.join(outDir, `_manifest-tmp-${timestamp}.json`);
      fs.writeFileSync(tmp, JSON.stringify(normalised, null, 2));
      const sr = await runSeededSuite({ manifestFile: tmp, outputCSV: csvPath, router, delayMs, concurrency });
      const passed = sr.filter(r => r.pass).length;
      summary = { ...summary, total: sr.length, passed, accuracy: ((passed / sr.length) * 100).toFixed(1) + '%' };
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
      printSummary(summary, csvPath); return;
    }

    type FR = { skill: string; expected: string; actual: string; pass: boolean; hallucinated: boolean; latency_ms: number; mode: BenchMode; };
    const tasks = normalised.map(e => async (): Promise<FR> => {
      const prompt = mode === 'echo' ? buildEchoPrompt(e.skill, e.token) : buildRecallPrompt(e.skill);
      let actual = ''; let latency_ms = 0;
      try { const r = await router.invoke(prompt); actual = r.text; latency_ms = r.latency_ms; }
      catch (err) { actual = `ERROR: ${(err as Error).message}`; }
      const pass = actual.trim() === e.token;
      const hallucinated = !pass && isPlaceholder(actual.trim());
      if (!pass) console.log(`${hallucinated ? '[HALLUCINATED]' : '[FAIL]'} ${e.skill}  got=${actual.trim()}`);
      return { skill: e.skill, expected: e.token, actual: actual.trim(), pass, hallucinated, latency_ms, mode };
    });

    const settled = await runWithConcurrency(tasks, concurrency, delayMs);
    const results: FR[] = settled.map((r, i) => r.status === 'fulfilled' ? r.value : {
      skill: normalised[i].skill, expected: normalised[i].token,
      actual: `ERROR: ${(r as PromiseRejectedResult).reason}`,
      pass: false, hallucinated: false, latency_ms: 0, mode,
    });

    const passed      = results.filter(r => r.pass).length;
    const hallucinated = results.filter(r => r.hallucinated).length;
    const errors       = results.filter(r => r.actual.startsWith('ERROR:')).length;
    fs.writeFileSync(csvPath, ['skill,expected,actual,pass,hallucinated,latency_ms,mode',
      ...results.map(r => `${r.skill},${r.expected},${r.actual},${r.pass},${r.hallucinated},${r.latency_ms},${r.mode}`)].join('\n'));
    summary = { ...summary, total: results.length, passed, hallucinated, errors, accuracy: (passed / results.length * 100).toFixed(1) + '%' };

  } else if (suite === 'routing-seeded') {
    const tmp = path.join(outDir, `_manifest-tmp-${timestamp}.json`);
    fs.writeFileSync(tmp, JSON.stringify(normalised, null, 2));
    const sr = await runSeededSuite({ manifestFile: tmp, outputCSV: csvPath, router, delayMs, concurrency });
    const passed = sr.filter(r => r.pass).length;
    summary = { ...summary, total: sr.length, passed, accuracy: ((passed / sr.length) * 100).toFixed(1) + '%' };

  } else if (suite === 'loading-progressive' || suite === 'loading-mixed-depth') {
    const tmp = path.join(outDir, `_manifest-tmp-${timestamp}.json`);
    fs.writeFileSync(tmp, JSON.stringify(normalised, null, 2));
    const results = await runProgressiveSuite({ manifestFile: tmp, outputCSV: csvPath, router, delayMs, concurrency });
    const n = results.length;
    summary = { ...summary, total: n,
      routing_accuracy:     (results.filter(r => r.route_correct).length / n * 100).toFixed(1) + '%',
      depth_accuracy:       (results.filter(r => r.depth_correct).length / n * 100).toFixed(1) + '%',
      layer_chain_accuracy: (results.filter(r => r.layer_chain_correct).length / n * 100).toFixed(1) + '%',
      routing_efficiency:   (results.reduce((s, r) => s + r.efficiency, 0) / n).toFixed(3) };
  } else {
    console.error(`Unknown suite: ${suite}`); process.exit(1);
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
