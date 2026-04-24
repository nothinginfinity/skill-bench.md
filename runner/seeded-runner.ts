import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createRouter, Router, RouterConfig } from "./router.js";

export interface SeededRunConfig {
  manifestFile: string;
  outputCSV: string;
  router: Router;
}

export interface SeededResult {
  skill: string;
  expected: string;
  actual: string;
  pass: boolean;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export function generateRunSeed(): string {
  return crypto.randomUUID();
}

export function computeSeededToken(seed: string, skillId: string): string {
  return (
    "BENCH-" +
    skillId +
    "::" +
    crypto.createHmac("sha256", seed).update(skillId).digest("hex").slice(0, 8)
  );
}

function buildSeededPrompt(skillId: string, seed: string): string {
  return (
    `You are running skill-bench suite: routing-seeded.\n` +
    `Skill ID: ${skillId}\n` +
    `Run seed: ${seed}\n` +
    `Compute: HMAC-SHA256(seed + ":" + skillId), take first 8 hex chars.\n` +
    `Return ONLY the token in format: BENCH-${skillId}::{8-char-hmac}\n` +
    `No explanation. No punctuation. Token only.`
  );
}

export async function runSeededSuite(config: SeededRunConfig): Promise<SeededResult[]> {
  const seed = generateRunSeed();
  const manifest = JSON.parse(fs.readFileSync(config.manifestFile, "utf-8"));
  const results: SeededResult[] = [];

  console.log(`\n[seeded-runner] seed=${seed}`);
  console.log(`[seeded-runner] model=${config.router.config.model} provider=${config.router.config.provider}`);
  console.log(`[seeded-runner] running ${manifest.length} skills...\n`);

  for (const skill of manifest) {
    const expected = computeSeededToken(seed, skill.skill);
    const prompt = buildSeededPrompt(skill.skill, seed);
    let actual = "";
    let latency_ms = 0;
    let prompt_tokens: number | undefined;
    let completion_tokens: number | undefined;

    try {
      const resp = await config.router.invoke(prompt);
      actual = resp.text;
      latency_ms = resp.latency_ms;
      prompt_tokens = resp.prompt_tokens;
      completion_tokens = resp.completion_tokens;
    } catch (err) {
      actual = `ERROR: ${(err as Error).message}`;
    }

    const pass = actual.trim() === expected;
    if (!pass) console.log(`FAIL ${skill.skill}  expected=${expected}  actual=${actual}`);

    results.push({ skill: skill.skill, expected, actual, pass, latency_ms, prompt_tokens, completion_tokens });
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[seeded-runner] ${passed}/${results.length} passed (${((passed / results.length) * 100).toFixed(1)}%)`);

  const csv = [
    "skill,expected,actual,pass,latency_ms,prompt_tokens,completion_tokens",
    ...results.map(
      (r) =>
        `${r.skill},${r.expected},${r.actual},${r.pass},${r.latency_ms},${r.prompt_tokens ?? ""},${r.completion_tokens ?? ""}`
    ),
  ].join("\n");
  fs.writeFileSync(config.outputCSV, csv);
  console.log(`[seeded-runner] results written to ${config.outputCSV}`);

  return results;
}
