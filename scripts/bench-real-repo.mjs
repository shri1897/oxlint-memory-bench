#!/usr/bin/env node

/**
 * Benchmarks oxlint LSP memory against a real repository by sending didOpen
 * for all .ts/.tsx files and tracking memory growth over time.
 *
 * This reproduces the exact behavior of the VS Code/Cursor extension:
 * 1. Start `oxlint --lsp`
 * 2. Send initialize/initialized
 * 3. Send didOpen for workspace files (as the editor discovers them)
 * 4. Track memory of the oxlint process and any child processes
 *
 * Usage:
 *   node scripts/bench-real-repo.mjs [options]
 *
 * Options:
 *   --repo /path/to/repo        Path to the repository (required)
 *   --oxlint-bin /path/to/bin   Custom oxlint binary or CLI script (default: npx oxlint)
 *   --max-files 15000           Max files to open (default: 15000)
 *   --batch-size 500            Files per batch (default: 500)
 *   --batch-delay 500           Delay between batches in ms (default: 500)
 *   --settle-ms 20000           Wait after last file opened (default: 20000)
 *   --output path               Save JSON results (default: results/<label>-lsp.json)
 *
 * Examples:
 *   # Test with installed oxlint (via npx)
 *   node scripts/bench-real-repo.mjs --repo /path/to/large-monorepo
 *
 *   # Test with a patched build (NAPI cli.js)
 *   node scripts/bench-real-repo.mjs --repo /path/to/repo --oxlint-bin /path/to/oxc/apps/oxlint/dist/cli.js
 *
 *   # Test with a patched Rust-only binary
 *   node scripts/bench-real-repo.mjs --repo /path/to/repo --oxlint-bin /path/to/oxc/target/release/oxlint
 */

