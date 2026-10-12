import { useSyncExternalStore } from 'react';
import { type ProgressKind, type ProgressStatus } from '@/types/content';

/**
 * Learning progress, stored in this browser's localStorage. No backend, no account.
 *
 * localStorage can be cleared (site data wiped, private windows), so progress can also be
 * exported to / imported from a JSON file — see exportProgress / importProgress.
 */

const STORAGE_KEY = 'dblab-progress-v1';

export interface ProgressEntry {
  status: Exclude<ProgressStatus, 'new'>;
  /** How many times the item was marked. */
  reviews: number;
  updatedAt: string;
}

/** Keyed by `${kind}:${slug}`. Items without an entry are "new". */
export type ProgressMap = Readonly<Record<string, ProgressEntry>>;

interface StoredProgress {
  version: 1;
  entries: Record<string, ProgressEntry>;
}

const keyOf = (kind: ProgressKind, slug: string) => `${kind}:${slug}`;

function isEntry(value: unknown): value is ProgressEntry {
  const v = value as ProgressEntry;
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.status === 'known' || v.status === 'revise') &&
    typeof v.reviews === 'number' &&
    typeof v.updatedAt === 'string'
  );
}

/** Accepts the stored/exported shape and drops anything malformed. */
function parse(raw: string | null): ProgressMap {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Partial<StoredProgress>;
    if (data.version !== 1 || typeof data.entries !== 'object' || data.entries === null) return {};
    return Object.fromEntries(Object.entries(data.entries).filter(([, entry]) => isEntry(entry)));
  } catch {
    return {};
  }
}

function read(): ProgressMap {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {}; // Storage blocked (privacy settings): behave as a fresh start.
  }
}

let current: ProgressMap = read();
const listeners = new Set<() => void>();

function commit(next: ProgressMap) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: next } satisfies StoredProgress));
  } catch {
    // Storage full or blocked: keep progress in memory for this visit.
  }
  listeners.forEach((listener) => listener());
}

// Keep several open tabs in sync.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = parse(event.newValue);
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** All progress; re-renders the component whenever it changes. */
export function useProgress(): ProgressMap {
  return useSyncExternalStore(subscribe, () => current);
}

export function statusOf(progress: ProgressMap, kind: ProgressKind, slug: string): ProgressStatus {
  return progress[keyOf(kind, slug)]?.status ?? 'new';
}

/** Status of one item; re-renders when it changes. */
export function useStatus(kind: ProgressKind, slug: string): ProgressStatus {
  return statusOf(useProgress(), kind, slug);
}

export function setStatus(kind: ProgressKind, slug: string, status: ProgressStatus) {
  const key = keyOf(kind, slug);
  const { [key]: previous, ...rest } = current;
  if (status === 'new') {
    commit(rest);
    return;
  }
  commit({
    ...rest,
    [key]: { status, reviews: (previous?.reviews ?? 0) + 1, updatedAt: new Date().toISOString() },
  });
}

/** Slugs of one kind with a given status, e.g. all questions to revise. */
export function slugsWithStatus(progress: ProgressMap, kind: ProgressKind, status: ProgressStatus): string[] {
  const prefix = `${kind}:`;
  return Object.entries(progress)
    .filter(([key, entry]) => key.startsWith(prefix) && entry.status === status)
    .map(([key]) => key.slice(prefix.length));
}

/** Downloads progress as a JSON file (a backup you can import later or on another device). */
export function exportProgress() {
  const blob = new Blob([JSON.stringify({ version: 1, entries: current } satisfies StoredProgress, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `dblab-progress-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Replaces progress with the contents of an exported file. Returns how many entries were loaded;
 * 0 means the file had no DB Lab progress and nothing was changed.
 */
export async function importProgress(file: File): Promise<number> {
  const entries = parse(await file.text());
  const count = Object.keys(entries).length;
  if (count > 0) commit(entries);
  return count;
}

export function resetProgress() {
  commit({});
}
