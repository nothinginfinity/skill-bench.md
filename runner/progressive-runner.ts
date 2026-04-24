import fs from "fs";

// Progressive depth runner
// Loads progressive-manifest.json, tests depth routing

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
}

export function parseProgressiveToken(token: string) {
  // Format: BENCH-{id}::DEPTH={n}::{l1}.{l2}...{ln}
  const match = token.match(/^BENCH-(\d+)::DEPTH=(\d+)::(.+)$/);
  if (!match) return null;
  return {
    id: parseInt(match[1]),
    depth: parseInt(match[2]),
    layers: match[3].split(".")
  };
}

export function scoreProgressiveResult(
  expected: ReturnType<typeof parseProgressiveToken>,
  actual: ReturnType<typeof parseProgressiveToken>
) {
  if (!expected || !actual) throw new Error("Invalid token format");
  return {
    expected_depth: expected.depth,
    loaded_depth: actual.depth,
    route_correct: actual.id === expected.id,
    depth_correct: actual.depth === expected.depth,
    layer_chain_correct: JSON.stringify(actual.layers) === JSON.stringify(expected.layers),
    overload_error: actual.depth > expected.depth,
    underload_error: actual.depth < expected.depth,
    efficiency: expected.depth / actual.depth,
    layer_tokens_expected: expected.layers,
    layer_tokens_actual: actual.layers
  };
}

function buildProgressivePrompt(skill: Record<string, unknown>): string {
  const layers = (skill.layers as { layer: number; description: string }[]);
  const depthHint = layers.length === 1 ? "This is a shallow task." :
    layers.length <= 3 ? "This requires intermediate depth." :
    "This is a deep, multi-constraint task requiring full skill activation.";
  return `Execute skill ${skill.skill}. ${depthHint} Return token: BENCH-{id}::DEPTH={n}::{layer_tokens_joined_by_dots}`;
}

export async function runProgressiveSuite(manifestPath: string, outputCSV: string) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const results: ProgressiveResult[] = [];

  for (const skill of manifest) {
    const prompt = buildProgressivePrompt(skill);
    // TODO: call router here
    const actual_token = ""; // placeholder
    const parsed = parseProgressiveToken(actual_token);
    const expected = parseProgressiveToken(skill.expected_token);
    const scored = scoreProgressiveResult(expected, parsed);
    results.push({ skill: skill.skill, ...scored } as ProgressiveResult);
  }

  const headers = Object.keys(results[0] || {});
  const csv = [headers.join(","),
    ...results.map(r => headers.map(h => JSON.stringify((r as Record<string, unknown>)[h])).join(","))
  ].join("\n");
  fs.writeFileSync(outputCSV, csv);
  console.log(`Progressive run complete. Results: ${outputCSV}`);
  return results;
}
