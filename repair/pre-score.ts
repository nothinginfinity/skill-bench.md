/**
 * pre-score.ts — Zero-API-cost skill triage
 *
 * Reads an ingested manifest.json and scores every skill for routing
 * legibility BEFORE spending any LLM API calls.
 *
 * Signals scored per skill (all 0-100, higher = better):
 *
 *   token_entropy       Penalises rare/OOV tokens in the skill name+description.
 *                       Common English words score high. Unique jargon scores low.
 *                       Low entropy = model more likely to tokenise cleanly.
 *
 *   boundary_clarity    How distinct is this skill from its nearest neighbour?
 *                       Measured as 1 - max_cosine_similarity across all pairs.
 *                       High clarity = less routing confusion.
 *
 *   instruction_density How much actionable signal is in the description?
 *                       Ratio of instruction-bearing words to total words.
 *                       Low density = vague skills the model can't route.
 *
 *   ambiguity_score     Inverse of max cosine similarity to any other skill.
 *                       High = unique. Low = dangerously similar to another skill.
 *
 *   legibility_score    Weighted composite:
 *                         0.25 * token_entropy
 *                       + 0.30 * boundary_clarity
 *                       + 0.20 * instruction_density
 *                       + 0.25 * ambiguity_score
 *
 * Triage bands:
 *   🔴 RED    score < 50   — fix before benchmarking
 *   🟡 YELLOW score 50-74  — borderline, consider improving
 *   🟢 GREEN  score >= 75  — safe to skip in benchmark run
 *
 * Output: results/skill-triage-{timestamp}.md
 *
 * Usage:
 *   tsx repair/pre-score.ts --manifest ./suites/routing-format/format-manifest.json
 *   tsx repair/pre-score.ts --manifest ./path/to/manifest.json --out ./results --threshold 60
 */

import fs   from 'fs';
import path from 'path';
import type { ManifestEntry } from './ingest-skills.js';

// ---------------------------------------------------------------------------
// Tokeniser — character n-gram bag (no deps, approximates BPE behaviour)
// ---------------------------------------------------------------------------
const COMMON_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'to','of','in','for','on','with','as','by','from','at','into','through',
  'and','or','but','if','that','this','it','its','which','who','what','when',
  'skill','task','input','output','text','return','result','data','value','call',
  'execute','run','use','get','set','send','receive','process','generate','create',
  'read','write','list','find','search','match','check','validate','format',
  'agent','model','llm','tool','function','action','response','request','context',
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function tokenEntropy(entry: ManifestEntry): number {
  const tokens = tokenise(`${entry.id} ${entry.description}`);
  if (tokens.length === 0) return 0;
  const common = tokens.filter(t => COMMON_WORDS.has(t)).length;
  // More common tokens = easier for model = higher score
  // But we also want *some* unique signal — pure common-word descriptions score 50
  const commonRatio  = common / tokens.length;
  const uniqueTokens = new Set(tokens).size;
  const diversityScore = Math.min(uniqueTokens / 10, 1); // reward variety up to 10 unique tokens
  return Math.round((commonRatio * 60 + diversityScore * 40));
}