import { spawn, execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ROOT = join(import.meta.dirname, '..');
const RESULTS_DIR = join(ROOT, 'results');

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const REPO = resolve(getArg('repo', ''));
const CUSTOM_BIN = getArg('oxlint-bin', null);
const MAX_FILES = parseInt(getArg('max-files', '15000'), 10);
const BATCH_SIZE = parseInt(getArg('batch-size', '500'), 10);
const BATCH_DELAY = parseInt(getArg('batch-delay', '500'), 10);
const SETTLE_MS = parseInt(getArg('settle-ms', '20000'), 10);

if (!REPO || !existsSync(REPO)) {
  console.error('Error: --repo is required and must be a valid path');
  console.error('Usage: node scripts/bench-real-repo.mjs --repo /path/to/repo');
  process.exit(1);
}

// --- Resolve oxlint binary ---
function resolveOxlint() {
  if (CUSTOM_BIN) {
    const resolved = resolve(CUSTOM_BIN);
    if (!existsSync(resolved)) {
      console.error(`Error: --oxlint-bin path does not exist: ${resolved}`);
      process.exit(1);
    }
    return { bin: resolved, label: `custom:${resolved.split('/').slice(-2).join('/')}` };
  }
  return { bin: null, label: 'npx-oxlint' };
}

const { bin: oxlintBin, label: binLabel } = resolveOxlint();
const OUTPUT = getArg('output', join(RESULTS_DIR, `${binLabel.replace(/[/:]/g, '_')}-lsp.json`));

// --- Spawn the LSP server ---
function spawnLsp() {
  if (oxlintBin) {
    // Custom binary: detect if it's a .js file (NAPI build) or native binary
    if (oxlintBin.endsWith('.js') || oxlintBin.endsWith('.mjs')) {
      return spawn('node', [oxlintBin, '--lsp'], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return spawn(oxlintBin, ['--lsp'], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn('npx', ['oxlint', '--lsp'], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
}

// --- Get version ---
function getVersion() {
  try {
    if (oxlintBin) {
      if (oxlintBin.endsWith('.js') || oxlintBin.endsWith('.mjs')) {
        return execSync(`node ${oxlintBin} --version`, { cwd: REPO, encoding: 'utf8' }).trim();
      }
      return execSync(`${oxlintBin} --version`, { encoding: 'utf8' }).trim();
    }
    return execSync('npx oxlint --version', { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const oxlintVersion = getVersion().replace(/^(Version:\s*|oxlint\s*)/i, '');

// --- Check oxlint config ---
const oxlintrcPath = join(REPO, '.oxlintrc.json');
if (existsSync(oxlintrcPath)) {
  const config = JSON.parse(readFileSync(oxlintrcPath, 'utf8'));
  console.log(`Config: ${oxlintrcPath}`);
  console.log(`  plugins: ${JSON.stringify(config.plugins || [])}`);
  console.log(`  jsPlugins: ${JSON.stringify(config.jsPlugins || [])}`);
} else {
  console.log('No .oxlintrc.json found — using oxlint defaults');
}
console.log(`oxlint version: ${oxlintVersion}`);
console.log(`Binary: ${oxlintBin || 'npx oxlint'}`);

// --- Helpers ---
let msgId = 0;

function encode(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function getRssMb(pid) {
  try {
    return parseInt(execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim(), 10) / 1024;
  } catch { return 0; }
}

/**
 * Get total RSS for a process and all its descendants.
 * Handles both cases:
 * - npx → node oxlint (2-process tree)
 * - direct binary (single process)
 * - node cli.js with NAPI (single process with native module)
 */
function getTreeRss(pid) {
  const selfRss = getRssMb(pid);
  let childRss = 0;
  const children = [];

  try {
    const childPids = execSync(`pgrep -P ${pid}`, { encoding: 'utf8' })
      .trim().split('\n').map(Number).filter(Boolean);
    for (const cpid of childPids) {
      const rss = getRssMb(cpid);
      childRss += rss;
      children.push({ pid: cpid, rss });
      // Check grandchildren too
      try {
        const gcPids = execSync(`pgrep -P ${cpid}`, { encoding: 'utf8' })
          .trim().split('\n').map(Number).filter(Boolean);
        for (const gcpid of gcPids) {
          const grss = getRssMb(gcpid);
          childRss += grss;
          children.push({ pid: gcpid, rss: grss });
        }
      } catch {}
    }
  } catch {}

  return { selfRss, childRss, totalRss: selfRss + childRss, children };
}

// --- Collect files ---
function collectFiles(dir) {
  const files = [];
  const skip = new Set([
    'node_modules', 'dist', '.next', '.git', '.cache', 'coverage',
    '__mocks__', '__snapshots__', '.turbo', '.rspack', 'build',
  ]);

  function walk(d, depth = 0) {
    if (files.length >= MAX_FILES || depth > 12) return;
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (files.length >= MAX_FILES) return;
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

console.log(`\nCollecting files from ${REPO}...`);
const files = collectFiles(REPO);
console.log(`Found ${files.length.toLocaleString()} .ts/.tsx/.js/.jsx files`);

// --- Run LSP ---
console.log('\n' + '='.repeat(80));
console.log('  oxlint LSP Memory Benchmark');
console.log('='.repeat(80));
console.log(`  Repo: ${REPO}`);
console.log(`  Binary: ${oxlintBin || 'npx oxlint'}`);
console.log(`  Version: ${oxlintVersion}`);
console.log(`  Files: ${files.length.toLocaleString()} | Batch: ${BATCH_SIZE} | Settle: ${SETTLE_MS}ms`);
console.log('='.repeat(80));

const child = spawnLsp();
child.stdin.on('error', () => {});
child.stderr.on('data', () => {});

const snapshots = [];
const startTime = Date.now();

function snapshot(label, filesOpened) {
  const { selfRss, childRss, totalRss } = getTreeRss(child.pid);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const snap = {
    elapsed: parseFloat(elapsed),
    label,
    filesOpened,
    selfMb: Math.round(selfRss),
    childMb: Math.round(childRss),
    totalMb: Math.round(totalRss),
  };
  snapshots.push(snap);

  console.log(
    `  [${elapsed.padStart(6)}s] ${String(filesOpened).padStart(6)} files | ` +
    `total: ${String(snap.totalMb).padStart(5)} MB` +
    (childRss > 0 ? ` (self: ${snap.selfMb} MB + children: ${snap.childMb} MB)` : '')
  );
}

// Initialize
child.stdin.write(encode({
  jsonrpc: '2.0', id: ++msgId, method: 'initialize',
  params: {
    processId: process.pid,
    rootUri: `file://${resolve(REPO)}`,
    workspaceFolders: [{ uri: `file://${resolve(REPO)}`, name: 'repo' }],
    capabilities: {
      workspace: { workspaceFolders: true },
      textDocument: { publishDiagnostics: { relatedInformation: true } },
    },
  },
}));

setTimeout(() => {
  child.stdin.write(encode({ jsonrpc: '2.0', method: 'initialized', params: {} }));

  console.log('\n  Opening files...\n');
  snapshot('before', 0);

  let idx = 0;

  function openBatch() {
    const end = Math.min(idx + BATCH_SIZE, files.length);
    for (; idx < end; idx++) {
      try {
        const f = files[idx];
        const content = readFileSync(f, 'utf8');
        const lang = f.endsWith('.tsx') ? 'typescriptreact'
          : f.endsWith('.ts') ? 'typescript'
          : f.endsWith('.jsx') ? 'javascriptreact' : 'javascript';
        child.stdin.write(encode({
          jsonrpc: '2.0', method: 'textDocument/didOpen',
          params: { textDocument: { uri: `file://${f}`, languageId: lang, version: 1, text: content } },
        }));
      } catch {}
    }

    snapshot('opened', idx);

    if (idx < files.length) {
      setTimeout(openBatch, BATCH_DELAY);
    } else {
      console.log('\n  All files opened. Settling...\n');
      let t = 0;
      const settleInterval = Math.min(5000, SETTLE_MS / 4);
      const poll = setInterval(() => {
        t += settleInterval;
        snapshot('settle', idx);
        if (t >= SETTLE_MS) {
          clearInterval(poll);
          finish();
        }
      }, settleInterval);
    }
  }

  openBatch();
}, 1000);

function finish() {
  snapshot('FINAL', files.length);

  // --- Summary chart ---
  console.log('\n' + '='.repeat(80));
  console.log('  Memory Growth Chart (total RSS)');
  console.log('='.repeat(80));

  const maxTotal = Math.max(...snapshots.map(s => s.totalMb), 1);
  const barWidth = 50;
  const step = Math.max(1, Math.floor(snapshots.length / 20));

  for (let i = 0; i < snapshots.length; i += step) {
    const s = snapshots[i];
    const len = Math.max(0, Math.round((s.totalMb / maxTotal) * barWidth));
    const bar = '\u2588'.repeat(len) + '\u2591'.repeat(barWidth - len);
    console.log(`  ${String(s.filesOpened).padStart(6)} files ${bar} ${s.totalMb} MB`);
  }
  const last = snapshots[snapshots.length - 1];
  if (snapshots.length % step !== 1) {
    const len = Math.max(0, Math.round((last.totalMb / maxTotal) * barWidth));
    const bar = '\u2588'.repeat(len) + '\u2591'.repeat(barWidth - len);
    console.log(`  ${String(last.filesOpened).padStart(6)} files ${bar} ${last.totalMb} MB`);
  }

  // --- Save JSON ---
  mkdirSync(RESULTS_DIR, { recursive: true });
  const output = {
    meta: {
      oxlintVersion,
      binary: oxlintBin || 'npx oxlint',
      repo: REPO,
      totalFiles: files.length,
      batchSize: BATCH_SIZE,
      settleMs: SETTLE_MS,
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      date: new Date().toISOString(),
    },
    snapshots,
  };
  writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${OUTPUT}`);

  child.stdin.write(encode({ jsonrpc: '2.0', id: ++msgId, method: 'shutdown', params: null }));
  setTimeout(() => { child.kill(); process.exit(0); }, 1000);
}

// Safety timeout
setTimeout(() => { child.kill(); process.exit(1); }, 600_000);
