#!/usr/bin/env node
/**
 * run.ts — CLI entrypoint for skill-bench.md
 *
 * Usage:
 *   npx tsx runner/run.ts --suite routing-flat     --provider openai    --model gpt-4o              --key $OPENAI_API_KEY
 *   npx tsx runner/run.ts --suite loading-progressive --provider anthropic --model claude-3-7-sonnet-20250219 --key $ANTHROPIC_API_KEY
 *   npx tsx runner/run.ts --suite routing-seeded   --provider gemini    --model gemini-2.0-flash    --key $GEMINI_API_KEY
 *   npx tsx runner/run.ts --suite routing-flat     --provider deepseek  --model deepseek-reasoner   --key $DEEPSEEK_API_KEY
 *   npx tsx runner/run.ts --suite routing-flat     --provider groq      --model llama-3.1-8b-instant --key $GROQ_API_KEY --delay 2000
 *   npx tsx runner/run.ts --suite routing-flat     --provider mock
 *
 * Flags:
 *   --suite     routing-flat | routing-seeded | loading-progressive | loading-mixed-depth
 *   --provider  openai | anthropic | gemini | deepseek | groq | mock
 *   --model     model name for the chosen provider
 *   --key       API key (or set via env: OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY / GROQ_API_KEY)
 *   --delay     ms to wait between requests (default: 0). Use 2000 for Groq free tier to avoid HTTP 429.
 *
 * Outputs:
 *   results/{suite}-{model}-{timestamp}.csv
 *   results/{suite}-{model}-{timestamp}.summary.json
 *
 * Fix log:
 *   2026-04-24  Fix 2 — Add --delay flag with per-request sleep to avoid HTTP 429
 *               on free-tier providers like Groq (~30 RPM limit).
 *               Groq recommended: --delay 2000  (2 s between requests = ~30 RPM)
 */

import fs from 'fs';
import path from 'path';
import { createRouter, Provider, RouterConfig, sleep } from './router.js';
import { runSeededSuite } from './seeded-runner.js';
import { runProgressiveSuite } from './progressive-runner.js';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..');

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

async function main() {
  const args  = parseArgs(process.argv);
  const suite    = args['suite']    ?? 'routing-flat';
  const provider = (args['provider'] ?? 'mock') as Provider;
  const model    = args['model']    ?? 'mock';
  const delayMs  = parseInt(args['delay'] ?? '0', 10);   // FIX 2: rate-limit delay
  const apiKey   =
    args['key'] ??
    process.env.OPENAI_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.GROQ_API_KEY;

  const routerConfig: RouterConfig = { provider, model, apiKey };
  const router = createRouter(routerConfig);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir    = path.join(ROOT, 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const outBase     = path.join(outDir, `${suite}-${model}-${timestamp}`);
  const csvPath     = `${outBase}.csv`;
  const summaryPath = `${outBase}.summary.json`;

  console.log(`\n═══ skill-bench.md runner ═══`);
  console.log(`Suite:    ${suite}`);
  console.log(`Provider: ${provider}`);
  console.log(`Model:    ${model}`);
  if (delayMs > 0) console.log(`Delay:    ${delayMs}ms between requests (rate-limit mode)`);
  console.log(`Output:   ${csvPath}\n`);

  let summary: Record<string, unknown> = { suite, model, provider, timestamp, delayMs };

  // ---------------------------------------------------------------------------
  // routing-flat
  // ---------------------------------------------------------------------------
  if (suite === 'routing-flat') {
    const manifestPath = path.join(ROOT, 'manifest.json');
    const manifest     = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const results: { skill: string; expected: string; actual: string; pass: boolean; latency_ms: number }[] = [];

    for (const entry of manifest) {
      // FIX 2: sleep before each request (skip first)
      if (delayMs > 0 && results.length > 0) await sleep(delayMs);

      const prompt =
        `You are running skill-bench suite: routing-flat.\n` +
        `Execute skill: ${entry.skill}\n` +
        `Return ONLY this exact token string — no explanation, no punctuation:\n` +
        `${entry.token}`;

      let actual = '';
      let latency_ms = 0;
      try {
        const resp  = await router.invoke(prompt);
        actual      = resp.text;
        latency_ms  = resp.latency_ms;
      } catch (err) {
        actual = `ERROR: ${(err as Error).message}`;
      }

      const pass = actual.trim() === entry.token;
      if (!pass) console.log(`FAIL  ${entry.skill}  expected=${entry.token}  got=${actual}`);
      results.push({ skill: entry.skill, expected: entry.token, actual, pass, latency_ms });
    }

    const passed   = results.filter(r => r.pass).length;
    const accuracy = passed / results.length;
    const csv      = [
      'skill,expected,actual,pass,latency_ms',
      ...results.map(r => `${r.skill},${r.expected},${r.actual},${r.pass},${r.latency_ms}`),
    ].join('\n');
    fs.writeFileSync(csvPath, csv);
    summary = { ...summary, total: results.length, passed, accuracy: (accuracy * 100).toFixed(1) + '%' };

  // ---------------------------------------------------------------------------
  // routing-seeded
  // ---------------------------------------------------------------------------
  } else if (suite === 'routing-seeded') {
    const manifestPath = path.join(ROOT, 'manifest.json');
    const results      = await runSeededSuite({ manifestFile: manifestPath, outputCSV: csvPath, router, delayMs });
    const passed       = results.filter(r => r.pass).length;
    summary = { ...summary, total: results.length, passed, accuracy: ((passed / results.length) * 100).toFixed(1) + '%' };

  // ---------------------------------------------------------------------------
  // loading-progressive | loading-mixed-depth
  // ---------------------------------------------------------------------------
  } else if (suite === 'loading-progressive' || suite === 'loading-mixed-depth') {
    const manifestPath = path.join(ROOT, 'suites/loading-progressive/progressive-manifest.json');
    const results      = await runProgressiveSuite({ manifestFile: manifestPath, outputCSV: csvPath, router, delayMs });
    const n            = results.length;
    const routeAcc  = results.filter(r => r.route_correct).length / n;
    const depthAcc  = results.filter(r => r.depth_correct).length / n;
    const chainAcc  = results.filter(r => r.layer_chain_correct).length / n;
    const avgEff    = results.reduce((s, r) => s + r.efficiency, 0) / n;
    summary = {
      ...summary,
      total: n,
      routing_accuracy:      (routeAcc * 100).toFixed(1) + '%',
      depth_accuracy:        (depthAcc * 100).toFixed(1) + '%',
      layer_chain_accuracy:  (chainAcc * 100).toFixed(1) + '%',
      routing_efficiency:    avgEff.toFixed(3),
    };

  } else {
    console.error(`Unknown suite: ${suite}. Options: routing-flat, routing-seeded, loading-progressive, loading-mixed-depth`);
    process.exit(1);
  }

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n═══ Summary ═══`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nDone. Results: ${csvPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
