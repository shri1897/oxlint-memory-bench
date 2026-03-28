#!/usr/bin/env node

/**
 * Benchmarks oxlint LSP server memory usage — replicates the VS Code extension behavior.
 *
 * The oxlint VS Code extension runs `oxlint --lsp` and communicates over stdio.
 * The LSP server discovers and lints all workspace files automatically after
 * receiving initialize/initialized. This script replicates that exact flow.
 *
 * Usage:
 *   node scripts/bench-lsp.mjs [options]
 *
 * Options:
 *   --libs 50,100,200,500,1000   Lib counts to test (default: 50,100,200,500,1000)
 *   --files-per-lib 10           Files per lib (default: 10)
 *   --version 1.55.0             oxlint version to test (default: installed)
 *   --settle-ms 10000            Wait time after initialized for server to lint (default: 10000)
 *   --sample-interval 500        Memory sampling interval in ms (default: 500)
 *   --output path                Save JSON results (default: results/<version>-lsp.json)
 *
 * Examples:
 *   node scripts/bench-lsp.mjs
 *   node scripts/bench-lsp.mjs --version 1.55.0 --libs 100,500
 *   node scripts/bench-lsp.mjs --settle-ms 20000 --libs 1000,2000
 */

import { execSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const RESULTS_DIR = join(ROOT, 'results');

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const LIB_COUNTS = getArg('libs', '50,100,200,500,1000').split(',').map(Number);
const FILES_PER_LIB = parseInt(getArg('files-per-lib', '10'), 10);
const SETTLE_MS = parseInt(getArg('settle-ms', '10000'), 10);
const SAMPLE_INTERVAL = parseInt(getArg('sample-interval', '500'), 10);
const VERSION = getArg('version', null);

// --- Resolve oxlint ---
if (VERSION) {
  console.log(`Installing oxlint@${VERSION}...`);
  execSync(`npm install --no-save oxlint@${VERSION}`, { cwd: ROOT, stdio: 'pipe' });
}

const oxlintVersion = execSync('npx oxlint --version', { cwd: ROOT, encoding: 'utf8' })
  .trim().replace(/^(Version:\s*|oxlint\s*)/i, '');
console.log(`oxlint version: ${oxlintVersion}`);

const OUTPUT = getArg('output', join(RESULTS_DIR, `${oxlintVersion}-lsp.json`));

// --- Resolve oxlint binary path (same as the extension does) ---
function resolveOxlintBin() {
  try {
    return execSync('npx which oxlint', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    // Fallback: find it in node_modules
    const binPath = join(ROOT, 'node_modules', '.bin', 'oxlint');
    if (existsSync(binPath)) return binPath;
    return 'npx oxlint';
  }
}

const oxlintBin = resolveOxlintBin();

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

// --- LSP message helpers ---
let msgId = 0;

function encode(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function request(method, params) {
  return encode({ jsonrpc: '2.0', id: ++msgId, method, params });
}

function notification(method, params) {
  return encode({ jsonrpc: '2.0', method, params });
}

// --- Memory measurement ---
function getRssMb(pid) {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim();
    return parseInt(out, 10) / 1024; // KB -> MB
  } catch {
    return -1;
  }
}

// Find the node child process spawned by oxlint for jsPlugins
function findNodeChildPid(parentPid) {
  try {
    const out = execSync(`pgrep -P ${parentPid}`, { encoding: 'utf8' }).trim();
    const childPids = out.split('\n').map(Number).filter(Boolean);
    for (const cpid of childPids) {
      const cmd = execSync(`ps -o command= -p ${cpid}`, { encoding: 'utf8' }).trim();
      if (cmd.includes('node')) return cpid;
    }
    return null;
  } catch {
    return null;
  }
}

// Get total RSS: oxlint process + its node child (if any)
function getProcessTreeRss(oxlintPid) {
  const oxlintRss = getRssMb(oxlintPid);
  const nodeChildPid = findNodeChildPid(oxlintPid);
  const nodeRss = nodeChildPid ? getRssMb(nodeChildPid) : 0;
  return { oxlintRss, nodeRss, totalRss: oxlintRss + nodeRss, nodeChildPid };
}

// --- Collect workspace files ---
function collectFiles(dir, exts = ['.ts', '.tsx', '.js', '.jsx']) {
  const files = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(full);
      else if (exts.some(ext => entry.name.endsWith(ext))) files.push(full);
    }
  }
  walk(dir);
  return files;
}

