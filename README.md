# oxlint jsPlugins Memory Scaling Benchmark

Measures oxlint LSP memory when `jsPlugins` are enabled. Used to identify and verify the fix for excessive memory usage in large monorepos.

## The Problem

When any `jsPlugin` is configured in `.oxlintrc.json`, the oxlint LSP node process consumes **1.6-2.5 GB** of memory — even with a trivial 10-line custom plugin.

### Root Cause

In oxlint 1.57.0, enabling any jsPlugin sets `external_plugin_store.is_enabled() = true`. This causes **every rule** that doesn't match an enabled builtin plugin to fall through to `external_plugin_store.lookup_rule_id()` — a Rust→JS→Rust roundtrip. In a config with 200+ rules across multiple override blocks, this means hundreds of unnecessary JS bridge roundtrips during config parsing, each allocating memory.

- No jsPlugins → `is_enabled() = false` → no JS bridge → **30 MB**
- Any jsPlugin → `is_enabled() = true` → hundreds of JS roundtrips → **1.6-2.5 GB**

### Fix

Commit [`c0ebbce18`](https://github.com/oxc-project/oxc/commit/c0ebbce18) by @camc314 — "report error on unknown builtin rule" ([#20464](https://github.com/oxc-project/oxc/pull/20464)). Known builtin rules now resolve on the Rust side and skip the JS roundtrip.

Tested against a 930-lib monorepo (10K files opened): **2.5 GB → 93 MB**.

## Quick Start

```bash
npm install
node scripts/generate-libs.mjs 5000
node scripts/bench.mjs
```

## Testing Against Your Own Repo

```bash
# Test with the installed oxlint (npm)
node scripts/bench.mjs --repo /path/to/your/monorepo

# Test with a custom oxlint build (e.g. built from oxc source)
node scripts/bench.mjs --repo /path/to/your/monorepo --oxlint-bin /path/to/oxc/apps/oxlint/dist/cli.js
```

## Building oxlint From Source (to test fixes)

```bash
# Clone oxc
git clone https://github.com/oxc-project/oxc.git
cd oxc

# Build at the buggy release (1.57.0)
git checkout 8b0f61d2a
cd apps/oxlint && pnpm install && pnpm run build
# Test: node dist/cli.js --lsp

# Build at the fix
git checkout c0ebbce18
cd apps/oxlint && pnpm run build
# Test: node dist/cli.js --lsp

# Build at HEAD (latest)
git checkout main
cd apps/oxlint && pnpm run build
```

Then run the benchmark against either build:

```bash
# Buggy build
node scripts/bench.mjs --repo /path/to/repo --oxlint-bin /path/to/oxc/apps/oxlint/dist/cli.js

# Fixed build
node scripts/bench.mjs --repo /path/to/repo --oxlint-bin /path/to/oxc-fixed/apps/oxlint/dist/cli.js
```

## Usage

```bash
node scripts/bench.mjs [options]

Options:
  --repo /path/to/repo        Use a real repository (recommended for reproducing the issue)
  --oxlint-bin /path/to/bin   Custom oxlint binary or cli.js (default: npx oxlint)
  --settle-ms 5000            Wait after last file for processing (default: 5000)
  --batch-size 500            Files per didOpen batch (default: 500)
  --output path               Save JSON results
```

## How It Works

For each scale (10 to 200K files):

1. Generates synthetic TypeScript/React files (or collects from `--repo`)
2. Starts `oxlint --lsp` (same as the VS Code/Cursor extension)
3. Sends `initialize` / `initialized`
4. Sends `textDocument/didOpen` for all files
5. Measures total RSS of the process tree
6. Reports memory and time

## Files

```
scripts/
  bench.mjs             # The benchmark
  generate-libs.mjs     # Synthetic file generator
plugins/
  no-unused-imports.mjs # Minimal custom ESLint plugin (~60 lines, no deps)
.oxlintrc.json          # Config with jsPlugins enabled
```

## Build Requirements (for testing oxc source builds)

- Rust toolchain (rustc, cargo)
- Node.js 20+
- pnpm
- cmake (for mimalloc)
