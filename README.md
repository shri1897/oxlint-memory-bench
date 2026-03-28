# oxlint jsPlugins Memory Scaling Benchmark

Reproduces a memory scaling issue where oxlint's `jsPlugins` feature causes excessive memory usage in large monorepos, even with trivial custom plugins.

Related: [#19480](https://github.com/oxc-project/oxc/issues/19480), [#20331](https://github.com/oxc-project/oxc/issues/20331)

## The Problem

When using `jsPlugins` in `.oxlintrc.json`, the oxlint VS Code/Cursor extension spawns a Node.js process that consumes **1.5-1.7 GB of memory** in a large monorepo (~930 libs), even when:

- The JS plugin is a trivial custom rule (~60 lines, zero npm dependencies)
- No files matching the plugin's intended scope are open
- Without `jsPlugins`, memory usage is **~30 MB**

The issue scales with workspace size — the AST for every file appears to be serialized and passed to the Node process regardless of whether the jsPlugin's rules apply to that file.

## Quick Start

```bash
npm install
node scripts/generate-libs.mjs 500          # generate 500 libs × 10 files
node scripts/bench.mjs --libs 50,100,500    # run CLI memory benchmark
```

## Benchmarks

### CLI Mode (measures peak RSS via `/usr/bin/time`)

```bash
# Default: tests 50, 100, 200, 500, 1000 libs with 3 runs each
node scripts/bench.mjs

# Custom lib counts
node scripts/bench.mjs --libs 100,500,1000

# Test a specific oxlint version
node scripts/bench.mjs --version 1.55.0

# Single run (faster, less accurate)
node scripts/bench.mjs --runs 1 --libs 100,500,1000
```

### LSP Mode (simulates VS Code extension — starts `oxlint --lsp` and opens files)

```bash
# Default: tests 50, 100, 200, 500 libs
node scripts/bench-lsp.mjs

# Test a specific version
node scripts/bench-lsp.mjs --version 1.55.0 --libs 100,500
```

### Compare Across Versions

```bash
# Run benchmarks for multiple versions and compare
node scripts/compare-versions.mjs --versions 1.43.0,1.55.0,latest

# LSP mode comparison
node scripts/compare-versions.mjs --versions 1.43.0,latest --mode lsp --libs 100,500
```

## Testing a Specific oxlint Version

All benchmark scripts accept `--version <semver>` to install and test any published oxlint version:

```bash
node scripts/bench.mjs --version 1.43.0    # test an older version
node scripts/bench.mjs --version 1.55.0    # test a newer version
node scripts/bench.mjs                      # test currently installed version
```

## VS Code / Cursor Extension Test (Manual)

For the most realistic reproduction:

1. Generate a large workspace: `node scripts/generate-libs.mjs 500`
2. Open this folder in VS Code / Cursor with the oxc extension installed
3. Open Activity Monitor (macOS) or Task Manager (Windows) — find the `node` process parented by the extension host
4. Observe memory usage
5. Edit `.oxlintrc.json` to remove `jsPlugins`, reload the window, and compare

## Output

All benchmarks save JSON results to `./results/`:

```
results/
  0.16.7-cli.json       # CLI benchmark for version 0.16.7
  0.16.7-lsp.json       # LSP benchmark for version 0.16.7
  1.55.0-cli.json       # CLI benchmark for version 1.55.0
```

Each result file contains:
- Metadata (version, platform, date, config)
- Per-lib-count measurements for both `native-only` and `with-jsplugin` configs

## Files

```
scripts/
  generate-libs.mjs     # Generates N libs with realistic TypeScript/React files
  bench.mjs             # CLI mode benchmark (peak RSS via /usr/bin/time)
  bench-lsp.mjs         # LSP mode benchmark (simulates extension, measures RSS via ps)
  compare-versions.mjs  # Runs benchmarks across multiple oxlint versions
plugins/
  no-unused-imports.mjs # Minimal custom ESLint plugin (~60 lines, no dependencies)
.oxlintrc.json          # Default oxlint config with jsPlugins enabled
```

## Environment

Tested on:
- macOS 26 (Tahoe) — Darwin 25.4.0
- Node.js v25.2.1
- Apple M-series, 48 GB RAM
