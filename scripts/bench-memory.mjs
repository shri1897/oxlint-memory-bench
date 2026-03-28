#!/usr/bin/env node

/**
 * Benchmarks oxlint memory usage with and without jsPlugins.
 *
 * Usage:
 *   node scripts/bench-memory.mjs [lib-counts]
 *
 * Examples:
 *   node scripts/bench-memory.mjs              # Default: 50,100,200,500
 *   node scripts/bench-memory.mjs 100,500,1000 # Custom counts
 *
 * Requires: oxlint installed (npm install)
 */

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OXLINTRC = join(ROOT, '.oxlintrc.json');
const LIBS_DIR = join(ROOT, 'libs');
const GENERATE_SCRIPT = join(ROOT, 'scripts', 'generate-libs.mjs');

const LIB_COUNTS = (process.argv[2] || '50,100,200,500')
  .split(',')
  .map((s) => parseInt(s.trim(), 10));

const configs = {
  'no-jsplugins': {
    plugins: ['typescript', 'react', 'import'],
    categories: { correctness: 'off' },
    rules: { 'no-unused-vars': 'warn' },
  },
  'with-jsplugin': JSON.parse(readFileSync(OXLINTRC, 'utf8')),
};

function getOxlintBin() {
  try {
    return execSync('npx which oxlint', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'npx oxlint';
  }
}

function measureMemory(configName, config, libCount) {
  // Write config
  writeFileSync(OXLINTRC, JSON.stringify(config, null, 2));

  // Run oxlint and measure peak RSS via /usr/bin/time
  const cmd = `npx oxlint --config ${OXLINTRC} ./libs/`;
  try {
    // macOS: /usr/bin/time -l gives peak RSS in bytes
    const result = execSync(`/usr/bin/time -l ${cmd} 2>&1 || true`, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300_000,
    });

    // Extract peak memory from /usr/bin/time output
    const rssMatch = result.match(/(\d+)\s+maximum resident set size/);
    const peakRssBytes = rssMatch ? parseInt(rssMatch[1], 10) : 0;
    const peakRssMb = (peakRssBytes / 1024 / 1024).toFixed(1);

    // Extract timing
    const realMatch = result.match(/([\d.]+)\s+real/);
    const realTime = realMatch ? parseFloat(realMatch[1]).toFixed(2) : '?';

    return { peakRssMb, realTime };
  } catch (err) {
    return { peakRssMb: 'error', realTime: 'error' };
  }
}

console.log('='.repeat(70));
console.log('oxlint jsPlugins Memory Scaling Benchmark');
console.log('='.repeat(70));
console.log();

const results = [];

for (const count of LIB_COUNTS) {
  console.log(`\n--- Generating ${count} libs (${count * 10} files) ---`);

  // Clean and regenerate
  if (existsSync(LIBS_DIR)) {
    rmSync(LIBS_DIR, { recursive: true });
  }
  execSync(`node ${GENERATE_SCRIPT} ${count} 10`, {
    cwd: ROOT,
    stdio: 'inherit',
  });

  for (const [configName, config] of Object.entries(configs)) {
    process.stdout.write(`  ${configName} (${count} libs)... `);
    const { peakRssMb, realTime } = measureMemory(configName, config, count);
    console.log(`${peakRssMb} MB peak RSS, ${realTime}s`);
    results.push({ libs: count, files: count * 10, config: configName, peakRssMb, realTime });
  }
}

// Print summary table
console.log('\n' + '='.repeat(70));
console.log('Summary');
console.log('='.repeat(70));
console.log(
  'Libs'.padEnd(8) +
  'Files'.padEnd(8) +
  'Config'.padEnd(20) +
  'Peak RSS (MB)'.padEnd(16) +
  'Time (s)'
);
console.log('-'.repeat(70));
for (const r of results) {
  console.log(
    String(r.libs).padEnd(8) +
    String(r.files).padEnd(8) +
    r.config.padEnd(20) +
    String(r.peakRssMb).padEnd(16) +
    r.realTime
  );
}

// Restore original config
writeFileSync(OXLINTRC, JSON.stringify(configs['with-jsplugin'], null, 2));

console.log('\nDone! Original .oxlintrc.json restored.');
