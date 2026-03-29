#!/usr/bin/env node

/**
 * Generates N TypeScript/React files with realistic size distribution.
 *
 * Usage:
 *   node scripts/generate-libs.mjs [file-count]
 *
 * Defaults: 1000 files
 *
 * File size distribution (matches real monorepo):
 *   40% small    (20-80 lines,   ~1-3 KB)
 *   30% medium   (100-300 lines, ~4-12 KB)
 *   20% large    (400-1000 lines, ~15-40 KB)
 *    8% xl       (1500-4000 lines, ~60-160 KB)
 *    2% xxl      (5000-15000 lines, ~200-600 KB)
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FILE_COUNT = parseInt(process.argv[2] || '1000', 10);
const ROOT = join(import.meta.dirname, '..');
const LIBS_DIR = join(ROOT, 'libs');

if (existsSync(LIBS_DIR)) rmSync(LIBS_DIR, { recursive: true });

function pascal(n) { return 'M' + String(n).padStart(6, '0'); }

// Deterministic pseudo-random from index
function rand(idx) { return ((idx * 2654435761) >>> 0) / 4294967296; }

// Generate interface block (~10 lines each)
function iface(name, idx) {
  return `export interface ${name}T${idx} {
  id: string;
  name: string;
  value: number;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  tags: string[];
  status: 'active' | 'inactive' | 'pending' | 'archived';
  priority: number;
  assignee?: { id: string; name: string; email: string };
  parent?: ${name}T${idx} | null;
}\n\n`;
}

// Generate React component (~50-70 lines each)
function component(name, idx) {
  return `interface ${name}P${idx} {
  id: string;
  label: string;
  description?: string;
  items: Array<{ id: string; name: string; value: number; status: string }>;
  onAction?: (id: string, action: string) => void;
  onSelect?: (item: { id: string; name: string }) => void;
  className?: string;
  isLoading?: boolean;
  error?: Error | null;
  variant?: 'default' | 'compact' | 'detailed';
}

export const ${name}C${idx} = ({
  id, label, description, items, onAction, onSelect, className, isLoading, error, variant = 'default'
}: ${name}P${idx}) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'value'>('name');
  const [page, setPage] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageSize = variant === 'compact' ? 10 : 20;

  useEffect(() => {
    if (id) {
      fetch(\`/api/\${id}\`)
        .then(res => { if (!res.ok) throw new Error('Failed'); return res.json(); })
        .then(data => setSelected(data.defaultSelection))
        .catch(() => setSelected(null));
    }
    return () => setSelected(null);
  }, [id]);

  const filteredItems = useMemo(
    () => items
      .filter(item => item.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => sortBy === 'name' ? a.name.localeCompare(b.name) : a.value - b.value),
    [items, filter, sortBy]
  );

  const pagedItems = useMemo(
    () => filteredItems.slice(page * pageSize, (page + 1) * pageSize),
    [filteredItems, page, pageSize]
  );

  const handleSelect = useCallback((itemId: string) => {
    setSelected(itemId);
    const item = items.find(i => i.id === itemId);
    if (item && onSelect) onSelect({ id: item.id, name: item.name });
  }, [items, onSelect]);

  if (isLoading) return <div className={className}>Loading {label}...</div>;
  if (error) return <div className={className}>Error: {error.message}</div>;

  return (
    <div ref={containerRef} className={className} data-variant={variant}>
      <h2>{label}</h2>
      {description && <p>{description}</p>}
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter..." />
      <button onClick={() => setSortBy(s => s === 'name' ? 'value' : 'name')}>Sort: {sortBy}</button>
      <div>
        {pagedItems.map(item => (
          <div key={item.id} onClick={() => handleSelect(item.id)} style={{ fontWeight: selected === item.id ? 'bold' : 'normal' }}>
            <span>{item.name}</span>
            <span>{item.value}</span>
            <span>{item.status}</span>
            <button onClick={e => { e.stopPropagation(); onAction?.(item.id, 'delete'); }}>X</button>
          </div>
        ))}
      </div>
      <div>{page > 0 && <button onClick={() => setPage(p => p-1)}>Prev</button>}<button onClick={() => setPage(p => p+1)}>Next</button></div>
      <div>{filteredItems.length} of {items.length} items (page {page + 1})</div>
    </div>
  );
};\n\n`;
}

// Generate hook (~25 lines each)
function hook(name, idx) {
  return `export function use${name}H${idx}(endpoint: string, params?: Record<string, string>) {
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const fetch_ = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const url = new URL(endpoint, 'https://api.example.com');
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await fetch(url.toString(), { signal: controller.signal });
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      const d = await res.json();
      setData(d); setError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e as Error);
    } finally { setLoading(false); }
  }, [endpoint]);

  useEffect(() => { fetch_(); return () => controllerRef.current?.abort(); }, [fetch_]);

  return { data, loading, error, refetch: fetch_ };
}\n\n`;
}

// Generate util function (~8 lines each)
function util(name, idx) {
  return `export function ${name}U${idx}(input: string, opts?: { trim?: boolean; upper?: boolean; maxLen?: number; prefix?: string }): string {
  let r = input;
  if (opts?.trim) r = r.trim();
  if (opts?.upper) r = r.toUpperCase();
  if (opts?.maxLen && r.length > opts.maxLen) r = r.slice(0, opts.maxLen) + '...';
  if (opts?.prefix) r = opts.prefix + r;
  return r;
}\n\n`;
}

function generateFile(idx) {
  const name = pascal(idx);
  const r = rand(idx);

  // Determine target size bucket
  // Intentionally heavy to stress the allocator — each large file touches more
  // of the 2 GB fixed-size allocator buffer, and with thread_count allocators
  // active simultaneously, RSS grows proportionally.
  let targetBlocks;
  if (r < 0.20) targetBlocks = 1;            // 20%: ~3 KB
  else if (r < 0.40) targetBlocks = 4;       // 20%: ~15 KB
  else if (r < 0.60) targetBlocks = 12;      // 20%: ~45 KB
  else if (r < 0.80) targetBlocks = 40;      // 20%: ~150 KB
  else if (r < 0.85) targetBlocks = 120;     // 5%: ~450 KB
  else if (r < 0.93) targetBlocks = 400;     //  8%: ~1.5 MB
  else targetBlocks = 1200;                   //  7%: ~4.5 MB

  // Cross-file imports that oxlint can resolve — triggers import/no-cycle multi-file analysis.
  // Each file imports from several other generated files, creating a dense import graph.
  let content = `import { useState, useEffect, useCallback, useMemo, useRef } from 'react';\nimport type { ReactNode, Dispatch, SetStateAction } from 'react';\n`;
  const totalFiles = FILE_COUNT;
  for (let dep = 1; dep <= 5; dep++) {
    const depIdx = (idx + dep * 137) % totalFiles;
    if (depIdx === idx) continue;
    const depDir = `lib-${String(Math.floor(depIdx / 10)).padStart(5, '0')}`;
    const depFile = `f${depIdx % 10}`;
    content += `import { ${pascal(depIdx)}C0 } from '../../${depDir}/src/${depFile}';\n`;
  }
  content += '\n';

  for (let b = 0; b < targetBlocks; b++) {
    const blockType = b % 4;
    if (blockType === 0) content += component(name, b);
    else if (blockType === 1) content += iface(name, b);
    else if (blockType === 2) content += hook(name, b);
    else content += util(name, b);
  }

  return content;
}

console.log(`Generating ${FILE_COUNT} files...`);

const FILES_PER_DIR = 10;
const dirCount = Math.ceil(FILE_COUNT / FILES_PER_DIR);
let generated = 0;

for (let d = 0; d < dirCount && generated < FILE_COUNT; d++) {
  const dir = join(LIBS_DIR, `lib-${String(d).padStart(5, '0')}`, 'src');
  mkdirSync(dir, { recursive: true });

  const filesThisDir = Math.min(FILES_PER_DIR, FILE_COUNT - generated);
  for (let f = 0; f < filesThisDir; f++) {
    writeFileSync(join(dir, `f${f}.tsx`), generateFile(generated));
    generated++;
  }
}

// Print size stats
let totalBytes = 0, sizes = [];
for (let i = 0; i < Math.min(generated, 1000); i++) {
  const content = generateFile(i);
  totalBytes += content.length;
  sizes.push(content.length);
}
sizes.sort((a, b) => a - b);
console.log(`Done! ${generated} files in ./libs/`);
console.log(`Size stats (sampled ${sizes.length}): median ${(sizes[Math.floor(sizes.length/2)]/1024).toFixed(0)}KB, p95 ${(sizes[Math.floor(sizes.length*0.95)]/1024).toFixed(0)}KB, max ${(sizes[sizes.length-1]/1024).toFixed(0)}KB, avg ${(totalBytes/sizes.length/1024).toFixed(0)}KB`);
