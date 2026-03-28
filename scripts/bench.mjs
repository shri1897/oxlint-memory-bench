#!/usr/bin/env node

/**
 * Benchmarks oxlint CLI memory usage with and without jsPlugins
 * across different workspace sizes.
 *
 * Usage:
 *   node scripts/bench.mjs [options]
 *
 * Options:
 *   --libs 50,100,200,500,1000    Lib counts to test (default: 50,100,200,500,1000)
 *   --files-per-lib 10            Files per lib (default: 10)
 *   --version 1.55.0              oxlint version to test (default: installed)
 *   --output results/bench.json   Save JSON results (default: results/<version>-cli.json)
 *   --runs 3                      Number of runs per config (default: 3, takes median)
 *
 * Examples:
 *   node scripts/bench.mjs
 *   node scripts/bench.mjs --version 1.55.0 --libs 100,500,1000
 *   node scripts/bench.mjs --version 1.43.0 --runs 1
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
const RUNS = parseInt(getArg('runs', '3'), 10);
const VERSION = getArg('version', null);

// --- Resolve oxlint binary ---
function resolveOxlint() {
  if (VERSION) {
    // Install specific version to a temp location
    console.log(`Installing oxlint@${VERSION}...`);
    execSync(`npm install --no-save oxlint@${VERSION}`, { cwd: ROOT, stdio: 'pipe' });
  }
  const raw = execSync('npx oxlint --version', { cwd: ROOT, encoding: 'utf8' }).trim();
  // Strip "Version: " or "oxlint " prefix if present
  return raw.replace(/^(Version:\s*|oxlint\s*)/i, '');
}

const oxlintVersion = resolveOxlint();
console.log(`oxlint version: ${oxlintVersion}\n`);

const OUTPUT = getArg('output', join(RESULTS_DIR, `${oxlintVersion}-cli.json`));

// --- Configs to test ---
const configs = {
  'native-only': {
    $schema: './node_modules/oxlint/configuration_schema.json',
    plugins: ['typescript', 'react', 'import'],
    categories: { correctness: 'off' },
    rules: { 'no-unused-vars': 'warn' },
  },
  'with-jsplugin': {
    $schema: './node_modules/oxlint/configuration_schema.json',
    plugins: ['typescript', 'react', 'import'],
    jsPlugins: [{ name: 'custom', specifier: './plugins/no-unused-imports.mjs' }],
    categories: { correctness: 'off' },
    rules: { 'custom/no-unused-imports': 'warn', 'no-unused-vars': 'warn' },
  },
};

// --- Measure memory ---
function measurePeakRss(config) {
  const configPath = join(ROOT, '.oxlintrc.bench.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const cmd = `npx oxlint --config .oxlintrc.bench.json ./libs/`;
  const platform = process.platform;

  try {
    let result;
    if (platform === 'darwin') {
      result = execSync(`/usr/bin/time -l ${cmd} 2>&1 || true`, {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 600_000,
      });
      const m = result.match(/(\d+)\s+maximum resident set size/);
      return m ? parseInt(m[1], 10) / 1024 / 1024 : 0; // bytes -> MB
    } else {
      // Linux: /usr/bin/time -v gives RSS in KB
      result = execSync(`/usr/bin/time -v ${cmd} 2>&1 || true`, {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 600_000,
      });
      const m = result.match(/Maximum resident set size.*?:\s*(\d+)/);
      return m ? parseInt(m[1], 10) / 1024 : 0; // KB -> MB
    }
  } catch {
    return -1;
  }
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- Run benchmark ---
mkdirSync(RESULTS_DIR, { recursive: true });

const results = [];

console.log('='.repeat(75));
console.log(`  oxlint jsPlugins Memory Benchmark (CLI mode)`);
console.log(`  Version: ${oxlintVersion} | Runs per config: ${RUNS} | Files/lib: ${FILES_PER_LIB}`);
console.log('='.repeat(75));

for (const libCount of LIB_COUNTS) {
  const totalFiles = libCount * FILES_PER_LIB;
  console.log(`\n  Generating ${libCount} libs (${totalFiles.toLocaleString()} files)...`);

  execSync(`node scripts/generate-libs.mjs ${libCount} ${FILES_PER_LIB}`, {
    cwd: ROOT, stdio: 'pipe',
  });

  for (const [configName, config] of Object.entries(configs)) {
    const measurements = [];
    for (let run = 0; run < RUNS; run++) {
      process.stdout.write(`    ${configName} run ${run + 1}/${RUNS}...`);
      const mb = measurePeakRss(config);
      measurements.push(mb);
      process.stdout.write(` ${mb.toFixed(1)} MB\n`);
    }

    const peakMb = median(measurements);
    results.push({
      libs: libCount,
      files: totalFiles,
      config: configName,
      peakRssMb: Math.round(peakMb * 10) / 10,
      allRuns: measurements.map(m => Math.round(m * 10) / 10),
    });
  }
}

// --- Print results table ---
console.log('\n' + '='.repeat(75));
console.log('  Results (median peak RSS)');
console.log('='.repeat(75));
console.log(
  '  ' +
  'Libs'.padEnd(8) +
  'Files'.padEnd(10) +
  'native-only'.padEnd(16) +
  'with-jsplugin'.padEnd(16) +
  'Overhead'
);
console.log('  ' + '-'.repeat(65));

// Group by lib count
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
  const files = parseInt(libs) * FILES_PER_LIB;

  console.log(
    '  ' +
    String(libs).padEnd(8) +
    String(files.toLocaleString()).padEnd(10) +
    `${native.toFixed(1)} MB`.padEnd(16) +
    `${withPlugin.toFixed(1)} MB`.padEnd(16) +
    `+${overhead.toFixed(1)} MB (${ratio}x)`
  );
}

// --- ASCII bar chart ---
console.log('\n' + '='.repeat(75));
console.log('  Memory Scaling Chart');
console.log('='.repeat(75));

const maxMb = Math.max(...results.map(r => r.peakRssMb));
const barWidth = 45;

for (const [libs, data] of Object.entries(grouped)) {
  const files = parseInt(libs) * FILES_PER_LIB;
  console.log(`\n  ${libs} libs (${files.toLocaleString()} files):`);

  for (const [config, mb] of Object.entries(data)) {
    const len = Math.round((mb / maxMb) * barWidth);
    const bar = '\u2588'.repeat(len) + '\u2591'.repeat(barWidth - len);
    const label = config === 'native-only' ? 'native ' : 'jsplugin';
    console.log(`    ${label} ${bar} ${mb.toFixed(1)} MB`);
  }
}

// --- Save JSON ---
const output = {
  meta: {
    oxlintVersion,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    date: new Date().toISOString(),
    filesPerLib: FILES_PER_LIB,
    runsPerConfig: RUNS,
  },
  results,
};

writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
console.log(`\nResults saved to ${OUTPUT}`);