// --- Run LSP server and measure memory ---
async function measureLsp(config, libCount) {
  // Write config to the project root (where the LSP server will find it)
  writeFileSync(join(ROOT, '.oxlintrc.json'), JSON.stringify(config, null, 2));

  const rootPath = resolve(ROOT);
  const allFiles = collectFiles(join(ROOT, 'libs'));

  return new Promise((done) => {
    // Start LSP server — exactly how the extension does it
    const child = spawn(oxlintBin, ['--lsp'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pid = child.pid;
    const memorySamples = [];
    let peakTotal = 0;
    let peakNode = 0;
    let peakOxlint = 0;
    let filesOpened = 0;

    // Sample memory at regular intervals — track both oxlint and its node child
    const sampler = setInterval(() => {
      const { oxlintRss, nodeRss, totalRss } = getProcessTreeRss(pid);
      if (totalRss > 0) {
        memorySamples.push({ timeMs: Date.now() - startTime, oxlintMb: oxlintRss, nodeMb: nodeRss, totalMb: totalRss, filesOpened });
        if (totalRss > peakTotal) peakTotal = totalRss;
        if (nodeRss > peakNode) peakNode = nodeRss;
        if (oxlintRss > peakOxlint) peakOxlint = oxlintRss;
      }
    }, SAMPLE_INTERVAL);

    const startTime = Date.now();

    // Handle stdin errors gracefully (server may close pipe)
    child.stdin.on('error', () => {});

    // Step 1: Send initialize (same as extension)
    child.stdin.write(request('initialize', {
      processId: process.pid,
      rootUri: `file://${rootPath}`,
      rootPath,
      workspaceFolders: [{ uri: `file://${rootPath}`, name: 'oxlint-memory-bench' }],
      capabilities: {
        workspace: {
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'source.fixAll'] } } },
        },
      },
    }));

    // Step 2: Send initialized, then open all files (simulating VS Code file watcher)
    setTimeout(() => {
      child.stdin.write(notification('initialized', {}));

      // Open files in batches — VS Code discovers and opens files as the workspace indexes
      let idx = 0;
      const BATCH = 100;

      function openBatch() {
        const end = Math.min(idx + BATCH, allFiles.length);
        for (; idx < end; idx++) {
          try {
            const filePath = allFiles[idx];
            const content = readFileSync(filePath, 'utf8');
            const lang = filePath.endsWith('.tsx') ? 'typescriptreact'
              : filePath.endsWith('.ts') ? 'typescript'
              : filePath.endsWith('.jsx') ? 'javascriptreact' : 'javascript';

            child.stdin.write(notification('textDocument/didOpen', {
              textDocument: {
                uri: `file://${filePath}`,
                languageId: lang,
                version: 1,
                text: content,
              },
            }));
            filesOpened++;
          } catch {
            // Skip files that can't be read
          }
        }

        if (idx < allFiles.length) {
          // Small delay between batches to let the server process
          setTimeout(openBatch, 50);
        } else {
          // All files opened — wait for server to finish processing
          setTimeout(finalize, SETTLE_MS);
        }
      }

      openBatch();
    }, 1000);

    function finalize() {
      const final = getProcessTreeRss(pid);
      if (final.totalRss > peakTotal) peakTotal = final.totalRss;
      if (final.nodeRss > peakNode) peakNode = final.nodeRss;
      clearInterval(sampler);

      // Shutdown gracefully
      child.stdin.write(request('shutdown', null));
      setTimeout(() => {
        child.stdin.write(notification('exit', null));
        setTimeout(() => child.kill(), 500);
      }, 500);

      done({ peakTotalMb: peakTotal, peakOxlintMb: peakOxlint, peakNodeMb: peakNode, finalTotalMb: final.totalRss, finalNodeMb: final.nodeRss, filesOpened, memorySamples });
    }

    // Handle early exit
    child.on('close', () => {
      clearInterval(sampler);
      done({ peakTotalMb: peakTotal, peakOxlintMb: peakOxlint, peakNodeMb: peakNode, finalTotalMb: peakTotal, finalNodeMb: peakNode, filesOpened, memorySamples });
    });

    // Safety timeout
    setTimeout(() => {
      clearInterval(sampler);
      child.kill();
      done({ peakTotalMb: peakTotal, peakOxlintMb: peakOxlint, peakNodeMb: peakNode, finalTotalMb: peakTotal, finalNodeMb: peakNode, filesOpened, memorySamples });
    }, SETTLE_MS + 120_000);
  });
}

// --- Run benchmarks ---
mkdirSync(RESULTS_DIR, { recursive: true });
const results = [];

console.log('\n' + '='.repeat(75));
console.log(`  oxlint jsPlugins Memory Benchmark (LSP server mode)`);
console.log(`  Version: ${oxlintVersion} | Settle: ${SETTLE_MS}ms | Files/lib: ${FILES_PER_LIB}`);
console.log(`  Binary: ${oxlintBin}`);
console.log('='.repeat(75));

