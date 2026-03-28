#!/usr/bin/env node

/**
 * Benchmarks oxlint LSP server memory usage (simulates the VS Code extension).
 *
 * Starts `oxlint --lsp`, sends initialize + didOpen for files, then measures
 * the node process memory via `ps`. This is what the VS Code extension does.
 *
 * Usage:
 *   node scripts/bench-lsp.mjs [options]
 *
 * Options:
 *   --libs 50,100,200,500      Lib counts to test (default: 50,100,200,500)
 *   --files-per-lib 10         Files per lib (default: 10)
 *   --version 1.55.0           oxlint version to test (default: installed)
 *   --settle-ms 5000           Wait time after last file opened (default: 5000)
 *   --output path              Save JSON results (default: results/<version>-lsp.json)
 *
 * Examples:
 *   node scripts/bench-lsp.mjs
 *   node scripts/bench-lsp.mjs --version 1.55.0 --libs 100,500
 */

import { execSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const RESULTS_DIR = join(ROOT, 'results');

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const LIB_COUNTS = getArg('libs', '50,100,200,500').split(',').map(Number);
const FILES_PER_LIB = parseInt(getArg('files-per-lib', '10'), 10);
const SETTLE_MS = parseInt(getArg('settle-ms', '5000'), 10);
const VERSION = getArg('version', null);

if (VERSION) {
  console.log(`Installing oxlint@${VERSION}...`);
  execSync(`npm install --no-save oxlint@${VERSION}`, { cwd: ROOT, stdio: 'pipe' });
}
const oxlintVersion = execSync('npx oxlint --version', { cwd: ROOT, encoding: 'utf8' }).trim().replace(/^(Version:\s*|oxlint\s*)/i, '');
console.log(`oxlint version: ${oxlintVersion}\n`);

const OUTPUT = getArg('output', join(RESULTS_DIR, `${oxlintVersion}-lsp.json`));

// --- Configs ---
const configNative = {
  $schema: './node_modules/oxlint/configuration_schema.json',
  plugins: ['typescript', 'react', 'import'],
  categories: { correctness: 'off' },
  rules: { 'no-unused-vars': 'warn' },
};

const configPlugin = {
  ...configNative,
  jsPlugins: [{ name: 'custom', specifier: './plugins/no-unused-imports.mjs' }],
  rules: { ...configNative.rules, 'custom/no-unused-imports': 'warn' },
};

// --- LSP helpers ---
function lspMessage(method, params, id) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
}

function collectTsxFiles(dir, max = 500) {
  const files = [];
  function walk(d) {
    if (files.length >= max) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (files.length >= max) return;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) files.push(full);
    }
  }
  walk(dir);
  return files;
}

function getRssMb(pid) {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim();
    return parseInt(out, 10) / 1024; // KB -> MB
  } catch {
    return -1;
  }
}

async function measureLsp(config, libCount) {
  const configPath = join(ROOT, '.oxlintrc.bench.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const libsDir = join(ROOT, 'libs');
  const tsxFiles = collectTsxFiles(libsDir, libCount * FILES_PER_LIB);

  return new Promise((resolvePromise) => {
    const child = spawn('npx', ['oxlint', '--lsp'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OXLINTRC: configPath },
    });

    const pid = child.pid;
    let settled = false;

    // Send initialize
    child.stdin.write(lspMessage('initialize', {
      processId: process.pid,
      rootUri: `file://${resolve(ROOT)}`,
      capabilities: {},
    }, 1));

    // Send initialized
    setTimeout(() => {
      child.stdin.write(lspMessage('initialized', {}, null));

      // Open files in batches to simulate extension behavior
      let fileIdx = 0;
      const batchSize = 50;

      function openBatch() {
        const end = Math.min(fileIdx + batchSize, tsxFiles.length);
        for (; fileIdx < end; fileIdx++) {
          const filePath = tsxFiles[fileIdx];
          const content = readFileSync(filePath, 'utf8');
          child.stdin.write(lspMessage('textDocument/didOpen', {
            textDocument: {
              uri: `file://${filePath}`,
              languageId: 'typescriptreact',
              version: 1,
              text: content,
            },
          }, null));
        }

        if (fileIdx < tsxFiles.length) {
          setTimeout(openBatch, 100);
        } else {
          // All files opened, wait for processing to settle
          setTimeout(() => {
            settled = true;
            const finalRss = getRssMb(pid);

            // Shutdown
            child.stdin.write(lspMessage('shutdown', null, 99));
            setTimeout(() => {
              child.stdin.write(lspMessage('exit', null, null));
              child.kill();
              resolvePromise({ peakRssMb: finalRss, filesOpened: tsxFiles.length });
            }, 500);
          }, SETTLE_MS);
        }
      }

      openBatch();
    }, 1000);

    // Track peak memory while running
    let peakRss = 0;
    const memInterval = setInterval(() => {
      const rss = getRssMb(pid);
      if (rss > peakRss) peakRss = rss;
    }, 500);

    child.on('close', () => {
      clearInterval(memInterval);
      if (!settled) {
        resolvePromise({ peakRssMb: peakRss, filesOpened: tsxFiles.length });
      }
    });

    // Timeout safety
    setTimeout(() => {
      if (!settled) {
        child.kill();
        resolvePromise({ peakRssMb: peakRss, filesOpened: tsxFiles.length });
      }
    }, 120_000);
  });
}

