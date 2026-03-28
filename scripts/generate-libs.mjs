#!/usr/bin/env node

/**
 * Generates N libraries with realistic TypeScript/React files.
 *
 * Usage:
 *   node scripts/generate-libs.mjs [count] [files-per-lib]
 *
 * Defaults: 100 libs, 10 files per lib
 *
 * Examples:
 *   node scripts/generate-libs.mjs 50        # 50 libs × 10 files = 500 files
 *   node scripts/generate-libs.mjs 500 20    # 500 libs × 20 files = 10,000 files
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LIB_COUNT = parseInt(process.argv[2] || '100', 10);
const FILES_PER_LIB = parseInt(process.argv[3] || '10', 10);
const ROOT = join(import.meta.dirname, '..');
const LIBS_DIR = join(ROOT, 'libs');

// Clean existing libs
if (existsSync(LIBS_DIR)) {
  rmSync(LIBS_DIR, { recursive: true });
}

// Realistic TypeScript/React component templates with unused imports
const templates = [
  // React component with hooks + unused import
  (lib, i) => `import { useState, useEffect, useCallback } from 'react';
import { unusedHelper } from './utils';

interface ${p(lib)}Props${i} {
  id: string;
  label: string;
  onAction?: (id: string) => void;
}

export const ${p(lib)}Component${i} = ({ id, label, onAction }: ${p(lib)}Props${i}) => {
  const [state, setState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(\`/api/\${id}\`)
      .then(res => res.json())
      .then(data => setState(data.value))
      .finally(() => setLoading(false));
  }, [id]);

  const handleClick = useCallback(() => {
    onAction?.(id);
  }, [id, onAction]);

  if (loading) return <div>Loading...</div>;

  return (
    <div onClick={handleClick}>
      <span>{label}</span>
      <span>{state}</span>
    </div>
  );
};
`,
  // Table component with useMemo + unused import
  (lib, i) => `import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';

interface TableRow {
  id: string;
  name: string;
  value: number;
  createdAt: Date;
}

interface ${p(lib)}TableProps${i} {
  rows: TableRow[];
  sortBy?: keyof TableRow;
  onRowClick?: (row: TableRow) => void;
}

export const ${p(lib)}Table${i} = ({ rows, sortBy = 'name', onRowClick }: ${p(lib)}TableProps${i}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => String(a[sortBy]).localeCompare(String(b[sortBy]))),
    [rows, sortBy]
  );

  return (
    <div ref={containerRef}>
      {sortedRows.map(row => (
        <div key={row.id} onClick={() => onRowClick?.(row)}>
          <span>{row.name}</span>
          <span>{row.value}</span>
        </div>
      ))}
    </div>
  );
};
`,
  // Context/Provider with useReducer
  (lib, i) => `import { createContext, useContext, useReducer } from 'react';
import type { Dispatch } from 'react';

interface ${p(lib)}State${i} {
  items: string[];
  selected: string | null;
  filter: string;
}

type ${p(lib)}Action${i} =
  | { type: 'ADD_ITEM'; payload: string }
  | { type: 'SELECT'; payload: string }
  | { type: 'SET_FILTER'; payload: string }
  | { type: 'RESET' };

const initial: ${p(lib)}State${i} = { items: [], selected: null, filter: '' };

function reducer(state: ${p(lib)}State${i}, action: ${p(lib)}Action${i}): ${p(lib)}State${i} {
  switch (action.type) {
    case 'ADD_ITEM':
      return { ...state, items: [...state.items, action.payload] };
    case 'SELECT':
      return { ...state, selected: action.payload };
    case 'SET_FILTER':
      return { ...state, filter: action.payload };
    case 'RESET':
      return initial;
    default:
      return state;
  }
}

const Ctx${i} = createContext<{ state: ${p(lib)}State${i}; dispatch: Dispatch<${p(lib)}Action${i}> } | null>(null);

export const use${p(lib)}${i} = () => {
  const ctx = useContext(Ctx${i});
  if (!ctx) throw new Error('Missing provider');
  return ctx;
};
`,
  // API client utility (pure TS, no React)
  (lib, i) => `export interface ${p(lib)}Config${i} {
  endpoint: string;
  timeout: number;
  retries: number;
  headers: Record<string, string>;
}

export interface ${p(lib)}Response${i}<T> {
  data: T;
  status: number;
  timestamp: number;
}

export async function fetch${p(lib)}${i}<T>(
  config: ${p(lib)}Config${i},
  path: string,
  params?: Record<string, string>
): Promise<${p(lib)}Response${i}<T>> {
  const url = new URL(path, config.endpoint);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < config.retries; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: config.headers,
        signal: AbortSignal.timeout(config.timeout),
      });
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      const data = (await res.json()) as T;
      return { data, status: res.status, timestamp: Date.now() };
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError;
}
`,
  // Hook with event tracking
  (lib, i) => `import { useEffect, useState } from 'react';

type EventType = 'click' | 'hover' | 'scroll' | 'resize' | 'keydown';

interface AnalyticsEvent {
  type: EventType;
  target: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const queue: AnalyticsEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(event: AnalyticsEvent) {
  queue.push(event);
  if (!timer) timer = setTimeout(flush, 5000);
}

async function flush() {
  timer = null;
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  await fetch('/api/analytics', {
    method: 'POST',
    body: JSON.stringify(batch),
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => queue.unshift(...batch));
}

export function useTrack${p(lib)}${i}(target: string) {
  const [count, setCount] = useState(0);
  useEffect(() => () => { flush(); }, []);
  return {
    track: (type: EventType, meta?: Record<string, unknown>) => {
      enqueue({ type, target, timestamp: Date.now(), metadata: meta });
      setCount(c => c + 1);
    },
    eventCount: count,
  };
}
`,
];

function p(str) {
  return str.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('');
}

console.log(`Generating ${LIB_COUNT} libs x ${FILES_PER_LIB} files = ${LIB_COUNT * FILES_PER_LIB} total files...`);

for (let lib = 0; lib < LIB_COUNT; lib++) {
  const libName = `lib-${String(lib).padStart(4, '0')}`;
  const srcDir = join(LIBS_DIR, libName, 'src');
  mkdirSync(srcDir, { recursive: true });

  const exports = [];
  for (let file = 0; file < FILES_PER_LIB; file++) {
    const template = templates[file % templates.length];
    const fileName = `component-${file}.tsx`;
    writeFileSync(join(srcDir, fileName), template(libName, file));
    exports.push(`export * from './component-${file}';`);
  }

  writeFileSync(join(srcDir, 'index.ts'), exports.join('\n') + '\n');
  writeFileSync(join(srcDir, 'utils.ts'), 'export const unusedHelper = () => {};\n');
}

console.log(`Done! Generated in ./libs/`);
