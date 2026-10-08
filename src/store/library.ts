import type { Score } from '../core';

/**
 * IndexedDB-backed tab library. Two object stores so listing never has to load the (multi-MB) scores:
 *  - `entries`: LibrarySummary rows (id, name, dates, thumbnail, preview)
 *  - `scores`:  id -> Score (including meta.sourcePages data URLs, stored as-is)
 */
export interface LibrarySummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Small JPEG data URL of the first source page, when there is one */
  thumbnail?: string;
  /** Short text such as the first chord names */
  preview?: string;
}
export interface LibraryEntry extends LibrarySummary {
  score: Score;
}

const DB_NAME = 'tabscribe-library';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function libraryAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** Drop the cached connection (used by tests that swap the IndexedDB implementation). */
export function resetLibraryConnection() {
  dbPromise?.then((d) => d.close()).catch(() => {});
  dbPromise = null;
}

function openDb(): Promise<IDBDatabase> {
  if (!libraryAvailable()) return Promise.reject(new Error('IndexedDB is not available'));
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('scores')) db.createObjectStore('scores');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export function newLibraryId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface SaveInput {
  id: string;
  name: string;
  score: Score;
  thumbnail?: string;
  preview?: string;
}

/** Create or update an entry. Keeps createdAt (and the thumbnail/preview if none is passed) of an existing one. */
export async function saveEntry(input: SaveInput): Promise<LibrarySummary> {
  const db = await openDb();
  const prev = (await done(db.transaction('entries').objectStore('entries').get(input.id))) as LibrarySummary | undefined;
  const now = Date.now();
  const summary: LibrarySummary = {
    id: input.id,
    name: input.name,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    thumbnail: input.thumbnail ?? prev?.thumbnail,
    preview: input.preview ?? prev?.preview,
  };
  const tx = db.transaction(['entries', 'scores'], 'readwrite');
  tx.objectStore('entries').put(summary);
  tx.objectStore('scores').put(input.score, input.id);
  await txDone(tx);
  return summary;
}

export async function listEntries(): Promise<LibrarySummary[]> {
  const db = await openDb();
  const rows = (await done(db.transaction('entries').objectStore('entries').getAll())) as LibrarySummary[];
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getEntry(id: string): Promise<LibraryEntry | null> {
  const db = await openDb();
  const tx = db.transaction(['entries', 'scores']);
  const [summary, score] = await Promise.all([
    done(tx.objectStore('entries').get(id)) as Promise<LibrarySummary | undefined>,
    done(tx.objectStore('scores').get(id)) as Promise<Score | undefined>,
  ]);
  return summary && score ? { ...summary, score } : null;
}

export async function renameEntry(id: string, name: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  const row = (await done(store.get(id))) as LibrarySummary | undefined;
  if (row) store.put({ ...row, name, updatedAt: Date.now() });
  await txDone(tx);
}

export async function deleteEntry(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['entries', 'scores'], 'readwrite');
  tx.objectStore('entries').delete(id);
  tx.objectStore('scores').delete(id);
  await txDone(tx);
}

export async function duplicateEntry(id: string, name?: string): Promise<LibrarySummary | null> {
  const e = await getEntry(id);
  if (!e) return null;
  return saveEntry({
    id: newLibraryId(),
    name: name ?? `${e.name} (copy)`,
    score: structuredClone(e.score),
    thumbnail: e.thumbnail,
    preview: e.preview,
  });
}

/** Downscale the first source page to a small JPEG data URL (browser only; resolves undefined elsewhere). */
export async function makeThumbnail(score: Score, width = 96): Promise<string | undefined> {
  const src = score.meta.sourcePages?.[0];
  if (!src || typeof document === 'undefined' || typeof Image === 'undefined') return undefined;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    if (!img.naturalWidth) return undefined;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * width));
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  } catch {
    return undefined;
  }
}