for (const libCount of LIB_COUNTS) {
  const totalFiles = libCount * FILES_PER_LIB;
  console.log(`\n  Generating ${libCount} libs (${totalFiles.toLocaleString()} files)...`);
  execSync(`node scripts/generate-libs.mjs ${libCount} ${FILES_PER_LIB}`, { cwd: ROOT, stdio: 'pipe' });

  for (const [configName, config] of [['native-only', configNative], ['with-jsplugin', configPlugin]]) {
    process.stdout.write(`    ${configName}... `);
    const r = await measureLsp(config, libCount);
    console.log(`oxlint: ${r.peakOxlintMb.toFixed(1)} MB | node: ${r.peakNodeMb.toFixed(1)} MB | total: ${r.peakTotalMb.toFixed(1)} MB (${r.filesOpened} files)`);

    results.push({
      libs: libCount,
      files: totalFiles,
      config: configName,
      peakTotalMb: Math.round(r.peakTotalMb * 10) / 10,
      peakOxlintMb: Math.round(r.peakOxlintMb * 10) / 10,
      peakNodeMb: Math.round(r.peakNodeMb * 10) / 10,
      filesOpened: r.filesOpened,
      samples: r.memorySamples.length,
    });
  }
}

// --- Table ---
console.log('\n' + '='.repeat(85));
console.log('  Results (peak RSS)');
console.log('='.repeat(85));
console.log(
  '  ' + 'Libs'.padEnd(7) + 'Files'.padEnd(9) + 'Config'.padEnd(16) +
  'oxlint (Rust)'.padEnd(16) + 'node (JS)'.padEnd(14) + 'Total'
);
console.log('  ' + '-'.repeat(78));

const grouped = {};
for (const r of results) {
  if (!grouped[r.libs]) grouped[r.libs] = {};
  grouped[r.libs][r.config] = r;
}

for (const [libs, data] of Object.entries(grouped)) {
  const files = parseInt(libs) * FILES_PER_LIB;
  for (const [config, r] of Object.entries(data)) {
    console.log(
      '  ' + String(libs).padEnd(7) +
      String(files.toLocaleString()).padEnd(9) +
      config.padEnd(16) +
      `${r.peakOxlintMb.toFixed(1)} MB`.padEnd(16) +
      `${r.peakNodeMb.toFixed(1)} MB`.padEnd(14) +
      `${r.peakTotalMb.toFixed(1)} MB`
    );
  }
  // Show overhead
  const native = data['native-only'];
  const plugin = data['with-jsplugin'];
  if (native && plugin) {
    const nodeOverhead = plugin.peakNodeMb - native.peakNodeMb;
    const totalOverhead = plugin.peakTotalMb - native.peakTotalMb;
    console.log(
      '  ' + ''.padEnd(7) + ''.padEnd(9) +
      'overhead'.padEnd(16) +
      `+${(plugin.peakOxlintMb - native.peakOxlintMb).toFixed(1)} MB`.padEnd(16) +
      `+${nodeOverhead.toFixed(1)} MB`.padEnd(14) +
      `+${totalOverhead.toFixed(1)} MB`
    );
  }
  console.log('  ' + '-'.repeat(78));
}

// --- Chart: node subprocess memory ---
console.log('\n' + '='.repeat(85));
console.log('  Node.js Subprocess Memory (this is what consumes 1.7 GB in production)');
console.log('='.repeat(85));

const maxNode = Math.max(...results.map(r => r.peakNodeMb), 1);
const maxTotal = Math.max(...results.map(r => r.peakTotalMb), 1);
const barWidth = 50;

for (const [libs, data] of Object.entries(grouped)) {
  console.log(`\n  ${libs} libs (${(parseInt(libs) * FILES_PER_LIB).toLocaleString()} files):`);
  for (const [config, r] of Object.entries(data)) {
    const label = config === 'native-only' ? 'native ' : 'jsplugin';
    if (r.peakNodeMb > 0) {
      const len = Math.max(1, Math.round((r.peakNodeMb / maxTotal) * barWidth));
      const bar = '\u2588'.repeat(len) + '\u2591'.repeat(barWidth - len);
      console.log(`    ${label} node  ${bar} ${r.peakNodeMb.toFixed(1)} MB`);
    } else {
      console.log(`    ${label} node  ${'░'.repeat(barWidth)} 0 MB (no node subprocess)`);
    }
    const lenT = Math.max(1, Math.round((r.peakTotalMb / maxTotal) * barWidth));
    const barT = '\u2588'.repeat(lenT) + '\u2591'.repeat(barWidth - lenT);
    console.log(`    ${label} total ${barT} ${r.peakTotalMb.toFixed(1)} MB`);
  }
}

// --- Save ---
const output = {
  meta: {
    oxlintVersion,
    mode: 'lsp',
    binary: oxlintBin,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    date: new Date().toISOString(),
    filesPerLib: FILES_PER_LIB,
    settleMs: SETTLE_MS,
    sampleIntervalMs: SAMPLE_INTERVAL,
  },
  results,
};
writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(`\nResults saved to ${OUTPUT}`);

// Restore default config
writeFileSync(join(ROOT, '.oxlintrc.json'), JSON.stringify(configPlugin, null, 2));