// --- Run ---
mkdirSync(RESULTS_DIR, { recursive: true });
const results = [];

console.log('='.repeat(75));
console.log(`  oxlint jsPlugins Memory Benchmark (LSP mode)`);
console.log(`  Version: ${oxlintVersion} | Settle: ${SETTLE_MS}ms | Files/lib: ${FILES_PER_LIB}`);
console.log('='.repeat(75));

for (const libCount of LIB_COUNTS) {
  const totalFiles = libCount * FILES_PER_LIB;
  console.log(`\n  Generating ${libCount} libs (${totalFiles.toLocaleString()} files)...`);
  execSync(`node scripts/generate-libs.mjs ${libCount} ${FILES_PER_LIB}`, {
    cwd: ROOT, stdio: 'pipe',
  });

  for (const [configName, config] of [['native-only', configNative], ['with-jsplugin', configPlugin]]) {
    process.stdout.write(`    ${configName}...`);
    const { peakRssMb, filesOpened } = await measureLsp(config, libCount);
    console.log(` ${peakRssMb.toFixed(1)} MB (${filesOpened} files opened)`);
    results.push({ libs: libCount, files: totalFiles, config: configName, peakRssMb: Math.round(peakRssMb * 10) / 10 });
  }
}

// --- Table ---
console.log('\n' + '='.repeat(75));
console.log('  Results (RSS after settle)');
console.log('='.repeat(75));
console.log(
  '  ' + 'Libs'.padEnd(8) + 'Files'.padEnd(10) +
  'native-only'.padEnd(16) + 'with-jsplugin'.padEnd(16) + 'Overhead'
);
console.log('  ' + '-'.repeat(65));

const grouped = {};
for (const r of results) {
  if (!grouped[r.libs]) grouped[r.libs] = {};
  grouped[r.libs][r.config] = r.peakRssMb;
}

for (const [libs, data] of Object.entries(grouped)) {
  const native = data['native-only'] || 0;
  const withPlugin = data['with-jsplugin'] || 0;
  const overhead = withPlugin - native;
  const ratio = native > 0 ? (withPlugin / native).toFixed(1) : '?';
  console.log(
    '  ' + String(libs).padEnd(8) +
    String((parseInt(libs) * FILES_PER_LIB).toLocaleString()).padEnd(10) +
    `${native.toFixed(1)} MB`.padEnd(16) +
    `${withPlugin.toFixed(1)} MB`.padEnd(16) +
    `+${overhead.toFixed(1)} MB (${ratio}x)`
  );
}

// --- Chart ---
console.log('\n' + '='.repeat(75));
console.log('  Memory Scaling Chart');
console.log('='.repeat(75));

const maxMb = Math.max(...results.map(r => r.peakRssMb));
const barWidth = 45;

for (const [libs, data] of Object.entries(grouped)) {
  console.log(`\n  ${libs} libs (${(parseInt(libs) * FILES_PER_LIB).toLocaleString()} files):`);
  for (const [config, mb] of Object.entries(data)) {
    const len = Math.round((mb / maxMb) * barWidth);
    const bar = '\u2588'.repeat(len) + '\u2591'.repeat(barWidth - len);
    const label = config === 'native-only' ? 'native ' : 'jsplugin';
    console.log(`    ${label} ${bar} ${mb.toFixed(1)} MB`);
  }
}

// --- Save ---
const output = {
  meta: {
    oxlintVersion, mode: 'lsp', nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    date: new Date().toISOString(), filesPerLib: FILES_PER_LIB, settleMs: SETTLE_MS,
  },
  results,
};
writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(`\nResults saved to ${OUTPUT}`);
