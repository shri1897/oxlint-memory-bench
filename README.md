# oxlint jsPlugins Memory Scaling Benchmark

Measures how oxlint LSP memory scales with workspace size when `jsPlugins` are enabled.

Related: [#19480](https://github.com/oxc-project/oxc/issues/19480), [#20331](https://github.com/oxc-project/oxc/issues/20331)

## Quick Start

```bash
npm install
node scripts/bench.mjs
```

## Usage

```bash
# Default: tests 10 to 200K files
node scripts/bench.mjs

# Test a custom/patched oxlint binary
node scripts/bench.mjs --oxlint-bin /path/to/patched/oxlint

# Test a NAPI build (cli.js from oxc source build)
node scripts/bench.mjs --oxlint-bin /path/to/oxc/apps/oxlint/dist/cli.js
```

## How It Works

For each scale (10, 100, 500, 1K, 5K, 10K, 20K, 30K, 50K, 75K, 100K, 200K files):

1. Generates synthetic TypeScript/React files with realistic imports and unused imports
2. Starts `oxlint --lsp` (same binary the VS Code/Cursor extension uses)
3. Sends `initialize` / `initialized`
4. Sends `textDocument/didOpen` for every file (simulating the extension's file watcher)
5. Waits for processing to settle
6. Measures total RSS of the process tree
7. Reports memory and time

## The Problem

When using `jsPlugins`, oxlint uses 2 GB fixed-size allocator pools for raw AST transfer to the JS plugin bridge. `FixedSizeAllocator::reset()` resets the bump pointer but does not call `madvise(MADV_DONTNEED)` to release physical pages. RSS grows monotonically as more pages are touched across files.

### Before Fix

```
     Files    RSS (MB)    Time (s)
     1,000         103         2.5
     5,000         107         7.1
    10,000         107        13.7
    15,000       2,360        33.8
```

### After Fix (`madvise(MADV_DONTNEED)` in allocator reset)

```
     Files    RSS (MB)    Time (s)
     1,000         103         2.5
     5,000         107         7.1
    10,000         107        13.7
    15,000         107        20.3
```

**95.5% memory reduction** at scale.

## Files

```
scripts/
  bench.mjs             # The benchmark (generates files, runs LSP, measures)
  generate-libs.mjs     # Standalone file generator (used by bench.mjs)
plugins/
  no-unused-imports.mjs # Minimal custom ESLint plugin (~60 lines, no deps)
.oxlintrc.json          # Config with jsPlugins enabled
```
