/**
 * ingest-skills.ts — Phase 6 real-skill ingestion
 *
 * Reads a folder of real skill files (.md, .yaml, .json, .txt) and emits
 * a manifest.json that is drop-in compatible with format-runner.ts.
 *
 * Supported input formats:
 *   .md / .txt  — frontmatter (--- key: value ---) + body text
 *   .yaml/.yml  — flat key/value skill definition
 *   .json       — object with any subset of the manifest fields
 *
 * Field extraction (best-effort, graceful fallback):
 *   id           → filename stem, slugified
 *   description  → 'description' field, or first non-empty paragraph of body
 *   input_type   → 'input_type' / 'input' field, or "text" fallback
 *   output_type  → 'output_type' / 'output' field, or "text" fallback
 *   constraints  → 'constraints' array field, or []
 *   category     → 'category' / 'tags[0]' field, or "custom"
 *
 * Token generation:
 *   Deterministic: BENCH-{index}::{djb2(id)}::{djb2(description)[0:8]}
 *   Stable across runs as long as skill id + description don't change.
 *
 * Usage:
 *   tsx repair/ingest-skills.ts --skills ./my-skills
 *   tsx repair/ingest-skills.ts --skills ./my-skills --out ./suites/routing-format/format-manifest.json
 *   tsx repair/ingest-skills.ts --skills ./my-skills --out ./results/my-manifest.json --prefix SK
 */

import fs   from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ManifestEntry {
  id:           string;
  token:        string;
  category:     string;
  description:  string;
  input_type:   string;
  output_type:  string;
  constraints:  string[];
  source_file?: string;
}

// ---------------------------------------------------------------------------
// Token generation — deterministic, no deps
// ---------------------------------------------------------------------------
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash;
}

