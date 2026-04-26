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
 *   id           → frontmatter 'name'/'id' field, or parent folder name (recursive),
 *                  or filename stem
 *   description  → 'description' field, or first non-empty paragraph of body
 *   input_type   → 'input_type' / 'input' field, or "text" fallback
 *   output_type  → 'output_type' / 'output' field, or "text" fallback
 *   constraints  → 'constraints' array field, or []
 *   category     → 'category' / 'tags[0]' field, or "custom"
 *
 * Token generation:
 *   Deterministic: {PREFIX}-{idx}::{djb2(id)}.{djb2(description)[0:8]}
 *   Stable across runs as long as skill id + description don't change.
 *
 * Flags:
 *   --skills     ./path/to/skills     Root folder to read from (default: ./skills)
 *   --out        ./path/manifest.json Output path (default: ./suites/routing-format/format-manifest.json)
 *   --prefix     BENCH                Token prefix (default: BENCH)
 *   --recursive                       Walk subdirectories recursively
 *   --filename   SKILL.md            Only ingest files with this exact name (use with --recursive)
 *
 * Usage examples:
 *   # Flat folder (original behaviour)
 *   tsx repair/ingest-skills.ts --skills ./my-skills
 *
 *   # mattpocock/skills style — {skill-name}/SKILL.md
 *   tsx repair/ingest-skills.ts --skills ./mattpocock-skills --recursive --filename SKILL.md
 *
 *   # Recursive, any supported extension
 *   tsx repair/ingest-skills.ts --skills ./g-stack --recursive
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
    hash = hash >>> 0;
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
// File discovery
// ---------------------------------------------------------------------------
const SUPPORTED_EXTS = new Set(['.md', '.txt', '.yaml', '.yml', '.json']);

/**
 * Collect skill files from root.
 * --recursive: walk all subdirectories
 * --filename:  only match files with this exact name (e.g. SKILL.md)
 */
function collectFiles(
  root: string,
  recursive: boolean,
  filenameFilter: string | null
): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(fullPath);
      } else if (entry.isFile()) {
        const ext  = path.extname(entry.name).toLowerCase();
        const name = entry.name;
        if (!SUPPORTED_EXTS.has(ext)) continue;
        if (filenameFilter && name !== filenameFilter) continue;
        results.push(fullPath);
      }
    }
  }

  walk(root);
  return results.sort();
}

// ---------------------------------------------------------------------------
// ID resolution
// ---------------------------------------------------------------------------
/**
 * When --recursive is active and a file is named SKILL.md (or matches --filename),
 * use the parent directory name as the skill id — that's the human-readable skill
 * name in repos like mattpocock/skills.
 *
 * Falls back to frontmatter name/id field, then filename stem.
 */
function resolveId(
  raw: Record<string, unknown>,
  filePath: string,
  root: string,
  recursive: boolean,
  filenameFilter: string | null
): string {
  // Prefer explicit field in frontmatter
  if (raw['name'] || raw['id'] || raw['skill_id']) {
    return slugify(String(raw['name'] ?? raw['id'] ?? raw['skill_id']));
  }

  // In recursive mode, use the parent folder name (e.g. caveman/SKILL.md → caveman)
  if (recursive) {
    const parentDir = path.basename(path.dirname(filePath));
    // Only use parent folder if it's not the root itself
    if (path.resolve(path.dirname(filePath)) !== path.resolve(root)) {
      return slugify(parentDir);
    }
  }

  // Fallback: filename stem
  return slugify(path.basename(filePath, path.extname(filePath)));
}

