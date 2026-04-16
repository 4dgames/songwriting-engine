/**
 * IndexedDB-backed project persistence.
 *
 * Audio blobs are stored as ArrayBuffers directly in IndexedDB — large enough
 * to hold typical song audio without hitting the localStorage 5 MB ceiling.
 */

import type { Song, SongSection, WordTimestamp } from './types';

const DB_NAME    = 'amplify-songwriter';
const DB_VERSION = 1;
const STORE      = 'projects';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectMeta {
  id:        string;
  name:      string;
  savedAt:   number;   // ms timestamp
  songTitle: string;
  genre:     string;
  userId?:   string;   // undefined = anonymous (pre-auth projects)
}

export interface StoredProject extends ProjectMeta {
  song:             Song;
  audioPrompt:      string;
  wordTimestamps:   WordTimestamp[];
  sectionTimings:   { startMs: number; endMs: number }[];
  lockedSections:   SongSection[];
  instrumentalBlob: ArrayBuffer;
  vocalsBlob:       ArrayBuffer | null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Fetch a blob URL and return its raw bytes as an ArrayBuffer. */
export async function blobUrlToArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  return res.arrayBuffer();
}

/** Wrap an ArrayBuffer in a Blob and create a local object URL. */
export function arrayBufferToBlobUrl(buf: ArrayBuffer, mimeType = 'audio/wav'): string {
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Save a project. Returns the project id.
 * Pass an existing `id` to overwrite that entry (used by auto-save).
 */
export async function saveProject(
  data: Omit<StoredProject, 'id' | 'savedAt'>,
  id?: string,
): Promise<string> {
  const db  = await openDB();
  const resolvedId = id ?? crypto.randomUUID();
  const row: StoredProject = { ...data, id: resolvedId, savedAt: Date.now() };

  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve(resolvedId);
    tx.onerror    = () => reject(tx.error);
  });
}

/** Load one project by id. Returns null if not found. */
export async function loadProject(id: string): Promise<StoredProject | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as StoredProject) ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Return project metadata sorted newest-first.
 * - If `userId` is provided: returns only that user's projects.
 * - If `userId` is omitted: returns anonymous (pre-auth) projects only.
 */
export async function listProjects(userId?: string): Promise<ProjectMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = req.result as StoredProject[];
      const filtered = userId
        ? rows.filter(r => r.userId === userId)
        : rows.filter(r => !r.userId);
      resolve(
        filtered
          .map(r => ({ id: r.id, name: r.name, savedAt: r.savedAt, songTitle: r.song.title, genre: r.song.genre, userId: r.userId }))
          .sort((a, b) => b.savedAt - a.savedAt),
      );
    };
    req.onerror = () => reject(req.error);
  });
}

/** Delete a project by id. */
export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
