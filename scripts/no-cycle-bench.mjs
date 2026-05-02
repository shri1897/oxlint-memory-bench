#!/usr/bin/env node

/**
 * One-shot reproducer + benchmark for the oxlint 1.57+ `import/no-cycle`
 * performance regression (PR oxc-project/oxc#20566).
 *
 * Workflow:
 *   1. Generate a synthetic Nx-shaped monorepo fixture (deterministic,
 *      zero real source code).
 *   2. Install requested oxlint versions from npm OR use a user-supplied
 *      binary (e.g. a local fix you built from the oxc source tree).
 *   3. Run each target N times, report wall-clock + user CPU + finding counts.
 *
 * Usage:
 *   node scripts/no-cycle-bench.mjs                   # defaults: 1.56, 1.57, 1.62
 *   node scripts/no-cycle-bench.mjs --version 1.58.0 --version 1.61.0
 *   node scripts/no-cycle-bench.mjs --bin /path/to/oxlint
 *   node scripts/no-cycle-bench.mjs --version 1.56.0 --bin /path/to/patched/oxlint
 *   node scripts/no-cycle-bench.mjs --libs 50 --files 100 --runs 5
 *
 * Flags:
 *   --version <x>   oxlint npm version to bench (repeatable)
 *   --bin <path>    path to an oxlint binary (repeatable; label = basename)
 *   --libs <n>      number of synthetic libs (default 150)
 *   --files <n>     source files per lib (default 250)
 *   --runs <n>      runs per target (default 3)
 *   --reuse         skip regeneration if fixture already exists
 *   --only-generate generate fixture, print summary, exit
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ─── CLI parsing ────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const args = { versions: [], bins: [], libs: 150, files: 250, runs: 3, reuse: false, onlyGenerate: false };
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  switch (a) {
    case '--version': args.versions.push(rawArgs[++i]); break;
    case '--bin': args.bins.push(resolve(rawArgs[++i])); break;
    case '--libs': args.libs = parseInt(rawArgs[++i], 10); break;
    case '--files': args.files = parseInt(rawArgs[++i], 10); break;
    case '--runs': args.runs = parseInt(rawArgs[++i], 10); break;
    case '--reuse': args.reuse = true; break;
    case '--only-generate': args.onlyGenerate = true; break;
    case '--help': case '-h':
      console.log(`usage: node scripts/no-cycle-bench.mjs [flags]
  --version <x>     oxlint npm version (repeatable; default: 1.56.0, 1.57.0, 1.62.0)
  --bin <path>      oxlint binary path (repeatable)
  --libs <n>        libs to generate (default 150)
  --files <n>       source files per lib (default 250)
  --runs <n>        runs per target (default 3)
  --reuse           skip fixture regeneration
  --only-generate   generate fixture and exit`);
      process.exit(0);
    default:
      console.error(`unknown flag: ${a}`);
      process.exit(2);
  }
}
// Default npm versions are included whenever the caller didn't specify any
// --version flags AND didn't supply at least one --bin. This keeps a bare
// `--bin foo` invocation focused (just benchmark the binary), while the
// plain `node scripts/no-cycle-bench.mjs` run shows the full before/after.
if (args.versions.length === 0 && args.bins.length === 0) {
  args.versions = ['1.56.0', '1.57.0', '1.62.0'];
}

// ─── Fixture generation ─────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'nx-repro');

function generate({ libs, files }) {
  if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true });
  const libsDir = join(FIXTURE, 'libs');
  mkdirSync(libsDir, { recursive: true });

  const libName = (i) => `lib-${String(i).padStart(5, '0')}`;
  const aliasFor = (i) => `@repo/${libName(i)}`;
  const SUBPATHS = ['', '/features', '/utils', '/hooks', '/types', '/constants'];

  // tsconfig.base.json with ~6 aliases per lib (Nx-style).
  const paths = {};
  for (let i = 0; i < libs; i++) {
    for (const sub of SUBPATHS) paths[`${aliasFor(i)}${sub}`] = [`libs/${libName(i)}/src/index.ts`];
  }
  writeFileSync(
    join(FIXTURE, 'tsconfig.base.json'),
    JSON.stringify({
      compileOnSave: false,
      compilerOptions: {
        rootDir: '.',
        module: 'ESNext',
        target: 'ES2020',
        moduleResolution: 'bundler',
        strict: true,
        baseUrl: '.',
        paths,
      },
      exclude: ['node_modules'],
    }, null, 2) + '\n',
  );

  writeFileSync(
    join(FIXTURE, '.oxlintrc.json'),
    JSON.stringify({
      plugins: ['typescript', 'import'],
      categories: { correctness: 'off' },
      rules: {
        'import/no-cycle': 'warn',
        'import/no-duplicates': 'error',
        'import/first': 'error',
        'import/namespace': 'error',
        'import/default': 'error',
      },
      ignorePatterns: ['**/dist', 'node_modules'],
    }, null, 2) + '\n',
  );

  writeFileSync(
    join(FIXTURE, 'package.json'),
    JSON.stringify({ name: 'nx-repro', private: true, version: '0.0.0' }, null, 2) + '\n',
  );

  // Parent `.gitignore` may hide `libs/`; negate it locally so oxlint sees the files.
  writeFileSync(join(FIXTURE, '.gitignore'), '!libs/\n');

  const rand = (seed) => {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  };

  let totalFiles = 0;
  for (let li = 0; li < libs; li++) {
    const dir = join(libsDir, libName(li));
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });

    // Three tsconfigs per lib (Nx shape) — each extends the root.
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { outDir: '../../dist/out-tsc' },
      files: [], include: [],
      references: [{ path: './tsconfig.lib.json' }, { path: './tsconfig.spec.json' }],
    }, null, 2) + '\n');
    writeFileSync(join(dir, 'tsconfig.lib.json'), JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { outDir: '../../dist/out-tsc', types: ['node'] },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
    }, null, 2) + '\n');
    writeFileSync(join(dir, 'tsconfig.spec.json'), JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { outDir: '../../dist/out-tsc', types: ['jest', 'node'] },
      include: ['src/**/*.spec.ts'],
    }, null, 2) + '\n');

    // Barrel with cross-lib edges so no-cycle's walk has real graph work.
    const rngIdx = rand(li * 7919 + 1);
    const crossLinks = [];
    for (let k = 0; k < 4; k++) {
      const t = Math.floor(rngIdx() * libs);
      if (t !== li) crossLinks.push(t);
    }
    const idxImports = crossLinks.map((t, k) => `import { entry as cross${k} } from '${aliasFor(t)}';`);
    const idxBody = [
      ...idxImports,
      `export const entry = { id: 0, lib: '${libName(li)}', links: [${crossLinks.map((_, k) => `cross${k}.id`).join(', ')}] };`,
      '',
    ].join('\n');
    writeFileSync(join(srcDir, 'index.ts'), idxBody);

    const rng = rand(li * 1000003);
    for (let fi = 0; fi < files; fi++) {
      const otherA = Math.floor(rng() * libs);
      let otherB = Math.floor(rng() * libs);
      if (otherB === otherA) otherB = (otherA + 1) % libs;

      // Nest files deep so the tsconfig ancestor walk has more work.
      const d1 = fi % 10;
      const d2 = Math.floor(fi / 10) % 10;
      const d3 = Math.floor(fi / 100) % 10;
      const subDir = join(srcDir, `g${d1}`, `g${d2}`, `g${d3}`);
      mkdirSync(subDir, { recursive: true });

      const src = [
        `import { entry as a${otherA} } from '${aliasFor(otherA)}';`,
        `import { entry as b${otherB} } from '${aliasFor(otherB)}';`,
        '',
        `export const sibling${fi} = ${fi};`,
        `export const entry = { id: ${fi}, lib: '${libName(li)}' };`,
        `export function use${fi}(): number { return a${otherA}.id + b${otherB}.id; }`,
        '',
      ].join('\n');
      writeFileSync(join(subDir, `f${fi}.ts`), src);
      totalFiles++;
    }
  }

  return {
    files: totalFiles,
    tsconfigs: 1 + libs * 3,
    pathEntries: Object.keys(paths).length,
  };
}

