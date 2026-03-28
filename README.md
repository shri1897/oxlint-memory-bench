# oxlint jsPlugins Memory Scaling Benchmark

Reproduces a memory scaling issue where oxlint's `jsPlugins` feature causes the node subprocess to accumulate **2+ GB of memory** in large monorepos.

Related: [#19480](https://github.com/oxc-project/oxc/issues/19480), [#20331](https://github.com/oxc-project/oxc/issues/20331)

## The Problem

When using `jsPlugins` in `.oxlintrc.json`, `oxlint --lsp` spawns a Node.js child process for the JS plugin bridge. This node process **retains AST data for every file** sent via `textDocument/didOpen` and never releases it, causing memory to grow linearly with workspace size.

The oxlint Rust process itself stays flat at ~95 MB. The issue is entirely in the node subprocess.

### Reproduction against a real monorepo (930 libs, 15K files)

```
Files opened | oxlint (Rust) | node (JS)  | Total
-------------|---------------|------------|--------
           0 |         95 MB |      11 MB |  106 MB
         500 |         95 MB |      48 MB |  143 MB
       1,000 |         95 MB |      99 MB |  194 MB
       1,500 |         95 MB |     502 MB |  597 MB
       2,000 |         95 MB |   1,015 MB | 1,110 MB
       2,500 |         95 MB |   1,721 MB | 1,816 MB
       5,000 |         95 MB |   2,162 MB | 2,257 MB
      10,000 |         95 MB |   2,351 MB | 2,446 MB
      15,000 |         95 MB |   2,360 MB | 2,456 MB  (V8 heap limit)
```

## Quick Start

```bash
npm install

# Benchmark against your own repo
node scripts/bench-real-repo.mjs --repo /path/to/your/monorepo

# Or generate a synthetic workspace and benchmark
node scripts/generate-libs.mjs 500
node scripts/bench.mjs --libs 50,100,500
```

## Benchmarks

### Real Repo Mode (most accurate — uses your actual codebase)

```bash
# Run against any repo with .oxlintrc.json containing jsPlugins
node scripts/bench-real-repo.mjs --repo /path/to/repo

# Limit files
node scripts/bench-real-repo.mjs --repo /path/to/repo --max-files 5000
```

This starts `oxlint --lsp`, sends `didOpen` for all workspace `.ts/.tsx` files (simulating the VS Code extension), and tracks the node subprocess memory separately from the oxlint Rust process.

### CLI Mode (measures peak RSS via `/usr/bin/time`)

```bash
node scripts/bench.mjs                              # default: 50-1000 libs
node scripts/bench.mjs --libs 100,500,1000           # custom sizes
node scripts/bench.mjs --version 1.55.0              # specific oxlint version
node scripts/bench.mjs --runs 1 --libs 100,500,1000  # single run (faster)
```

### LSP Mode (synthetic workspace)

```bash
node scripts/bench-lsp.mjs                            # default: 50-1000 libs
node scripts/bench-lsp.mjs --version 1.55.0 --libs 100,500
```

### Compare Across Versions

```bash
node scripts/compare-versions.mjs --versions 1.43.0,1.55.0,latest
node scripts/compare-versions.mjs --versions 1.43.0,latest --mode lsp
```

## Testing a Specific oxlint Version

All benchmark scripts accept `--version <semver>`:

```bash
node scripts/bench.mjs --version 1.43.0
node scripts/bench-lsp.mjs --version 1.55.0
```

## Output

All benchmarks save JSON results to `./results/` with full metadata and per-snapshot measurements.

## Files

```
scripts/
  bench-real-repo.mjs   # Benchmark against a real repo (most accurate)
  bench.mjs             # CLI mode benchmark (peak RSS via /usr/bin/time)
  bench-lsp.mjs         # LSP mode benchmark (synthetic workspace)
  compare-versions.mjs  # Run benchmarks across multiple oxlint versions
  generate-libs.mjs     # Generate synthetic TypeScript/React monorepo
plugins/
  no-unused-imports.mjs # Minimal custom ESLint plugin (~60 lines, no deps)
.oxlintrc.json          # Default config with jsPlugins enabled
```

## Environment

Tested on:
- macOS 26 (Tahoe) — Darwin 25.4.0
- Node.js v25.2.1
- Apple M-series, 48 GB RAM
