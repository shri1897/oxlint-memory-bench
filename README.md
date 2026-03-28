# oxlint jsPlugins Memory Scaling Benchmark

Reproduces a memory scaling issue where oxlint's `jsPlugins` feature causes excessive memory usage in large monorepos.

## The Problem

When using `jsPlugins` in `.oxlintrc.json`, the oxlint VS Code extension spawns a Node.js process that consumes **1.5-1.7 GB of memory** in a large monorepo (~930 libs), even when:

- The JS plugin is a trivial custom rule (~60 lines)
- No files matching the plugin's intended scope are open
- Without `jsPlugins`, memory is **~30 MB**

## Reproduction

### Quick Start

```bash
npm install
npm run generate        # generates 100 libs × 10 files = 1,000 files
npm run bench           # runs memory benchmark
```

### Custom Sizes

```bash
# Generate specific number of libs (10 files each)
node scripts/generate-libs.mjs 500

# Benchmark with custom lib counts
node scripts/bench-memory.mjs 50,100,500,1000
```

### VS Code / Cursor Extension Test

1. Install the [oxc extension](https://marketplace.visualstudio.com/items?itemName=nicolo-ribaudo.oxlint-unofficial) (or official oxc extension)
2. Generate libs: `node scripts/generate-libs.mjs 500`
3. Open this folder in VS Code / Cursor
4. Open Activity Monitor and find the `node` process under the extension host
5. Observe memory usage

Then edit `.oxlintrc.json` to remove `jsPlugins`, reload, and compare.

### Expected Results

| Libs | Files | Without jsPlugins | With jsPlugins |
|------|-------|-------------------|----------------|
| 50   | 500   | ~X MB             | ~X MB          |
| 100  | 1,000 | ~X MB             | ~X MB          |
| 500  | 5,000 | ~X MB             | ~X MB          |

## Files

- `scripts/generate-libs.mjs` — Generates N libs with realistic TypeScript/React files
- `scripts/bench-memory.mjs` — Benchmarks oxlint memory usage with/without jsPlugins
- `plugins/no-unused-imports.mjs` — Minimal custom ESLint plugin (~60 lines)
- `.oxlintrc.json` — oxlint config with jsPlugins enabled

## Environment

- macOS 26 (Tahoe) — Darwin 25.4.0
- Node.js v25.2.1
- oxlint (latest)