// ---------------------------------------------------------------------------
// TF-IDF-lite vector for cosine similarity
// ---------------------------------------------------------------------------
function buildVectors(entries: ManifestEntry[]): Map<string, number[]> {
  // Build vocabulary
  const allTokens = entries.flatMap(e => tokenise(`${e.id} ${e.description} ${e.category}`));
  const vocab     = Array.from(new Set(allTokens)).sort();
  const vocabIdx  = new Map(vocab.map((t, i) => [t, i]));

  // Document frequency
  const df = new Array(vocab.length).fill(0);
  for (const entry of entries) {
    const toks = new Set(tokenise(`${entry.id} ${entry.description}`));
    for (const t of toks) {
      const idx = vocabIdx.get(t);
      if (idx !== undefined) df[idx]++;
    }
  }

  const N = entries.length;
  const vectors = new Map<string, number[]>();

  for (const entry of entries) {
    const toks  = tokenise(`${entry.id} ${entry.description}`);
    const tf    = new Array(vocab.length).fill(0);
    for (const t of toks) {
      const idx = vocabIdx.get(t);
      if (idx !== undefined) tf[idx]++;
    }
    // TF-IDF
    const vec = tf.map((f, i) => f * Math.log((N + 1) / (df[i] + 1)));
    // L2 normalise
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    vectors.set(entry.id, vec.map(v => v / norm));
  }
  return vectors;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

// ---------------------------------------------------------------------------
// Instruction density
// ---------------------------------------------------------------------------
const INSTRUCTION_WORDS = new Set([
  'return','emit','output','produce','generate','extract','parse','format',
  'execute','run','call','invoke','send','route','dispatch','resolve',
  'compute','calculate','summarise','summarize','classify','detect','identify',
  'convert','transform','validate','check','verify','match','find','lookup',
  'exact','only','never','always','must','required','no','without',
]);

function instructionDensity(entry: ManifestEntry): number {
  const tokens = tokenise(entry.description);
  if (tokens.length === 0) return 0;
  const instructional = tokens.filter(t => INSTRUCTION_WORDS.has(t)).length;
  // Target: 2+ instruction words per 20 tokens = good density
  const raw = instructional / tokens.length;
  return Math.min(100, Math.round(raw * 600)); // scale so 1-in-6 = 100
}

// ---------------------------------------------------------------------------
// Per-skill scoring
// ---------------------------------------------------------------------------
export interface SkillScore {
  id:                  string;
  token_entropy:       number;
  boundary_clarity:    number;
  instruction_density: number;
  ambiguity_score:     number;
  legibility_score:    number;
  nearest_neighbor:    string;
  nearest_similarity:  number;
  band:                'red' | 'yellow' | 'green';
}

function scoreAll(entries: ManifestEntry[], threshold: number): SkillScore[] {
  const vectors = buildVectors(entries);

  return entries.map(entry => {
    const te = tokenEntropy(entry);
    const id = instructionDensity(entry);

    // Find nearest neighbour
    let maxSim = 0;
    let nearest = '';
    const myVec = vectors.get(entry.id)!;
    for (const other of entries) {
      if (other.id === entry.id) continue;
      const sim = cosine(myVec, vectors.get(other.id)!);
      if (sim > maxSim) { maxSim = sim; nearest = other.id; }
    }

    const bc = Math.round((1 - maxSim) * 100);
    const as_ = Math.round((1 - maxSim) * 100); // same signal, kept separate for clarity

    const legibility = Math.round(
      te  * 0.25 +
      bc  * 0.30 +
      id  * 0.20 +
      as_ * 0.25
    );

    const band: SkillScore['band'] =
      legibility >= 75              ? 'green'
      : legibility >= threshold     ? 'yellow'
      : 'red';

    return {
      id: entry.id,
      token_entropy:       te,
      boundary_clarity:    bc,
      instruction_density: id,
      ambiguity_score:     as_,
      legibility_score:    legibility,
      nearest_neighbor:    nearest,
      nearest_similarity:  parseFloat(maxSim.toFixed(3)),
      band,
    };
  }).sort((a, b) => a.legibility_score - b.legibility_score);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------
function buildReport(scores: SkillScore[], manifestPath: string, threshold: number): string {
  const red    = scores.filter(s => s.band === 'red');
  const yellow = scores.filter(s => s.band === 'yellow');
  const green  = scores.filter(s => s.band === 'green');
  const total  = scores.length;

  const pct = (n: number) => `${Math.round(n / total * 100)}%`;

  const avg = (arr: SkillScore[], field: keyof SkillScore) =>
    arr.length === 0 ? 'n/a' :
    (arr.reduce((s, x) => s + (x[field] as number), 0) / arr.length).toFixed(1);

  const tableRows = (arr: SkillScore[]) =>
    arr.map(s =>
      `| \`${s.id}\` | ${s.legibility_score} | ${s.token_entropy} | ${s.boundary_clarity} | ${s.instruction_density} | ${s.ambiguity_score} | \`${s.nearest_neighbor}\` (${s.nearest_similarity}) |`
    ).join('\n');

  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');

  return [
    `# Skill Triage Report`,
    ``,
    `**Manifest:** \`${manifestPath}\`  `,
    `**Generated:** ${ts}  `,
    `**Threshold:** RED < ${threshold} | YELLOW ${threshold}–74 | GREEN ≥ 75  `,
    ``,
    `---`,
    ``,
    `## Summary`,
    ``,
    `| Band | Count | % of Stack | Avg Legibility |`,
    `|---|---|---|---|`,
    `| 🔴 RED    | ${red.length}    | ${pct(red.length)}    | ${avg(red,    'legibility_score')} |`,
    `| 🟡 YELLOW | ${yellow.length} | ${pct(yellow.length)} | ${avg(yellow, 'legibility_score')} |`,
    `| 🟢 GREEN  | ${green.length}  | ${pct(green.length)}  | ${avg(green,  'legibility_score')} |`,
    `| **Total** | **${total}** | 100% | ${avg(scores, 'legibility_score')} |`,
    ``,
    `**Recommendation:**`,
    red.length === 0
      ? `> ✅ No red skills. Stack is ready for benchmarking. Run \`npm run fix:generate\` after your first format run to verify.`
      : `> ⚠️ ${red.length} skill${red.length > 1 ? 's' : ''} (${pct(red.length)}) are below threshold and should be fixed before benchmarking. Start with the lowest scores — they are most likely to fail routing in all 3 formats.`,
    ``,
    `---`,
    ``,
    ...(red.length > 0 ? [
      `## 🔴 Fix First (score < ${threshold})`,
      ``,
      `These skills have low legibility and are most likely to fail routing.`,
      `Fix description clarity, add constraints, or increase boundary from nearest neighbor.`,
      ``,
      `| Skill | Score | Entropy | Boundary | Density | Ambiguity | Nearest Neighbor |`,
      `|---|---|---|---|---|---|---|`,
      tableRows(red),
      ``,
    ] : []),
    ...(yellow.length > 0 ? [
      `## 🟡 Borderline (score ${threshold}–74)`,
      ``,
      `These skills may pass routing but are worth improving if you have time.`,
      ``,
      `| Skill | Score | Entropy | Boundary | Density | Ambiguity | Nearest Neighbor |`,
      `|---|---|---|---|---|---|---|`,
      tableRows(yellow),
      ``,
    ] : []),
    ...(green.length > 0 ? [
      `## 🟢 Safe to Skip (score ≥ 75)`,
      ``,
      `These skills have high legibility. You can exclude them from your initial benchmark run`,
      `and focus API budget on red and yellow skills.`,
      ``,
      `| Skill | Score | Entropy | Boundary | Density | Ambiguity | Nearest Neighbor |`,
      `|---|---|---|---|---|---|---|`,
      tableRows(green),
      ``,
    ] : []),
    `---`,
    ``,
    `## Signal Definitions`,
    ``,
    `| Signal | What it measures | Fix if low |`,
    `|---|---|---|`,
    `| **token_entropy** | How common/standard the tokens in id+description are | Use plain English; avoid unique jargon |`,
    `| **boundary_clarity** | How distinct this skill is from its nearest neighbor | Make descriptions more specific |`,
    `| **instruction_density** | How many actionable instruction words are in the description | Add: return, emit, exact, only, never, must |`,
    `| **ambiguity_score** | Inverse of max similarity to any other skill | Rename or rewrite overlapping skills |`,
    `| **legibility_score** | Weighted composite (see weights in pre-score.ts) | Fix whichever signal is lowest |`,
    ``,
    `---`,
    ``,
    `## Next Steps`,
    ``,
    `\`\`\`bash`,
    `# 1. Fix red skills based on signal breakdown above`,
    `# 2. Re-ingest after edits:`,
    `tsx repair/ingest-skills.ts --skills ./my-skills`,
    `# 3. Re-score to verify improvement:`,
    `tsx repair/pre-score.ts --manifest ./suites/routing-format/format-manifest.json`,
    `# 4. When no red skills remain, run the benchmark:`,
    `npm run fix:groq   # or fix:openai, fix:deepseek, etc.`,
    `\`\`\``,
    ``,
    `_Generated by skill-bench.md · repair/pre-score.ts_`,
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
  const args         = parseArgs(process.argv);
  const manifestPath = path.resolve(args['manifest'] ?? './suites/routing-format/format-manifest.json');
  const outDir       = path.resolve(args['out'] ?? './results');
  const threshold    = parseInt(args['threshold'] ?? '50', 10);

  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: manifest not found: ${manifestPath}`);
    console.error('Run ingest-skills.ts first to generate a manifest.');
    process.exit(1);
  }

  const entries: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error('Error: manifest is empty or not a JSON array.');
    process.exit(1);
  }

  console.log(`\n═══ pre-score ═══`);
  console.log(`Manifest: ${manifestPath} (${entries.length} skills)`);
  console.log(`Threshold: RED < ${threshold}`);

  const scores = scoreAll(entries, threshold);

  const red    = scores.filter(s => s.band === 'red').length;
  const yellow = scores.filter(s => s.band === 'yellow').length;
  const green  = scores.filter(s => s.band === 'green').length;

  console.log(`\nResults:`);
  console.log(`  🔴 RED:    ${red}`);
  console.log(`  🟡 YELLOW: ${yellow}`);
  console.log(`  🟢 GREEN:  ${green}`);

  const ts      = new Date().toISOString().slice(0, 19).replace(/:/g, '-').replace('T', 'T');
  const outName = `skill-triage-${ts}.md`;
  const outPath = path.join(outDir, outName);

  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport(scores, manifestPath, threshold);
  fs.writeFileSync(outPath, report);

  console.log(`\nReport: ${outPath}`);
  console.log(`\nDone. Fix red skills first, then run: npm run fix:groq`);
}

main().catch(err => { console.error(err); process.exit(1); });
