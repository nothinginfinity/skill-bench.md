#!/usr/bin/env node
/**
 * run.ts — CLI entrypoint for skill-bench.md
 *
 * Usage:
 *   npx tsx runner/run.ts --suite routing-flat --provider openai --model gpt-4o --key $OPENAI_API_KEY
 *   npx tsx runner/run.ts --suite loading-progressive --provider anthropic --model claude-3-7-sonnet-20250219 --key $ANTHROPIC_API_KEY
 *   npx tsx runner/run.ts --suite routing-seeded --provider gemini --model gemini-2.0-flash --key $GEMINI_API_KEY
 *   npx tsx runner/run.ts --suite routing-flat --provider mock
 *
 * Outputs:
 *   results/{suite}-{model}-{timestamp}.csv
 *   results/{suite}-{model}-{timestamp}.summary.json
 */

import fs from "fs";
import path from "path";
import { createRouter, Provider, RouterConfig } from "./router.js";
import { runSeededSuite } from "./seeded-runner.js";
import { runProgressiveSuite } from "./progressive-runner.js";

const ROOT = path.resolve(import.meta.dirname ?? __dirname, "..");

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1] ?? "true";
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const suite = args["suite"] ?? "routing-flat";
  const provider = (args["provider"] ?? "mock") as Provider;
  const model = args["model"] ?? "mock";
  const apiKey = args["key"] ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.GEMINI_API_KEY;

  const routerConfig: RouterConfig = { provider, model, apiKey };
  const router = createRouter(routerConfig);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(ROOT, "results");
  fs.mkdirSync(outDir, { recursive: true });

  const outBase = path.join(outDir, `${suite}-${model}-${timestamp}`);
  const csvPath = `${outBase}.csv`;
  const summaryPath = `${outBase}.summary.json`;

  console.log(`\n═══ skill-bench.md runner ═══`);
  console.log(`Suite:    ${suite}`);
  console.log(`Provider: ${provider}`);
  console.log(`Model:    ${model}`);
  console.log(`Output:   ${csvPath}\n`);

  let summary: Record<string, unknown> = { suite, model, provider, timestamp };

  if (suite === "routing-flat") {
    // v1 flat runner — reads skills from /skills/*.md via existing runner.ts
    // For live API use, prompts are constructed per skill in seeded-runner style
    const manifestPath = path.join(ROOT, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const results: { skill: string; expected: string; actual: string; pass: boolean; latency_ms: number }[] = [];

    for (const entry of manifest) {
      const prompt =
        `You are running skill-bench suite: routing-flat.\n` +
        `Execute skill: ${entry.skill}\n` +
        `Return ONLY the token: ${entry.token.split("::")[0]}::{token}\n` +
        `The token is stored in the skill file. Return it exactly.`;

      let actual = "";
      let latency_ms = 0;
      try {
        const resp = await router.invoke(prompt);
        actual = resp.text;
        latency_ms = resp.latency_ms;
      } catch (err) {
        actual = `ERROR: ${(err as Error).message}`;
      }

      const pass = actual.trim() === entry.token;
      results.push({ skill: entry.skill, expected: entry.token, actual, pass, latency_ms });
    }

    const passed = results.filter((r) => r.pass).length;
    const accuracy = passed / results.length;
    const csv = ["skill,expected,actual,pass,latency_ms", ...results.map((r) =>
      `${r.skill},${r.expected},${r.actual},${r.pass},${r.latency_ms}`
    )].join("\n");
    fs.writeFileSync(csvPath, csv);
    summary = { ...summary, total: results.length, passed, accuracy: (accuracy * 100).toFixed(1) + "%" };

  } else if (suite === "routing-seeded") {
    const manifestPath = path.join(ROOT, "manifest.json");
    const results = await runSeededSuite({ manifestFile: manifestPath, outputCSV: csvPath, router });
    const passed = results.filter((r) => r.pass).length;
    summary = { ...summary, total: results.length, passed, accuracy: ((passed / results.length) * 100).toFixed(1) + "%" };

  } else if (suite === "loading-progressive" || suite === "loading-mixed-depth") {
    const manifestPath = path.join(ROOT, "suites/loading-progressive/progressive-manifest.json");
    const results = await runProgressiveSuite({ manifestFile: manifestPath, outputCSV: csvPath, router });
    const n = results.length;
    const routeAcc = results.filter((r) => r.route_correct).length / n;
    const depthAcc = results.filter((r) => r.depth_correct).length / n;
    const chainAcc = results.filter((r) => r.layer_chain_correct).length / n;
    const avgEff = results.reduce((s, r) => s + r.efficiency, 0) / n;
    summary = {
      ...summary,
      total: n,
      routing_accuracy: (routeAcc * 100).toFixed(1) + "%",
      depth_accuracy: (depthAcc * 100).toFixed(1) + "%",
      layer_chain_accuracy: (chainAcc * 100).toFixed(1) + "%",
      routing_efficiency: avgEff.toFixed(3),
    };

  } else {
    console.error(`Unknown suite: ${suite}. Options: routing-flat, routing-seeded, loading-progressive, loading-mixed-depth`);
    process.exit(1);
  }

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n═══ Summary ═══`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nDone. CSV: ${csvPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
