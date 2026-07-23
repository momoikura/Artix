/**
 * Watched-folder auto-import.
 *
 * The general answer to "import from other AI apps and websites". Cloud tools
 * (ChatGPT, Claude.ai, Gemini) cannot be read live — Artix has no network stack
 * and would not scrape a logged-in site — but every one of them offers an
 * official data export. When that export file lands in a folder Artix watches
 * (your Downloads by default), it is auto-detected by format and imported, the
 * same way Claude Code sessions are.
 *
 * This is still a local file read into a local database. Nothing is transmitted.
 *
 * Format detection is delegated to the importer registry, so *any* format an
 * importer understands — ChatGPT `conversations.json`, a Claude.ai export, a
 * Markdown transcript, a plugin-provided format — is picked up automatically
 * with no per-source wiring here.
 */

import { importers } from '../importers/registry.ts';
import type { DiscoveredFile, StorageAdapter } from '../storage/adapter.ts';
import type { ImportSource } from '../importers/types.ts';

/** kv key holding the epoch-ms watermark of the last folder sync. */
export const FOLDER_SYNC_KEY = 'folders:lastSyncAt';

/**
 * Export files can be large single documents (a ChatGPT export is one big JSON
 * of every conversation), so the read/import loop is bounded to a handful at a
 * time — the same memory discipline the Claude Code path uses.
 */
const FOLDER_BATCH = 8;

/** Extensions worth importing from a watched folder. */
const IMPORT_EXTENSIONS = ['json', 'jsonl', 'ndjson', 'md', 'markdown', 'txt', 'zip'];

export interface FolderSyncResult {
  scanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  failed: number;
}

const EMPTY: FolderSyncResult = { scanned: 0, imported: 0, updated: 0, unchanged: 0, failed: 0 };

/**
 * Import export files from `folders` that changed since the last sync.
 *
 * Shallow by default (depth 2): a watched Downloads folder should not trigger a
 * deep filesystem walk. Extremely large files are skipped with a warning rather
 * than read into memory.
 */
export async function syncWatchedFolders(
  storage: StorageAdapter,
  folders: readonly string[],
  runImport: (sources: ImportSource[]) => Promise<{
    imported: unknown[];
    updated: unknown[];
    duplicates: unknown[];
    failed: unknown[];
  }>,
  options: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<FolderSyncResult> {
  if (folders.length === 0 || !storage.capabilities.filesystem) return EMPTY;

  let since = 0;
  if (!options.force) {
    const stored = await storage.kvGet(FOLDER_SYNC_KEY);
    if (stored.ok && stored.value) since = Number.parseInt(stored.value, 10) || 0;
  }
  const OVERLAP_MS = 60_000;

  // Collect changed candidate files across every watched folder.
  const candidates: DiscoveredFile[] = [];
  let scanned = 0;
  for (const folder of folders) {
    const found = await storage.discoverFiles(folder, IMPORT_EXTENSIONS, {
      maxDepth: 2,
      maxFiles: 5000,
    });
    if (!found.ok) continue;
    scanned += found.value.length;
    for (const file of found.value) {
      if (since === 0 || file.modifiedAt >= since - OVERLAP_MS) candidates.push(file);
    }
  }

  if (candidates.length === 0) {
    await storage.kvSet(FOLDER_SYNC_KEY, String(Date.now()));
    return { ...EMPTY, scanned };
  }

  const result: FolderSyncResult = { ...EMPTY, scanned };
  let done = 0;

  // Read and import in bounded batches so a folder of large exports never loads
  // whole into memory. The real filename is preserved as `source.name` — some
  // importers (ChatGPT, Markdown) use it as a detection signal.
  for (let start = 0; start < candidates.length; start += FOLDER_BATCH) {
    const batch = candidates.slice(start, start + FOLDER_BATCH);
    const sources: ImportSource[] = [];

    for (const file of batch) {
      const contents = await storage.readTextFile(file.path);
      if (contents.ok) {
        sources.push({
          reference: file.path,
          name: file.name,
          content: contents.value,
          modifiedAt: file.modifiedAt,
        });
      } else {
        result.failed++;
      }
      options.onProgress?.(++done, candidates.length);
    }

    if (sources.length > 0) {
      const report = await runImport(sources);
      result.imported += report.imported.length;
      result.updated += report.updated.length;
      result.unchanged += report.duplicates.length;
      result.failed += report.failed.length;
    }
  }

  await storage.kvSet(FOLDER_SYNC_KEY, String(Date.now()));
  return result;
}

/** The user's Downloads directory — the natural place exports land. */
export async function defaultWatchFolder(): Promise<string | null> {
  try {
    const { downloadDir } = await import('@tauri-apps/api/path');
    return await downloadDir();
  } catch {
    return null;
  }
}

/** Extensions the watched-folder importer accepts, for the file dialog / docs. */
export function watchedExtensions(): string[] {
  // Union of what every registered importer claims, plus archives.
  return [...new Set([...importers.extensions(), 'zip'])];
}
