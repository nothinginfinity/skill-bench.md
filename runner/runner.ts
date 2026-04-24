import { readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "..");
const MANIFEST_PATH = join(ROOT, "manifest.json");
const SKILLS_DIR = join(ROOT, "skills");

interface ManifestEntry {
  id: number;
  skill: string;
  token: string;
}

interface SkillResult {
  skill: string;
  expected: string;
  actual: string;
  pass: boolean;
}

function parseSkillToken(skillPath: string): string {
  const content = readFileSync(skillPath, "utf-8");
  const match = content.match(/`(BENCH-\d{3}::[\d,]+\.\d+)`/);
  return match ? match[1] : "";
}

// v1: reads skill file directly to validate manifest consistency.
// Replace this function body with your live router call to test real routing fidelity.
function simulateInvoke(entry: ManifestEntry): string {
  const skillPath = join(SKILLS_DIR, `${entry.skill}.md`);
  try {
    return parseSkillToken(skillPath);
  } catch {
    return "FILE_NOT_FOUND";
  }
}

async function main() {
  const manifest: ManifestEntry[] = JSON.parse(
    readFileSync(MANIFEST_PATH, "utf-8")
  );

  const results: SkillResult[] = [];
  let passed = 0;
  let failed = 0;

  console.log(`\nskill-bench.md v1 — Routing Fidelity Benchmark`);
  console.log(`Running ${manifest.length} skills...\n`);

  for (const entry of manifest) {
    const actual = simulateInvoke(entry);
    const pass = actual === entry.token;
    if (pass) passed++; else failed++;

    results.push({ skill: entry.skill, expected: entry.token, actual, pass });

    if (!pass) {
      console.log(`FAIL  ${entry.skill}`);
      console.log(`      expected: ${entry.token}`);
      console.log(`      actual:   ${actual}`);
    }
  }

  console.log(`\n${"-".repeat(52)}`);
  console.log(`Results: ${passed}/${manifest.length} passed (${((passed / manifest.length) * 100).toFixed(1)}%)`);

  if (failed === 0) {
    console.log(`\n✓ All ${passed} skills structurally valid and manifest-consistent.`);
    console.log(`  Plug your router into simulateInvoke() to test live routing fidelity.`);
  } else {
    console.log(`\n✗ ${failed} skill(s) failed. Fix mismatches before running against a live router.`);
    process.exit(1);
  }
}

main();
