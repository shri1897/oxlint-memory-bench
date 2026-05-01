# oxlint `import/no-cycle` Performance Regression Reproducer

Reproduces the oxlint 1.57+ performance regression caused by
[oxc-project/oxc#20566](https://github.com/oxc-project/oxc/pull/20566)
(commit `525c398d6`). The fix for cycle detection through tsconfig path
aliases made `oxlint --config .oxlintrc.json .` run with **8–15× more CPU**
on monorepos with many tsconfigs, even when the new behavior produces no
new findings.

## Quick start

```bash
node scripts/no-cycle-bench.mjs
```

Generates a synthetic Nx-style monorepo fixture (37,500 files, 451
tsconfigs, 900 path aliases — all trivial code), then benchmarks oxlint
`1.56.0` (pre-regression), `1.57.0` (regression), and `1.62.0` (latest)
from npm.

Requires `node >= 18` and `npm`. No project-level dependencies — requested
oxlint versions are installed into temp dirs.

## Flags

```
--version <x>      oxlint npm version to benchmark (repeatable)
--bin <path>       oxlint binary path (repeatable; e.g. a local build)
--libs <n>         libs in generated fixture (default 150)
--files <n>        source files per lib (default 250)
--runs <n>         runs per target (default 3)
--reuse            skip fixture regeneration
--only-generate    generate fixture and exit
--help             usage
```

## Examples

```bash
# Default: 1.56 / 1.57 / 1.62 from npm
node scripts/no-cycle-bench.mjs

# Bench a local patched build
node scripts/no-cycle-bench.mjs --bin /path/to/oxc/target/release/oxlint

# Compare a pre-regression release against your local fix
node scripts/no-cycle-bench.mjs --version 1.56.0 --bin /path/to/patched/oxlint

# Bisect across versions
node scripts/no-cycle-bench.mjs \
  --version 1.56.0 --version 1.57.0 --version 1.58.0 --version 1.59.0

# Smaller / larger fixture
node scripts/no-cycle-bench.mjs --libs 50 --files 100          # ≈5k files
node scripts/no-cycle-bench.mjs --libs 200 --files 400 --runs 5

# Reuse fixture across runs
node scripts/no-cycle-bench.mjs --only-generate
node scripts/no-cycle-bench.mjs --reuse --bin /path/to/oxlint
```

## Example output

```
─── summary ────────────────────────────────────────────────────
target               wall mean (s) wall range    user (s)  wall×   user×   warn   err
──────────────────────────────────────────────────────────────────────────────────────
oxlint@1.56.0        3.77          3.31–4.02     1.32      1.00×   1.00×   0      5
oxlint@1.57.0        3.60          3.42–3.95     11.01     0.95×   8.32×   148    5
oxlint@1.62.0        4.41          4.03–4.80     20.89     1.17×   15.79×  584    5
bin:oxlint (patched) 3.48          3.25–3.63     1.63      0.92×   1.23×   0      5
```

**User CPU is the honest signal.** Wall-clock is masked by parallelism on
high-core machines because oxlint scales across threads, but CPU cost is
what CI runners and smaller machines feel.

On a real Nx monorepo of the same shape (internal, not in this repo),
wall-clock regresses in proportion:

```
oxlint 1.56.0:     3.1 s wall,    6.6 s user CPU
oxlint 1.57.0:    25.8 s wall,  211.4 s user CPU   (8.2× wall, 32× CPU)
patched 1.57.0:    4.5 s wall,    7.9 s user CPU   (matches 1.56)
```

## Root cause

`crates/oxc_linter/src/service/runtime.rs` changed:

```rust
// 1.56 — directory-based, cheap per import
resolver.resolve(dir, specifier)

// 1.57+ — calls find_tsconfig(path) on every import edge
resolver.resolve_file(path, specifier)
```

`resolve_file` invokes `find_tsconfig(path)`, which walks ancestor
directories and runs `resolve_tsconfig_solution` per file. In Nx-style
monorepos this dominates CPU time.

## Fixture shape

- `nx-repro/tsconfig.base.json` — 900 `paths` entries (150 libs × 6 subpaths).
- `nx-repro/libs/lib-XXXXX/` — 150 libs × 3 tsconfigs each
  (`tsconfig.json`, `tsconfig.lib.json`, `tsconfig.spec.json`) all
  extending the root.
- `nx-repro/libs/lib-XXXXX/src/g*/g*/g*/f*.ts` — 250 files per lib nested
  3 directories deep; each has two cross-lib value imports through
  aliases (`@repo/lib-YYYYY`).
- `.oxlintrc.json` enables `import` plugin with `no-cycle: "warn"` plus
  four other import rules.

100% synthetic, deterministic (seeded PRNG), zero real code.

## Suggested upstream fixes

1. **Fast path for relative/absolute specifiers.** `./foo`, `../bar`,
   `/abs` never match tsconfig `paths`; they can keep using
   `resolve(dir, …)`. Only bare specifiers need `resolve_file`.
2. **Memoize `find_tsconfig` per directory.** Today it caches on
   `CachedPath.resolved_tsconfig` which is per-path; sibling files
   redundantly re-discover the same tsconfig.
3. **Lazy fallback.** Only run `find_tsconfig` when
   `resolve(dir, …)` fails to resolve the specifier. Preserves #20551's
   alias-cycle detection without paying the tsconfig tax on every edge.

## Building oxlint locally to test a fix

```bash
git clone https://github.com/oxc-project/oxc.git
cd oxc
git checkout apps_v1.57.0
# apply your fix, then:
cargo build --release --bin oxlint

cd /path/to/this/repo
node scripts/no-cycle-bench.mjs --bin $(pwd)/../oxc/target/release/oxlint
```