// ---------------------------------------------------------------------------
// Frontmatter parser (--- key: value ---)
// Handles YAML block scalars (>) used in mattpocock/skills descriptions
// ---------------------------------------------------------------------------
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const meta: Record<string, unknown> = {};
  let body = content;

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) return { meta, body };

  body = fmMatch[2];
  const lines = fmMatch[1].split('\n');
  let currentKey = '';
  let blockScalar = false;
  const blockBuf: string[] = [];

  const flushBlock = () => {
    if (blockScalar && currentKey) {
      meta[currentKey] = blockBuf.join(' ').trim();
      blockBuf.length = 0;
      blockScalar = false;
    }
  };

  for (const line of lines) {
    // Continuation of a block scalar (indented lines after key: >)
    if (blockScalar) {
      if (/^\s+/.test(line)) {
        blockBuf.push(line.trim());
        continue;
      } else {
        flushBlock();
      }
    }

    const kv = line.match(/^([\w_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    currentKey = key;

    if (val === '>') {
      // YAML block scalar — collect indented lines that follow
      blockScalar = true;
      continue;
    }

    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      meta[key] = val.trim();
    }
  }
  flushBlock();

  return { meta, body };
}

// ---------------------------------------------------------------------------
// YAML parser — minimal flat key/value + lists (no deps)
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
    } else if (val !== '') {
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
  root: string,
  index: number,
  prefix: string,
  recursive: boolean,
  filenameFilter: string | null
): ManifestEntry {
  const id = resolveId(raw, filePath, root, recursive, filenameFilter);

  const description: string = String(
    raw['description'] ?? raw['summary'] ?? raw['about'] ?? ''
  ).trim().slice(0, 500) || `Skill: ${id}`;

  const input_type: string  = String(raw['input_type']  ?? raw['input']  ?? 'text').trim();
  const output_type: string = String(raw['output_type'] ?? raw['output'] ?? 'text').trim();

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
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      // Boolean flag (no value) vs key=value flag
      if (!next || next.startsWith('--')) {
        args[key] = 'true';
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args           = parseArgs(process.argv);
  const skillsDir      = path.resolve(args['skills'] ?? './skills');
  const outPath        = path.resolve(args['out'] ?? './suites/routing-format/format-manifest.json');
  const prefix         = (args['prefix'] ?? 'BENCH').toUpperCase();
  const recursive      = args['recursive'] === 'true';
  const filenameFilter = args['filename'] ?? null;

  if (!fs.existsSync(skillsDir)) {
    console.error(`Error: skills directory not found: ${skillsDir}`);
    console.error('Usage: tsx repair/ingest-skills.ts --skills ./my-skills');
    console.error('       tsx repair/ingest-skills.ts --skills ./mattpocock-skills --recursive --filename SKILL.md');
    process.exit(1);
  }

  const files = collectFiles(skillsDir, recursive, filenameFilter);

  if (files.length === 0) {
    console.error(`Error: no skill files found in ${skillsDir}`);
    if (!recursive) console.error('Tip: try --recursive to walk subdirectories');
    if (!filenameFilter) console.error('Tip: try --filename SKILL.md to target a specific file per folder');
    process.exit(1);
  }

  console.log(`\n═══ ingest-skills ═══`);
  console.log(`Source:    ${skillsDir}`);
  console.log(`Recursive: ${recursive}`);
  if (filenameFilter) console.log(`Filename:  ${filenameFilter}`);
  console.log(`Files:     ${files.length}`);
  console.log(`Output:    ${outPath}`);
  console.log(`Prefix:    ${prefix}\n`);

  const entries: ManifestEntry[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    try {
      const raw   = parseSkillFile(filePath);
      const entry = buildEntry(raw, filePath, skillsDir, i, prefix, recursive, filenameFilter);

      if (!entry.description || entry.description === `Skill: ${entry.id}`) {
        warnings.push(`  ⚠  ${path.relative(skillsDir, filePath)}: no description — using fallback`);
      }

      entries.push(entry);
      const relPath = path.relative(skillsDir, filePath);
      console.log(`  ✓  [${String(i + 1).padStart(3, '0')}] ${entry.id.padEnd(40)} ← ${relPath}`);
    } catch (err) {
      warnings.push(`  ✗  ${path.relative(skillsDir, filePath)}: parse error — ${(err as Error).message}`);
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
