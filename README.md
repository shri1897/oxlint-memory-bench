# oxlint jsPlugins Memory Scaling Benchmark

Reproduces and measures a memory scaling issue where the oxlint LSP server's fixed-size allocator pool causes **unbounded RSS growth** in long-lived processes (VS Code/Cursor extension).

Related: [#19480](https://github.com/oxc-project/oxc/issues/19480), [#20331](https://github.com/oxc-project/oxc/issues/20331)

## The Problem

When using `jsPlugins` in `.oxlintrc.json`, `oxlint --lsp` uses fixed-size allocators (2 GB mmap regions) for raw transfer of AST data to the JS plugin bridge. These allocators are recycled via `FixedSizeAllocator::reset()`, which resets the bump pointer but **does not release physical pages** back to the OS. As files are opened, more pages are touched and committed, causing RSS to grow monotonically.

### Before Fix — RSS grows to 2.3 GB

```
Files opened | Total RSS
-------------|----------
           0 |    106 MB
         500 |    143 MB
       1,500 |    597 MB
       2,500 |  1,816 MB
       5,000 |  2,257 MB
      15,000 |  2,456 MB  ← V8 heap limit
```

### After Fix — RSS stays at 107 MB

```
Files opened | Total RSS
-------------|----------
           0 |     70 MB
         500 |    100 MB
       1,000 |    107 MB
       5,000 |    107 MB
      15,000 |    107 MB  ← flat
```

**95.5% memory reduction** (2,456 MB → 107 MB).

### Root Cause

`crates/oxc_allocator/src/pool/fixed_size.rs` — `FixedSizeAllocator::reset()` calls `self.allocator.reset()` which resets the bump pointer but does not call `madvise(MADV_DONTNEED)` to release physical pages.

### Fix

Add `madvise(MADV_DONTNEED)` after resetting the bump pointer:

```rust
fn reset(&mut self) {
    self.allocator.reset();
    // Release physical pages back to OS (keeps virtual address reservation)
    #[cfg(unix)]
    unsafe {
        let metadata_ptr = self.allocator.fixed_size_metadata_ptr();
        let chunk_ptr = metadata_ptr.cast::<u8>();
        let offset = chunk_ptr.as_ptr() as usize % FOUR_GIB;
        let block_start = chunk_ptr.as_ptr().sub(offset);
        unsafe extern "C" { fn madvise(addr: *mut c_void, len: usize, advice: i32) -> i32; }
        madvise(block_start.cast(), BLOCK_SIZE, 4); // MADV_DONTNEED = 4
    }
}
```

## Quick Start

```bash
npm install

# Benchmark against your own repo (primary method)
node scripts/bench-real-repo.mjs --repo /path/to/your/monorepo

# Test with a custom/patched oxlint binary
node scripts/bench-real-repo.mjs --repo /path/to/repo --oxlint-bin /path/to/patched/oxlint

# Test a NAPI build (cli.js from oxc build)
node scripts/bench-real-repo.mjs --repo /path/to/repo --oxlint-bin /path/to/oxc/apps/oxlint/dist/cli.js
```

## Benchmarks

### Real Repo Mode (recommended)

```bash
# Uses your repo's .oxlintrc.json and real files
node scripts/bench-real-repo.mjs --repo /path/to/repo

# Limit files for faster testing
node scripts/bench-real-repo.mjs --repo /path/to/repo --max-files 5000

# Compare stock vs patched binary
node scripts/bench-real-repo.mjs --repo /path/to/repo --output results/stock.json
node scripts/bench-real-repo.mjs --repo /path/to/repo --oxlint-bin /path/to/patched --output results/patched.json
```

### CLI Mode (synthetic workspace)

```bash
node scripts/generate-libs.mjs 500
node scripts/bench.mjs --libs 50,100,500,1000
node scripts/bench.mjs --version 1.55.0   # test specific version
```

### LSP Mode (synthetic workspace)

```bash
node scripts/bench-lsp.mjs --libs 50,100,500,1000
```

### Compare Across Versions

```bash
node scripts/compare-versions.mjs --versions 1.43.0,1.55.0,latest
```

## How It Works

The benchmark replicates the exact VS Code/Cursor extension behavior:

1. Starts `oxlint --lsp` (same binary the extension uses)
2. Sends `initialize` / `initialized` LSP messages
3. Sends `textDocument/didOpen` for all workspace `.ts`/`.tsx` files in batches
4. Tracks RSS of the process tree (oxlint + any child processes) via `ps`
5. Reports memory growth over time with ASCII chart

## Files

```
scripts/
  bench-real-repo.mjs   # Benchmark against a real repo (recommended)
  bench.mjs             # CLI mode benchmark (peak RSS via /usr/bin/time)
  bench-lsp.mjs         # LSP mode benchmark (synthetic workspace)
  compare-versions.mjs  # Compare benchmarks across oxlint versions
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