function makeToken(prefix: string, index: number, id: string, description: string): string {
  const idHash   = djb2(id).toString(16).padStart(8, '0');
  const descHash = djb2(description).toString(16).padStart(8, '0').slice(0, 8);
  const idx      = String(index + 1).padStart(3, '0');
  return `${prefix}-${idx}::${idHash}.${descHash}`;
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// Frontmatter parser (--- key: value ---)
// ---------------------------------------------------------------------------
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const meta: Record<string, unknown> = {};
  let body = content;

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    body = fmMatch[2];
    const lines = fmMatch[1].split('\n');
    for (const line of lines) {
      const kv = line.match(/^([\w_-]+):\s*(.*)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      // Handle inline arrays: "constraints: [a, b, c]"
      if (val.startsWith('[') && val.endsWith(']')) {
        meta[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      } else {
        meta[key] = val.trim();
      }
    }
  }
  return { meta, body };
}

// ---------------------------------------------------------------------------
// YAML parser — minimal flat key/value only (no deps)
// ---------------------------------------------------------------------------
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey = '';
  let listMode   = false;
  const listBuf: string[] = [];

  const flushList = () => {
    if (currentKey && listMode) { result[currentKey] = [...listBuf]; listBuf.length = 0; listMode = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) { flushList(); continue; }

    // List item
    if (/^\s+-\s+/.test(line)) {
      listMode = true;
      listBuf.push(line.replace(/^\s+-\s+/, '').trim());
      continue;
    }

    flushList();
    const kv = line.match(/^([\w_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    currentKey = key;
    if (val.startsWith('[') && val.endsWith(']')) {
      result[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else if (val === '') {
      // value will come from list items on next lines
    } else {
      result[key] = val.trim();
    }
  }
  flushList();
  return result;
}

// ---------------------------------------------------------------------------
// Extract first meaningful paragraph from markdown body
// ---------------------------------------------------------------------------
function firstParagraph(body: string): string {
  const lines = body.split('\n');
  const buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('```') || t.startsWith('|')) {
      if (buf.length > 0) break;
      continue;
    }
    buf.push(t);
    if (buf.length >= 3) break;
  }
  return buf.join(' ').slice(0, 280);
}

// ---------------------------------------------------------------------------
// Parse a single skill file → raw fields
// ---------------------------------------------------------------------------
function parseSkillFile(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const ext     = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    try { return JSON.parse(content); } catch { return {}; }
  }

  if (ext === '.yaml' || ext === '.yml') {
    return parseSimpleYaml(content);
  }

  // .md / .txt — frontmatter + body
  const { meta, body } = parseFrontmatter(content);
  if (!meta['description']) {
    meta['description'] = firstParagraph(body);
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Coerce raw fields → ManifestEntry
// ---------------------------------------------------------------------------
function buildEntry(
  raw: Record<string, unknown>,
  filePath: string,
  index: number,
  prefix: string
): ManifestEntry {
  const stem = slugify(path.basename(filePath, path.extname(filePath)));

  const id: string = slugify(
    String(raw['id'] ?? raw['name'] ?? raw['skill_id'] ?? stem)
  );

  const description: string = String(
    raw['description'] ?? raw['summary'] ?? raw['about'] ?? ''
  ).trim().slice(0, 500) || `Skill: ${id}`;

  const input_type: string = String(
    raw['input_type'] ?? raw['input'] ?? 'text'
  ).trim();

  const output_type: string = String(
    raw['output_type'] ?? raw['output'] ?? 'text'
  ).trim();

  const rawConstraints = raw['constraints'] ?? raw['rules'] ?? [];
  const constraints: string[] = Array.isArray(rawConstraints)
    ? rawConstraints.map(String)
    : typeof rawConstraints === 'string'
      ? rawConstraints.split(',').map(s => s.trim()).filter(Boolean)
      : ['exact match required', 'no explanation', 'no punctuation'];

  const category: string = String(
    raw['category'] ??
    (Array.isArray(raw['tags']) ? raw['tags'][0] : undefined) ??
    raw['type'] ??
    'custom'
  ).trim();

  const token = makeToken(prefix, index, id, description);

  return { id, token, category, description, input_type, output_type, constraints, source_file: filePath };
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
  const args       = parseArgs(process.argv);
  const skillsDir  = path.resolve(args['skills'] ?? './skills');
  const outPath    = path.resolve(args['out'] ?? './suites/routing-format/format-manifest.json');
  const prefix     = (args['prefix'] ?? 'BENCH').toUpperCase();

  if (!fs.existsSync(skillsDir)) {
    console.error(`Error: skills directory not found: ${skillsDir}`);
    console.error('Usage: tsx repair/ingest-skills.ts --skills ./my-skills');
    process.exit(1);
  }

  const SUPPORTED = new Set(['.md', '.txt', '.yaml', '.yml', '.json']);
  const files = fs.readdirSync(skillsDir)
    .filter(f => SUPPORTED.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(skillsDir, f));

  if (files.length === 0) {
    console.error(`Error: no .md/.yaml/.json/.txt skill files found in ${skillsDir}`);
    process.exit(1);
  }

  console.log(`\n═══ ingest-skills ═══`);
  console.log(`Source: ${skillsDir} (${files.length} files)`);
  console.log(`Output: ${outPath}`);
  console.log(`Prefix: ${prefix}\n`);

  const entries: ManifestEntry[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    try {
      const raw   = parseSkillFile(filePath);
      const entry = buildEntry(raw, filePath, i, prefix);

      if (!entry.description || entry.description === `Skill: ${entry.id}`) {
        warnings.push(`  ⚠  ${path.basename(filePath)}: no description found — using fallback`);
      }

      entries.push(entry);
      console.log(`  ✓  [${String(i + 1).padStart(3, '0')}] ${entry.id}`);
    } catch (err) {
      warnings.push(`  ✗  ${path.basename(filePath)}: parse error — ${(err as Error).message}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    warnings.forEach(w => console.log(w));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));

  console.log(`\n── Summary ──`);
  console.log(`  Ingested: ${entries.length} skills`);
  console.log(`  Warnings: ${warnings.length}`);
  console.log(`  Output:   ${outPath}`);
  console.log(`\nNext: tsx repair/pre-score.ts --manifest ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
