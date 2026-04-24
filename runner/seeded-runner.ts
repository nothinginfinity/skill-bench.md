import crypto from "crypto";
import fs from "fs";

// Seeded runner for routing-seeded suite
// Generates a per-run seed, injects into prompts, computes expected HMAC tokens

export interface RunConfig {
  suiteFile: string;
  manifestFile: string;
  outputCSV: string;
}

export function generateRunSeed(): string {
  return crypto.randomUUID();
}

export function computeSeededToken(seed: string, skillId: string): string {
  return "BENCH-" + skillId + "::" +
    crypto.createHmac("sha256", seed).update(skillId).digest("hex").slice(0, 8);
}

export function buildSeededPrompt(skillId: string, seed: string): string {
  return `Execute skill ${skillId}. Your run seed is: ${seed}. Return token: BENCH-${skillId}::HMAC-SHA256(seed+":"+skillId)[0:8]`;
}

export async function runSeededSuite(config: RunConfig) {
  const seed = generateRunSeed();
  const manifest = JSON.parse(fs.readFileSync(config.manifestFile, "utf-8"));
  const results: Record<string, unknown>[] = [];

  for (const skill of manifest) {
    const expected = computeSeededToken(seed, skill.skill);
    const prompt = buildSeededPrompt(skill.skill, seed);
    // TODO: call LLM router here with prompt
    // const actual = await router.invoke(prompt);
    const actual = ""; // placeholder
    const pass = actual.trim() === expected;
    results.push({ skill: skill.skill, expected, actual, pass, latency_ms: 0 });
  }

  const csv = ["skill,expected,actual,pass,latency_ms",
    ...results.map(r => `${r.skill},${r.expected},${r.actual},${r.pass},${r.latency_ms}`)
  ].join("\n");
  fs.writeFileSync(config.outputCSV, csv);
  console.log(`Run complete. Seed: ${seed}. Results: ${config.outputCSV}`);
  return results;
}
