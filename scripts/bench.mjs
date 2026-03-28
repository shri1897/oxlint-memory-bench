#!/usr/bin/env node

/**
 * oxlint jsPlugins Memory & Time Scaling Benchmark
 *
 * Generates synthetic TypeScript/React files, starts `oxlint --lsp`,
 * sends didOpen for all files, and measures RSS + time at each scale.
 *
 * Usage:
 *   node scripts/bench.mjs [options]
 *
 * Options:
 *   --oxlint-bin /path/to/bin   Custom oxlint binary or cli.js (default: npx oxlint)
 *   --files-per-lib 10          Files per lib (default: 10)
 *   --settle-ms 5000            Wait after last file for processing (default: 5000)
 *   --batch-size 500            Files per didOpen batch (default: 500)
 *   --output path               Save JSON results (default: results/<label>.json)
 *
 * Examples:
 *   node scripts/bench.mjs
 *   node scripts/bench.mjs --oxlint-bin /path/to/patched/cli.js
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
const FILES_PER_LIB = parseInt(getArg('files-per-lib', '10'), 10);
const SETTLE_MS = parseInt(getArg('settle-ms', '5000'), 10);
const BATCH_SIZE = parseInt(getArg('batch-size', '500'), 10);

const FILE_COUNTS = [10, 100, 500, 1_000, 5_000, 10_000, 20_000, 30_000, 50_000, 75_000, 100_000, 200_000];

// --- oxlint resolution ---
function spawnLsp() {
  if (CUSTOM_BIN) {
    if (CUSTOM_BIN.endsWith('.js') || CUSTOM_BIN.endsWith('.mjs'))
      return spawn('node', [resolve(CUSTOM_BIN), '--lsp'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    return spawn(resolve(CUSTOM_BIN), ['--lsp'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn('npx', ['oxlint', '--lsp'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
}

function getVersion() {
  try {
    if (CUSTOM_BIN) {
      if (CUSTOM_BIN.endsWith('.js') || CUSTOM_BIN.endsWith('.mjs'))
        return execSync(`node ${resolve(CUSTOM_BIN)} --version`, { cwd: ROOT, encoding: 'utf8' }).trim();
      return execSync(`${resolve(CUSTOM_BIN)} --version`, { encoding: 'utf8' }).trim();
    }
    return execSync('npx oxlint --version', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

const version = getVersion().replace(/^(Version:\s*|oxlint\s*)/i, '');
const binLabel = CUSTOM_BIN ? resolve(CUSTOM_BIN).split('/').slice(-2).join('/') : 'npx-oxlint';
const OUTPUT = getArg('output', join(RESULTS_DIR, `${binLabel.replace(/[/:]/g, '_')}.json`));

// --- LSP helpers ---
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
    const children = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' }).trim().split('\n').map(Number).filter(Boolean);
    for (const cpid of children) {
      total += getRssMb(cpid);
      try {
        const gc = execSync(`pgrep -P ${cpid}`, { encoding: 'utf8' }).trim().split('\n').map(Number).filter(Boolean);
        for (const gcpid of gc) total += getRssMb(gcpid);
      } catch {}
    }
  } catch {}
  return total;
}

// --- File generation ---
function pascal(str) { return str.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(''); }

const templates = [
  (lib, i) => `import { useState, useEffect, useCallback } from 'react';
import { unusedHelper } from './utils';
interface ${pascal(lib)}Props${i} { id: string; label: string; onAction?: (id: string) => void; }
export const ${pascal(lib)}C${i} = ({ id, label, onAction }: ${pascal(lib)}Props${i}) => {
  const [s, setS] = useState<string | null>(null);
  const [l, setL] = useState(false);
  useEffect(() => { setL(true); fetch(\`/api/\${id}\`).then(r => r.json()).then(d => setS(d.v)).finally(() => setL(false)); }, [id]);
  const h = useCallback(() => { onAction?.(id); }, [id, onAction]);
  if (l) return <div>Loading...</div>;
  return <div onClick={h}><span>{label}</span><span>{s}</span></div>;
};
`,
  (lib, i) => `import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
interface Row { id: string; name: string; value: number; }
interface ${pascal(lib)}TP${i} { rows: Row[]; sortBy?: keyof Row; onClick?: (r: Row) => void; }
export const ${pascal(lib)}T${i} = ({ rows, sortBy = 'name', onClick }: ${pascal(lib)}TP${i}) => {
  const ref = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => [...rows].sort((a, b) => String(a[sortBy]).localeCompare(String(b[sortBy]))), [rows, sortBy]);
  return <div ref={ref}>{sorted.map(r => <div key={r.id} onClick={() => onClick?.(r)}><span>{r.name}</span><span>{r.value}</span></div>)}</div>;
};
`,
  (lib, i) => `import { createContext, useContext, useReducer } from 'react';
import type { Dispatch } from 'react';
interface S${i} { items: string[]; selected: string | null; filter: string; }
type A${i} = { type: 'ADD'; payload: string } | { type: 'SEL'; payload: string } | { type: 'FILT'; payload: string } | { type: 'RESET' };
const init: S${i} = { items: [], selected: null, filter: '' };
function reducer(s: S${i}, a: A${i}): S${i} {
  switch(a.type) { case 'ADD': return {...s, items: [...s.items, a.payload]}; case 'SEL': return {...s, selected: a.payload}; case 'FILT': return {...s, filter: a.payload}; case 'RESET': return init; default: return s; }
}
const Ctx${i} = createContext<{s: S${i}; d: Dispatch<A${i}>} | null>(null);
export const use${pascal(lib)}${i} = () => { const c = useContext(Ctx${i}); if(!c) throw new Error('Missing'); return c; };
`,
  (lib, i) => `export interface ${pascal(lib)}Cfg${i} { endpoint: string; timeout: number; retries: number; headers: Record<string, string>; }
export interface ${pascal(lib)}Res${i}<T> { data: T; status: number; ts: number; }
export async function fetch${pascal(lib)}${i}<T>(cfg: ${pascal(lib)}Cfg${i}, path: string, params?: Record<string, string>): Promise<${pascal(lib)}Res${i}<T>> {
  const url = new URL(path, cfg.endpoint);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  let err: Error | null = null;
  for (let i = 0; i < cfg.retries; i++) {
    try { const r = await fetch(url.toString(), { headers: cfg.headers, signal: AbortSignal.timeout(cfg.timeout) }); if (!r.ok) throw new Error(\`HTTP \${r.status}\`); return { data: await r.json() as T, status: r.status, ts: Date.now() }; }
    catch (e) { err = e as Error; }
  }
  throw err;
}
`,
  (lib, i) => `import { useEffect, useState } from 'react';
type ET = 'click' | 'hover' | 'scroll' | 'resize';
interface AE { type: ET; target: string; ts: number; meta?: Record<string, unknown>; }
const q: AE[] = []; let t: ReturnType<typeof setTimeout> | null = null;
function enq(e: AE) { q.push(e); if (!t) t = setTimeout(flush, 5000); }
async function flush() { t = null; if (!q.length) return; const b = q.splice(0); await fetch('/api/a', { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } }).catch(() => q.unshift(...b)); }
export function useTrack${pascal(lib)}${i}(target: string) {
  const [c, setC] = useState(0);
  useEffect(() => () => { flush(); }, []);
  return { track: (type: ET, meta?: Record<string, unknown>) => { enq({ type, target, ts: Date.now(), meta }); setC(v => v + 1); }, count: c };
}
`,
];

function generateFiles(targetCount) {
  if (existsSync(LIBS_DIR)) rmSync(LIBS_DIR, { recursive: true });

  const libCount = Math.ceil(targetCount / FILES_PER_LIB);
  let generated = 0;

  for (let lib = 0; lib < libCount && generated < targetCount; lib++) {
    const libName = `lib-${String(lib).padStart(5, '0')}`;
    const srcDir = join(LIBS_DIR, libName, 'src');
    mkdirSync(srcDir, { recursive: true });

    const filesThisLib = Math.min(FILES_PER_LIB, targetCount - generated);
    for (let f = 0; f < filesThisLib; f++) {
      writeFileSync(join(srcDir, `c${f}.tsx`), templates[f % templates.length](libName, f));
      generated++;
    }
    // Don't write extra files — keep file count exact
  }
  return generated;
}

function collectFiles() {
  const files = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) files.push(full);
    }
  }
  walk(LIBS_DIR);
  return files;
}

// --- Run one benchmark at a given file count ---
async function benchAtScale(targetFiles) {
  const generated = generateFiles(targetFiles);
  const files = collectFiles();

  return new Promise((done) => {
    const child = spawnLsp();
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});

    const t0 = Date.now();

    // Initialize
    child.stdin.write(encode({
      jsonrpc: '2.0', id: ++msgId, method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: `file://${resolve(ROOT)}`,
        workspaceFolders: [{ uri: `file://${resolve(ROOT)}`, name: 'bench' }],
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
              params: { textDocument: { uri: `file://${f}`, languageId: f.endsWith('.tsx') ? 'typescriptreact' : 'typescript', version: 1, text: readFileSync(f, 'utf8') } },
            }));
          } catch {}
        }

        if (idx < files.length) {
          setTimeout(openBatch, 50);
        } else {
          // Settle, then measure
          setTimeout(() => {
            const totalMs = Date.now() - t0;
            const rssMb = getTreeRss(child.pid);

            child.stdin.write(encode({ jsonrpc: '2.0', id: ++msgId, method: 'shutdown', params: null }));
            setTimeout(() => {
              child.kill();
              done({ files: files.length, rssMb: Math.round(rssMb), timeMs: totalMs });
            }, 500);
          }, SETTLE_MS);
        }
      }

      openBatch();
    }, 500);

    // Safety
    setTimeout(() => { child.kill(); done({ files: files.length, rssMb: -1, timeMs: -1 }); }, 600_000);
  });
}

// --- Main ---
mkdirSync(RESULTS_DIR, { recursive: true });

console.log('='.repeat(80));
console.log('  oxlint LSP Memory & Time Scaling Benchmark');
console.log('='.repeat(80));
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
  const timeSec = (r.timeMs / 1000).toFixed(1);
  console.log(`${String(r.rssMb).padStart(6)} MB  ${timeSec.padStart(7)}s`);
  results.push(r);
}

// --- Table ---
console.log('\n' + '='.repeat(80));
console.log('  Results');
console.log('='.repeat(80));
console.log('  ' + 'Files'.padStart(10) + 'RSS (MB)'.padStart(12) + 'Time (s)'.padStart(12) + '  MB/1K files'.padStart(14));
console.log('  ' + '-'.repeat(48));

for (const r of results) {
  const mbPer1k = r.files > 0 ? ((r.rssMb / r.files) * 1000).toFixed(1) : '?';
  console.log(
    '  ' +
    String(r.files.toLocaleString('en-US')).padStart(10) +
    String(r.rssMb).padStart(12) +
    (r.timeMs / 1000).toFixed(1).padStart(12) +
    String(mbPer1k).padStart(14)
  );
}

// --- Chart ---
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
  meta: { version, binary: CUSTOM_BIN || 'npx oxlint', platform: `${process.platform} ${process.arch}`, nodeVersion: process.version, date: new Date().toISOString(), filesPerLib: FILES_PER_LIB, settleMs: SETTLE_MS },
  results,
};
writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(`\nResults saved to ${OUTPUT}`);

// Cleanup
if (existsSync(LIBS_DIR)) rmSync(LIBS_DIR, { recursive: true });
