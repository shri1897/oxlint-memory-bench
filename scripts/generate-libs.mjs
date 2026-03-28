#!/usr/bin/env node

/**
 * Generates N libraries with realistic TypeScript files to simulate a large monorepo.
 *
 * Usage:
 *   node scripts/generate-libs.mjs [count] [files-per-lib]
 *
 * Defaults: 100 libs, 10 files per lib
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB_COUNT = parseInt(process.argv[2] || '100', 10);
const FILES_PER_LIB = parseInt(process.argv[3] || '10', 10);
const LIBS_DIR = join(import.meta.dirname, '..', 'libs');

// Realistic TypeScript component templates
const templates = [
  (libName, i) => `
import { useState, useEffect, useCallback } from 'react';
import { unusedHelper } from '../utils';

interface ${pascal(libName)}Props {
  id: string;
  label: string;
  onAction?: (id: string) => void;
}

export const ${pascal(libName)}Component${i} = ({ id, label, onAction }: ${pascal(libName)}Props) => {
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
  (libName, i) => `
import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from 'date-fns';

interface TableRow {
  id: string;
  name: string;
  value: number;
  createdAt: Date;
}

interface ${pascal(libName)}TableProps${i} {
  rows: TableRow[];
  sortBy?: keyof TableRow;
  onRowClick?: (row: TableRow) => void;
}

export const ${pascal(libName)}Table${i} = ({ rows, sortBy = 'name', onRowClick }: ${pascal(libName)}TableProps${i}) => {
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
  (libName, i) => `
import { createContext, useContext, useReducer } from 'react';
import type { Dispatch } from 'react';

interface ${pascal(libName)}State${i} {
  items: string[];
  selected: string | null;
  filter: string;
}

type ${pascal(libName)}Action${i} =
  | { type: 'ADD_ITEM'; payload: string }
  | { type: 'SELECT'; payload: string }
  | { type: 'SET_FILTER'; payload: string }
  | { type: 'RESET' };

const initialState: ${pascal(libName)}State${i} = { items: [], selected: null, filter: '' };

function reducer(state: ${pascal(libName)}State${i}, action: ${pascal(libName)}Action${i}): ${pascal(libName)}State${i} {
  switch (action.type) {
    case 'ADD_ITEM':
      return { ...state, items: [...state.items, action.payload] };
    case 'SELECT':
      return { ...state, selected: action.payload };
    case 'SET_FILTER':
      return { ...state, filter: action.payload };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

const ${pascal(libName)}Context${i} = createContext<{
  state: ${pascal(libName)}State${i};
  dispatch: Dispatch<${pascal(libName)}Action${i}>;
} | null>(null);

export const use${pascal(libName)}${i} = () => {
  const ctx = useContext(${pascal(libName)}Context${i});
  if (!ctx) throw new Error('Missing provider');
  return ctx;
};

export const ${pascal(libName)}Provider${i} = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <${pascal(libName)}Context${i}.Provider value={{ state, dispatch }}>
      {children}
    </${pascal(libName)}Context${i}.Provider>
  );
};
`,
  (libName, i) => `
export interface ${pascal(libName)}Config${i} {
  endpoint: string;
  timeout: number;
  retries: number;
  headers: Record<string, string>;
}

export interface ${pascal(libName)}Response${i}<T> {
  data: T;
  status: number;
  timestamp: number;
}

export async function fetch${pascal(libName)}${i}<T>(
  config: ${pascal(libName)}Config${i},
  path: string,
  params?: Record<string, string>
): Promise<${pascal(libName)}Response${i}<T>> {
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

      const data = await res.json() as T;
      return { data, status: res.status, timestamp: Date.now() };
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw lastError;
}
`,
  (libName, i) => `
import { useEffect, useState } from 'react';

type EventType = 'click' | 'hover' | 'scroll' | 'resize' | 'keydown';

interface AnalyticsEvent {
  type: EventType;
  target: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const queue: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(event: AnalyticsEvent) {
  queue.push(event);
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 5000);
  }
}

async function flush() {
  flushTimer = null;
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  await fetch('/api/analytics', {
    method: 'POST',
    body: JSON.stringify(batch),
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => {
    queue.unshift(...batch);
  });
}

export function useTrack${pascal(libName)}${i}(target: string) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    return () => { flush(); };
  }, []);

  return {
    track: (type: EventType, metadata?: Record<string, unknown>) => {
      enqueue({ type, target, timestamp: Date.now(), metadata });
      setCount(c => c + 1);
    },
    eventCount: count,
  };
}
`,
];

function pascal(str) {
  return str
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

console.log(`Generating ${LIB_COUNT} libs with ${FILES_PER_LIB} files each...`);
console.log(`Total files: ${LIB_COUNT * FILES_PER_LIB}`);

for (let lib = 0; lib < LIB_COUNT; lib++) {
  const libName = `lib-${String(lib).padStart(4, '0')}`;
  const libDir = join(LIBS_DIR, libName, 'src');
  mkdirSync(libDir, { recursive: true });

  // index.ts barrel file
  const exports = [];

  for (let file = 0; file < FILES_PER_LIB; file++) {
    const template = templates[file % templates.length];
    const fileName = `component-${file}.tsx`;
    writeFileSync(join(libDir, fileName), template(libName, file).trimStart());
    exports.push(`export * from './component-${file}';`);
  }

  writeFileSync(join(libDir, 'index.ts'), exports.join('\n') + '\n');
  writeFileSync(join(libDir, 'utils.ts'), `export const unusedHelper = () => {};\n`);
}

console.log(`Done! Generated ${LIB_COUNT} libs in ./libs/`);