// ─── Install oxlint versions from npm into temp dirs ────────────────────────

function installNpmVersion(version) {
  const dir = mkdtempSync(join(tmpdir(), `oxlint-${version}-`));
  process.stdout.write(`  installing oxlint@${version}… `);
  const r = spawnSync(
    'npm',
    ['install', '--no-save', '--silent', '--prefix', dir, `oxlint@${version}`],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (r.status !== 0) throw new Error(`npm install oxlint@${version} failed`);
  console.log('ok');
  return join(dir, 'node_modules', '.bin', 'oxlint');
}

// ─── Timing harness (`/usr/bin/time` BSD and GNU output) ────────────────────

const TIME_FLAG = process.platform === 'darwin' ? '-l' : '-v';

function timeRun(bin) {
  const start = process.hrtime.bigint();
  const r = spawnSync(
    '/usr/bin/time',
    [TIME_FLAG, bin, '--config', '.oxlintrc.json', '.'],
    { cwd: FIXTURE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;

  const err = r.stderr || '';
  let userSec = 0;
  let systemSec = 0;
  let maxRssBytes = 0;
  const bsd = err.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/);
  if (bsd) {
    userSec = parseFloat(bsd[2]);
    systemSec = parseFloat(bsd[3]);
  } else {
    const u = err.match(/User time \(seconds\):\s+([\d.]+)/);
    const s = err.match(/System time \(seconds\):\s+([\d.]+)/);
    if (u) userSec = parseFloat(u[1]);
    if (s) systemSec = parseFloat(s[1]);
  }
  // macOS BSD time -l prints bytes; GNU time -v prints kilobytes.
  const bsdRss = err.match(/(\d+)\s+maximum resident set size/);
  if (bsdRss) {
    maxRssBytes = parseInt(bsdRss[1], 10);
  } else {
    const gnuRss = err.match(/Maximum resident set size \(kbytes\):\s+(\d+)/);
    if (gnuRss) maxRssBytes = parseInt(gnuRss[1], 10) * 1024;
  }

  // Oxlint prints its summary to stdout. Fall back to stderr on older versions.
  const combined = (r.stdout || '') + '\n' + err;
  const summary = combined.match(/Found (\d+) warnings? and (\d+) errors?/);
  const threads = combined.match(/using (\d+) threads?/);
  const files = combined.match(/on (\d+) files?/);

  return {
    wallMs,
    userSec,
    systemSec,
    maxRssBytes,
    warnings: summary ? +summary[1] : null,
    errors: summary ? +summary[2] : null,
    threads: threads ? +threads[1] : null,
    filesLinted: files ? +files[1] : null,
    exit: r.status,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('─── fixture ─────────────────────────────────────────────────────');
let info;
if (args.reuse && existsSync(FIXTURE)) {
  console.log(`reusing existing fixture at ${FIXTURE}`);
} else {
  console.log(`generating fixture at ${FIXTURE} (libs=${args.libs}, files/lib=${args.files})…`);
  info = generate({ libs: args.libs, files: args.files });
  console.log(`  files=${info.files}  tsconfigs=${info.tsconfigs}  path aliases=${info.pathEntries}`);
}
if (args.onlyGenerate) process.exit(0);

console.log('\n─── targets ────────────────────────────────────────────────────');
const targets = [];
for (const v of args.versions) {
  targets.push({ label: `oxlint@${v}`, bin: installNpmVersion(v) });
}
for (const b of args.bins) {
  targets.push({ label: `bin:${basename(b)}`, bin: b });
}

console.log(`\n─── benchmark (${args.runs} runs per target) ───────────────────`);
const results = [];
for (const t of targets) {
  const rows = [];
  console.log(`→ ${t.label}`);
  for (let i = 0; i < args.runs; i++) {
    const r = timeRun(t.bin);
    rows.push(r);
    const cpuPct = r.wallMs > 0 ? ((r.userSec * 1000) / r.wallMs * 100).toFixed(0) : '?';
    const rssMb = (r.maxRssBytes / (1024 * 1024)).toFixed(0);
    console.log(
      `   run ${i + 1}: wall=${(r.wallMs / 1000).toFixed(2)}s  user=${r.userSec.toFixed(2)}s  ` +
        `sys=${r.systemSec.toFixed(2)}s  cpu=${cpuPct}%  rss=${rssMb}MB  files=${r.filesLinted}  ` +
        `warn=${r.warnings}  err=${r.errors}  threads=${r.threads}`,
    );
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = (xs) => Math.min(...xs);
  const max = (xs) => Math.max(...xs);
  results.push({
    label: t.label,
    wallMs: mean(rows.map((r) => r.wallMs)),
    wallMinMs: min(rows.map((r) => r.wallMs)),
    wallMaxMs: max(rows.map((r) => r.wallMs)),
    userSec: mean(rows.map((r) => r.userSec)),
    systemSec: mean(rows.map((r) => r.systemSec)),
    maxRssBytes: max(rows.map((r) => r.maxRssBytes)),
    meanRssBytes: mean(rows.map((r) => r.maxRssBytes)),
    warnings: rows[0].warnings,
    errors: rows[0].errors,
    filesLinted: rows[0].filesLinted,
  });
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n─── summary ────────────────────────────────────────────────────');
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
const base = results[0];
const header = [
  pad('target', 28),
  pad('wall mean (s)', 14),
  pad('wall range', 16),
  pad('user (s)', 10),
  pad('rss max (MB)', 14),
  pad('wall×', 8),
  pad('user×', 8),
  pad('rss×', 8),
  pad('warn', 8),
  'err',
].join('');
console.log(header);
console.log('─'.repeat(header.length));
for (const r of results) {
  const wallMean = (r.wallMs / 1000).toFixed(2);
  const wallRange = `${(r.wallMinMs / 1000).toFixed(2)}–${(r.wallMaxMs / 1000).toFixed(2)}`;
  const wallX = (r.wallMs / base.wallMs).toFixed(2) + '×';
  const userX =
    r.userSec > 0 && base.userSec > 0 ? (r.userSec / base.userSec).toFixed(2) + '×' : '—';
  const rssMb = (r.maxRssBytes / (1024 * 1024)).toFixed(0);
  const rssX =
    r.maxRssBytes > 0 && base.maxRssBytes > 0
      ? (r.maxRssBytes / base.maxRssBytes).toFixed(2) + '×'
      : '—';
  console.log(
    [
      pad(r.label, 28),
      pad(wallMean, 14),
      pad(wallRange, 16),
      pad(r.userSec.toFixed(2), 10),
      pad(rssMb, 14),
      pad(wallX, 8),
      pad(userX, 8),
      pad(rssX, 8),
      pad(String(r.warnings ?? '—'), 8),
      String(r.errors ?? '—'),
    ].join(''),
  );
}
console.log(
  '\nuser-CPU is the honest signal: wall-clock gets masked by parallelism on ' +
    'high-core\nlaptops, but CPU cost is what CI and smaller machines feel.\n',
);
