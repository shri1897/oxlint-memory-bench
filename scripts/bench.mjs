#!/usr/bin/env node

/**
 * oxlint jsPlugins Memory & Time Scaling Benchmark
 *
 * Generates realistic TypeScript/React files of varying sizes, starts `oxlint --lsp`,
 * sends didOpen for all files, and measures RSS + time at each scale.
 *
 * Usage:
 *   node scripts/bench.mjs [options]
 *
 * Options:
 *   --repo /path/to/repo        Use a real repository instead of generating synthetic files.
 *                                The repo must have .oxlintrc.json with jsPlugins configured.
 *                                Files are collected from the repo and opened incrementally.
 *   --oxlint-bin /path/to/bin   Custom oxlint binary or cli.js (default: npx oxlint from repo or cwd)
 *   --settle-ms 5000            Wait after last file for processing (default: 5000)
 *   --batch-size 500            Files per didOpen batch (default: 500)
 *   --output path               Save JSON results (default: results/<label>.json)
 *
 * Examples:
 *   node scripts/bench.mjs                                        # synthetic files
 *   node scripts/bench.mjs --repo /path/to/monorepo               # real repo
 *   node scripts/bench.mjs --repo /path/to/repo --oxlint-bin /path/to/patched/cli.js
 */

import { spawn, execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const LIBS_DIR = join(ROOT, 'libs');
const RESULTS_DIR = join(ROOT, 'results');

// --- Args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const CUSTOM_BIN = getArg('oxlint-bin', null);
const REPO = getArg('repo', null);
const SETTLE_MS = parseInt(getArg('settle-ms', '5000'), 10);
const BATCH_SIZE = parseInt(getArg('batch-size', '500'), 10);

const FILE_COUNTS = [10, 100, 500, 1_000, 5_000, 10_000, 20_000, 30_000, 50_000, 75_000, 100_000, 200_000];

// When --repo is provided, use the repo's files and oxlint
const REPO_ROOT = REPO ? resolve(REPO) : null;

// --- oxlint ---
const LSP_CWD = REPO_ROOT || ROOT;

function spawnLsp() {
  if (CUSTOM_BIN) {
    const p = resolve(CUSTOM_BIN);
    if (p.endsWith('.js') || p.endsWith('.mjs'))
      return spawn('node', [p, '--lsp'], { cwd: LSP_CWD, stdio: ['pipe', 'pipe', 'pipe'] });
    return spawn(p, ['--lsp'], { cwd: LSP_CWD, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn('npx', ['oxlint', '--lsp'], { cwd: LSP_CWD, stdio: ['pipe', 'pipe', 'pipe'] });
}

function getVersion() {
  try {
    if (CUSTOM_BIN) {
      const p = resolve(CUSTOM_BIN);
      if (p.endsWith('.js') || p.endsWith('.mjs'))
        return execSync(`node ${p} --version`, { cwd: LSP_CWD, encoding: 'utf8' }).trim();
      return execSync(`${p} --version`, { encoding: 'utf8' }).trim();
    }
    return execSync('npx oxlint --version', { cwd: LSP_CWD, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

const version = getVersion().replace(/^(Version:\s*|oxlint\s*)/i, '');
const binLabel = CUSTOM_BIN ? resolve(CUSTOM_BIN).split('/').slice(-2).join('/') : 'npx-oxlint';
const OUTPUT = getArg('output', join(RESULTS_DIR, `${binLabel.replace(/[/:]/g, '_')}.json`));

// --- LSP ---
let msgId = 0;
function encode(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

// --- Memory ---
function getRssMb(pid) {
  try { return parseInt(execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim(), 10) / 1024; }
  catch { return 0; }
}

function getTreeRss(pid) {
  let total = getRssMb(pid);
  try {
    for (const cpid of execSync(`pgrep -P ${pid}`, { encoding: 'utf8' }).trim().split('\n').map(Number).filter(Boolean)) {
      total += getRssMb(cpid);
      try { for (const gc of execSync(`pgrep -P ${cpid}`, { encoding: 'utf8' }).trim().split('\n').map(Number).filter(Boolean)) total += getRssMb(gc); } catch {}
    }
  } catch {}
  return total;
}

// ============================================================================
// File generation — realistic sizes matching real monorepo distribution
//
// Real codebase stats (sampled 5K files):
//   min: 1, p25: 12, median: 35, p75: 90, p95: 314, avg: 165, max: 413K
//
// We generate files in 5 size buckets to match this distribution:
//   50% small    (10-40 lines)  — type defs, re-exports, simple hooks
//   25% medium   (50-120 lines) — components, utilities
//   15% large    (150-400 lines) — complex components, state management
//    8% xl       (500-1000 lines) — pages, forms, data tables
//    2% xxl      (1500-3000 lines) — generated code, large modules
// ============================================================================

function pascal(s) { return s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(''); }

// Generate a block of interface/type definitions (fills lines realistically)
function typeBlock(prefix, count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += `export interface ${prefix}Item${i} {\n`;
    out += `  id: string;\n  name: string;\n  value: number;\n`;
    out += `  description?: string;\n  createdAt: Date;\n  updatedAt: Date;\n`;
    out += `  metadata: Record<string, unknown>;\n  tags: string[];\n`;
    out += `  status: 'active' | 'inactive' | 'pending';\n  priority: number;\n}\n\n`;
  }
  return out;
}

// Generate a React component with hooks (fills ~30-60 lines per component)
function componentBlock(prefix, idx) {
  return `
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

interface ${prefix}Props${idx} {
  id: string;
  label: string;
  description?: string;
  items: Array<{ id: string; name: string; value: number }>;
  onAction?: (id: string, action: string) => void;
  onSelect?: (item: { id: string; name: string }) => void;
  className?: string;
  isLoading?: boolean;
  error?: Error | null;
}

export const ${prefix}Component${idx} = ({
  id, label, description, items, onAction, onSelect, className, isLoading, error
}: ${prefix}Props${idx}) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'value'>('name');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id) {
      fetch(\`/api/details/\${id}\`)
        .then(res => res.json())
        .then(data => setSelected(data.defaultSelection))
        .catch(() => setSelected(null));
    }
  }, [id]);

  const filteredItems = useMemo(
    () => items
      .filter(item => item.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => sortBy === 'name'
        ? a.name.localeCompare(b.name)
        : a.value - b.value
      ),
    [items, filter, sortBy]
  );

  const handleSelect = useCallback((itemId: string) => {
    setSelected(itemId);
    const item = items.find(i => i.id === itemId);
    if (item && onSelect) onSelect({ id: item.id, name: item.name });
  }, [items, onSelect]);

  const handleAction = useCallback((action: string) => {
    if (onAction && selected) onAction(selected, action);
  }, [onAction, selected]);

  if (isLoading) return <div className={className}>Loading {label}...</div>;
  if (error) return <div className={className}>Error: {error.message}</div>;

  return (
    <div ref={containerRef} className={className}>
      <h2>{label}</h2>
      {description && <p>{description}</p>}
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter..." />
      <button onClick={() => setSortBy(s => s === 'name' ? 'value' : 'name')}>Sort by {sortBy}</button>
      <div>
        {filteredItems.map(item => (
          <div
            key={item.id}
            onClick={() => handleSelect(item.id)}
            style={{ fontWeight: selected === item.id ? 'bold' : 'normal' }}
          >
            <span>{item.name}</span>
            <span>{item.value}</span>
            <button onClick={e => { e.stopPropagation(); handleAction('delete'); }}>Delete</button>
          </div>
        ))}
      </div>
      <div>{filteredItems.length} of {items.length} items</div>
    </div>
  );
};
`;
}

// Generate utility/helper functions block
function utilBlock(prefix, count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += `export function ${prefix}Util${i}(input: string, options?: { trim?: boolean; upper?: boolean; maxLen?: number }): string {\n`;
    out += `  let result = input;\n`;
    out += `  if (options?.trim) result = result.trim();\n`;
    out += `  if (options?.upper) result = result.toUpperCase();\n`;
    out += `  if (options?.maxLen && result.length > options.maxLen) result = result.slice(0, options.maxLen) + '...';\n`;
    out += `  return result;\n}\n\n`;
  }
  return out;
}

// Generate a hook block
function hookBlock(prefix, idx) {
  return `
export function use${prefix}${idx}(endpoint: string, params?: Record<string, string>) {
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const url = new URL(endpoint, 'https://api.example.com');
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    fetch(url.toString(), { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(\`HTTP \${r.status}\`); return r.json(); })
      .then(d => { setData(d); setError(null); })
      .catch(e => { if (e.name !== 'AbortError') setError(e); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [endpoint]);

  return { data, loading, error, refetch: () => setLoading(true) };
}
`;
}

function generateFile(fileIdx, targetLines) {
  const prefix = pascal(`mod-${String(fileIdx).padStart(6, '0')}`);
  let content = `import { useState, useEffect, useCallback, useMemo, useRef } from 'react';\nimport type { ReactNode } from 'react';\n\n`;

  if (targetLines <= 40) {
    // Small: type defs + 1 small export
    content += typeBlock(prefix, 2);
    content += `export const ${prefix}Default = { id: '', name: '${prefix}' };\n`;
  } else if (targetLines <= 120) {
    // Medium: 1 component
    content += componentBlock(prefix, fileIdx);
  } else if (targetLines <= 400) {
    // Large: component + types + utils
    content += typeBlock(prefix, 3);
    content += componentBlock(prefix, fileIdx);
    content += utilBlock(prefix, 4);
    content += hookBlock(prefix, fileIdx);
  } else if (targetLines <= 1000) {
    // XL: multiple components + many types
    content += typeBlock(prefix, 6);
    content += componentBlock(prefix, fileIdx);
    content += componentBlock(prefix + 'Sub', fileIdx + 1000000);
    content += utilBlock(prefix, 8);
    content += hookBlock(prefix, fileIdx);
    content += hookBlock(prefix + 'Alt', fileIdx + 1000000);
  } else {
    // XXL: lots of everything
    content += typeBlock(prefix, 15);
    for (let c = 0; c < 4; c++) {
      content += componentBlock(prefix + `Part${c}`, fileIdx * 10 + c);
    }
    content += utilBlock(prefix, 20);
    for (let h = 0; h < 5; h++) {
      content += hookBlock(prefix + `Hook${h}`, fileIdx * 10 + h);
    }
  }

  return content;
}

// Size distribution matching real codebase
function getTargetLines(fileIdx) {
  const r = ((fileIdx * 2654435761) >>> 0) / 4294967296; // deterministic hash-based pseudo-random
  if (r < 0.50) return 10 + Math.floor(r * 60);          // 50%: 10-40 lines
  if (r < 0.75) return 50 + Math.floor((r - 0.50) * 280); // 25%: 50-120 lines
  if (r < 0.90) return 150 + Math.floor((r - 0.75) * 1667); // 15%: 150-400 lines
  if (r < 0.98) return 500 + Math.floor((r - 0.90) * 6250); // 8%: 500-1000 lines
  return 1500 + Math.floor((r - 0.98) * 75000);              // 2%: 1500-3000 lines
}

function generateFiles(targetCount) {
  if (existsSync(LIBS_DIR)) rmSync(LIBS_DIR, { recursive: true });

  const filesPerLib = 10;
  const libCount = Math.ceil(targetCount / filesPerLib);
  let generated = 0;

  for (let lib = 0; lib < libCount && generated < targetCount; lib++) {
    const libDir = join(LIBS_DIR, `lib-${String(lib).padStart(5, '0')}`, 'src');
    mkdirSync(libDir, { recursive: true });

    const filesThisLib = Math.min(filesPerLib, targetCount - generated);
    for (let f = 0; f < filesThisLib; f++) {
      const fileIdx = generated;
      const targetLines = getTargetLines(fileIdx);
      writeFileSync(join(libDir, `f${f}.tsx`), generateFile(fileIdx, targetLines));
      generated++;
    }
  }
  return generated;
}

function collectFiles(dir) {
  const files = [];
  const skip = new Set(['node_modules', 'dist', '.next', '.git', '.cache', 'coverage', '__mocks__', '__tests__', '__snapshots__', '.turbo', '.rspack', 'build']);
  function walk(d, depth = 0) {
    if (depth > 12) return;
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
      }
    } catch {}
  }
  walk(dir);
  return files;
}

function collectRepoFiles(maxPerScale) {
  const allFiles = collectFiles(REPO_ROOT);
  // Shuffle deterministically so each scale gets a representative sample
  allFiles.sort((a, b) => {
    const ha = ((a.length * 2654435761) >>> 0);
    const hb = ((b.length * 2654435761) >>> 0);
    return ha - hb;
  });
  return allFiles.slice(0, maxPerScale);
}

// --- Run one benchmark ---
async function benchAtScale(targetFiles) {
  let files;
  if (REPO_ROOT) {
    // Real repo mode: collect files from repo
    files = collectRepoFiles(targetFiles);
    if (files.length < targetFiles) {
      // Not enough files in repo for this scale
      return { files: files.length, rssMb: -1, timeMs: -1, skipped: true };
    }
    files = files.slice(0, targetFiles);
  } else {
    // Synthetic mode: generate files
    generateFiles(targetFiles);
    files = collectFiles(LIBS_DIR);
  }

  return new Promise((done) => {
    const child = spawnLsp();
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});

    const t0 = Date.now();

    const wsRoot = resolve(REPO_ROOT || ROOT);
    child.stdin.write(encode({
      jsonrpc: '2.0', id: ++msgId, method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: `file://${wsRoot}`,
        workspaceFolders: [{ uri: `file://${wsRoot}`, name: 'bench' }],
        capabilities: { workspace: { workspaceFolders: true }, textDocument: { publishDiagnostics: { relatedInformation: true } } },
      },
    }));

    setTimeout(() => {
      child.stdin.write(encode({ jsonrpc: '2.0', method: 'initialized', params: {} }));

      let idx = 0;
      function openBatch() {
        const end = Math.min(idx + BATCH_SIZE, files.length);
        for (; idx < end; idx++) {
          try {
            const f = files[idx];
            child.stdin.write(encode({
              jsonrpc: '2.0', method: 'textDocument/didOpen',
              params: { textDocument: { uri: `file://${f}`, languageId: 'typescriptreact', version: 1, text: readFileSync(f, 'utf8') } },
            }));
          } catch {}
        }

        if (idx < files.length) {
          setTimeout(openBatch, 50);
        } else {
          setTimeout(() => {
            const totalMs = Date.now() - t0;
            const rssMb = getTreeRss(child.pid);
            child.stdin.write(encode({ jsonrpc: '2.0', id: ++msgId, method: 'shutdown', params: null }));
            setTimeout(() => { child.kill(); done({ files: files.length, rssMb: Math.round(rssMb), timeMs: totalMs }); }, 500);
          }, SETTLE_MS);
        }
      }
      openBatch();
    }, 500);

    setTimeout(() => { child.kill(); done({ files: files.length, rssMb: -1, timeMs: -1 }); }, 600_000);
  });
}

// --- Main ---
mkdirSync(RESULTS_DIR, { recursive: true });

console.log('='.repeat(80));
console.log('  oxlint LSP Memory & Time Scaling Benchmark');
console.log('='.repeat(80));
console.log(`  Mode:      ${REPO_ROOT ? `real repo (${REPO_ROOT})` : 'synthetic files'}`);
console.log(`  Binary:    ${CUSTOM_BIN ? resolve(CUSTOM_BIN) : 'npx oxlint'}`);
console.log(`  Version:   ${version}`);
console.log(`  Scales:    ${FILE_COUNTS.map(n => n.toLocaleString('en-US')).join(', ')} files`);
console.log(`  Settle:    ${SETTLE_MS}ms per scale`);
console.log('='.repeat(80));
console.log();

const results = [];

for (const target of FILE_COUNTS) {
  process.stdout.write(`  ${String(target.toLocaleString('en-US')).padStart(9)} files ... `);
  const r = await benchAtScale(target);
  if (r.skipped) {
    console.log(`skipped (only ${r.files} files available)`);
    break;
  }
  const timeSec = (r.timeMs / 1000).toFixed(1);
  console.log(`${String(r.rssMb).padStart(6)} MB  ${timeSec.padStart(7)}s`);
  results.push(r);
}

// --- Table ---
console.log('\n' + '='.repeat(80));
console.log('  Results');
console.log('='.repeat(80));
console.log('  ' + 'Files'.padStart(10) + 'RSS (MB)'.padStart(12) + 'Time (s)'.padStart(12));
console.log('  ' + '-'.repeat(34));

for (const r of results) {
  console.log(
    '  ' +
    String(r.files.toLocaleString('en-US')).padStart(10) +
    String(r.rssMb).padStart(12) +
    (r.timeMs / 1000).toFixed(1).padStart(12)
  );
}

// --- Memory chart ---
console.log('\n' + '='.repeat(80));
console.log('  Memory Scaling');
console.log('='.repeat(80));

const maxRss = Math.max(...results.map(r => r.rssMb), 1);
const barWidth = 50;

for (const r of results) {
  const len = Math.max(0, Math.round((r.rssMb / maxRss) * barWidth));
  const bar = '\u2588'.repeat(len) + '\u2591'.repeat(barWidth - len);
  console.log(`  ${String(r.files.toLocaleString('en-US')).padStart(9)} ${bar} ${r.rssMb} MB`);
}

// --- Time chart ---
console.log('\n' + '='.repeat(80));
console.log('  Time Scaling');
console.log('='.repeat(80));

const maxTime = Math.max(...results.map(r => r.timeMs), 1);
for (const r of results) {
  const len = Math.max(0, Math.round((r.timeMs / maxTime) * barWidth));
  const bar = '\u2588'.repeat(len) + '\u2591'.repeat(barWidth - len);
  console.log(`  ${String(r.files.toLocaleString('en-US')).padStart(9)} ${bar} ${(r.timeMs / 1000).toFixed(1)}s`);
}

// --- Save ---
const output = {
  meta: { version, binary: CUSTOM_BIN || 'npx oxlint', platform: `${process.platform} ${process.arch}`, nodeVersion: process.version, date: new Date().toISOString(), settleMs: SETTLE_MS },
  results,
};
writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(`\nResults saved to ${OUTPUT}`);

if (!REPO_ROOT && existsSync(LIBS_DIR)) rmSync(LIBS_DIR, { recursive: true });
