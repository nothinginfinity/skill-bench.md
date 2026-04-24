import fs from "fs";
import { createRouter, Router } from "./router.js";

export interface ProgressiveRunConfig {
  manifestFile: string;
  outputCSV: string;
  router: Router;
}

export interface ProgressiveResult {
  skill: string;
  expected_depth: number;
  loaded_depth: number;
  route_correct: boolean;
  depth_correct: boolean;
  layer_chain_correct: boolean;
  overload_error: boolean;
  underload_error: boolean;
  efficiency: number;
  layer_tokens_expected: string[];
  layer_tokens_actual: string[];
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export function parseProgressiveToken(token: string) {
  const match = token.match(/^BENCH-(\d+)::DEPTH=(\d+)::(.+)$/);
  if (!match) return null;
  return {
    id: parseInt(match[1]),
    depth: parseInt(match[2]),
    layers: match[3].split("."),
  };
}

export function scoreProgressiveResult(
  expected: ReturnType<typeof parseProgressiveToken>,
  actual: ReturnType<typeof parseProgressiveToken>,
  expectedRaw: string
) {
  if (!expected)
    throw new Error(`Cannot parse expected token: ${expectedRaw}`);
  if (!actual)
    return {
      expected_depth: expected.depth,
      loaded_depth: 0,
      route_correct: false,
      depth_correct: false,
      layer_chain_correct: false,
      overload_error: false,
      underload_error: true,
      efficiency: 0,
      layer_tokens_expected: expected.layers,
      layer_tokens_actual: [],
    };

  return {
    expected_depth: expected.depth,
    loaded_depth: actual.depth,
    route_correct: actual.id === expected.id,
    depth_correct: actual.depth === expected.depth,
    layer_chain_correct:
      JSON.stringify(actual.layers) === JSON.stringify(expected.layers),
    overload_error: actual.depth > expected.depth,
    underload_error: actual.depth < expected.depth,
    efficiency:
      actual.depth > 0 ? parseFloat((expected.depth / actual.depth).toFixed(3)) : 0,
    layer_tokens_expected: expected.layers,
    layer_tokens_actual: actual.layers,
  };
}

function buildProgressivePrompt(skill: {
  skill: string;
  max_depth: number;
  layers: { layer: number; description: string; token: string }[];
  expected_token: string;
}): string {
  const hint =
    skill.max_depth === 1
      ? "This is a simple, shallow task. Load only the base identity layer."
      : skill.max_depth <= 3
      ? "This task requires intermediate depth. Load layers through the constraint level."
      : "This is a complex, multi-constraint task. Load all layers including reasoning and adversarial edge cases.";

  return (
    `You are running skill-bench suite: loading-progressive.\n` +
    `Skill: ${skill.skill}\n` +
    `Task complexity: ${hint}\n` +
    `Available layers: ${skill.layers.map((l) => `L${l.layer}=${l.description}`).join(", ")}\n` +
    `Return ONLY the progressive token in this exact format:\n` +
    `BENCH-{id}::DEPTH={n}::{layer_token_1}.{layer_token_2}...{layer_token_n}\n` +
    `No explanation. Token only.`
  );
}

export async function runProgressiveSuite(
  config: ProgressiveRunConfig
): Promise<ProgressiveResult[]> {
  const manifest = JSON.parse(fs.readFileSync(config.manifestFile, "utf-8"));
  const results: ProgressiveResult[] = [];

  console.log(`\n[progressive-runner] model=${config.router.config.model} provider=${config.router.config.provider}`);
  console.log(`[progressive-runner] running ${manifest.length} skills...\n`);

  for (const skill of manifest) {
    const prompt = buildProgressivePrompt(skill);
    let rawOutput = "";
    let latency_ms = 0;
    let prompt_tokens: number | undefined;
    let completion_tokens: number | undefined;

    try {
      const resp = await config.router.invoke(prompt);
      rawOutput = resp.text;
      latency_ms = resp.latency_ms;
      prompt_tokens = resp.prompt_tokens;
      completion_tokens = resp.completion_tokens;
    } catch (err) {
      rawOutput = `ERROR: ${(err as Error).message}`;
    }

    const expected = parseProgressiveToken(skill.expected_token);
    const actual = parseProgressiveToken(rawOutput.trim());
    const scored = scoreProgressiveResult(expected, actual, skill.expected_token);

    const result: ProgressiveResult = {
      skill: skill.skill,
      ...scored,
      latency_ms,
      prompt_tokens,
      completion_tokens,
    };

    if (!result.layer_chain_correct) {
      console.log(`FAIL ${skill.skill}  depth=${result.loaded_depth}/${result.expected_depth}  chain=${result.layer_chain_correct}`);
    }

    results.push(result);
  }

  const routePassed = results.filter((r) => r.route_correct).length;
  const depthPassed = results.filter((r) => r.depth_correct).length;
  const chainPassed = results.filter((r) => r.layer_chain_correct).length;
  const avgEff =
    results.reduce((s, r) => s + r.efficiency, 0) / results.length;

  console.log(`\n[progressive-runner] Results:`);
  console.log(`  Route correct:       ${routePassed}/${results.length} (${((routePassed/results.length)*100).toFixed(1)}%)`);
  console.log(`  Depth correct:       ${depthPassed}/${results.length} (${((depthPassed/results.length)*100).toFixed(1)}%)`);
  console.log(`  Layer chain correct: ${chainPassed}/${results.length} (${((chainPassed/results.length)*100).toFixed(1)}%)`);
  console.log(`  Avg efficiency:      ${avgEff.toFixed(3)}`);

  const headers: (keyof ProgressiveResult)[] = [
    "skill", "expected_depth", "loaded_depth", "route_correct",
    "depth_correct", "layer_chain_correct", "overload_error",
    "underload_error", "efficiency", "latency_ms",
  ];
  const csv = [
    headers.join(","),
    ...results.map((r) => headers.map((h) => JSON.stringify(r[h])).join(",")),
  ].join("\n");
  fs.writeFileSync(config.outputCSV, csv);
  console.log(`[progressive-runner] results written to ${config.outputCSV}`);

  return results;
}
