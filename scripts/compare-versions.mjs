#!/usr/bin/env node

/**
 * Compares benchmark results across oxlint versions.
 *
 * Usage:
 *   node scripts/compare-versions.mjs [options]
 *
 * Options:
 *   --versions 1.43.0,1.55.0,latest   Versions to compare (required)
 *   --mode cli|lsp                     Benchmark mode (default: cli)
 *   --libs 100,500,1000               Lib counts (default: 100,500,1000)
 *   --files-per-lib 10                Files per lib (default: 10)
 *   --runs 3                          Runs per config for CLI mode (default: 3)
 *
 * Examples:
 *   node scripts/compare-versions.mjs --versions 1.43.0,1.55.0,latest
 *   node scripts/compare-versions.mjs --versions 1.43.0,latest --mode lsp --libs 100,500
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const RESULTS_DIR = join(ROOT, 'results');

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const VERSIONS = getArg('versions', '').split(',').filter(Boolean);
const MODE = getArg('mode', 'cli');
const LIBS = getArg('libs', '100,500,1000');
const FILES_PER_LIB = getArg('files-per-lib', '10');
const RUNS = getArg('runs', '3');

if (VERSIONS.length === 0) {
  console.error('Error: --versions is required (e.g., --versions 1.43.0,1.55.0,latest)');
  process.exit(1);
}

mkdirSync(RESULTS_DIR, { recursive: true });

console.log('='.repeat(75));
console.log(`  oxlint Version Comparison (${MODE} mode)`);
console.log(`  Versions: ${VERSIONS.join(', ')}`);
console.log(`  Libs: ${LIBS} | Files/lib: ${FILES_PER_LIB}`);
console.log('='.repeat(75));

// --- Run benchmarks ---
const resultFiles = [];

for (const version of VERSIONS) {
  console.log(`\n${'─'.repeat(75)}`);
  console.log(`  Running benchmark for oxlint@${version}...`);
  console.log('─'.repeat(75));

  const script = MODE === 'lsp' ? 'scripts/bench-lsp.mjs' : 'scripts/bench.mjs';
  const extraArgs = MODE === 'cli' ? `--runs ${RUNS}` : '';

  execSync(
    `node ${script} --version ${version} --libs ${LIBS} --files-per-lib ${FILES_PER_LIB} ${extraArgs}`,
    { cwd: ROOT, stdio: 'inherit', timeout: 1200_000 }
  );
}

// --- Load and compare results ---
console.log('\n' + '='.repeat(75));
console.log('  Cross-Version Comparison');
console.log('='.repeat(75));

const allResults = [];
for (const file of readdirSync(RESULTS_DIR)) {
  if (file.endsWith(`.json`) && file.includes(MODE)) {
    const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8'));
    allResults.push(data);
  }
}

if (allResults.length < 2) {
  console.log('\n  Need at least 2 result files to compare. Run more versions.');
  process.exit(0);
}

// Group by lib count
const libCounts = [...new Set(allResults.flatMap(r => r.results.map(x => x.libs)))].sort((a, b) => a - b);

for (const libs of libCounts) {
  const files = libs * parseInt(FILES_PER_LIB);
  console.log(`\n  ${libs} libs (${files.toLocaleString()} files):`);
  console.log('  ' + 'Version'.padEnd(16) + 'native-only'.padEnd(16) + 'with-jsplugin'.padEnd(16) + 'Overhead');
  console.log('  ' + '-'.repeat(60));

  for (const data of allResults) {
    const version = data.meta.oxlintVersion;
    const native = data.results.find(r => r.libs === libs && r.config === 'native-only');
    const plugin = data.results.find(r => r.libs === libs && r.config === 'with-jsplugin');

    if (native && plugin) {
      const overhead = plugin.peakRssMb - native.peakRssMb;
      console.log(
        '  ' + version.padEnd(16) +
        `${native.peakRssMb.toFixed(1)} MB`.padEnd(16) +
        `${plugin.peakRssMb.toFixed(1)} MB`.padEnd(16) +
        `+${overhead.toFixed(1)} MB`
      );
    }
  }
}

console.log('\n  Results are in ./results/');
