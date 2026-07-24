/**
 * GitHub Copilot Chat discovery.
 *
 * Copilot stores chat history locally, so — like Claude Code and unlike the
 * cloud tools — it can be synced automatically with no export step:
 *
 *   <VS Code user dir>/workspaceStorage/<hash>/chatSessions/<uuid>.json
 *
 * VS Code ships under several names (stable, Insiders, VSCodium) and the user
 * directory differs per platform, so every plausible root is probed and the
 * ones that exist are scanned.
 *
 * As everywhere else in Artix, this is a local file read into a local database.
 */

import type { DiscoveredFile, StorageAdapter } from '../storage/adapter.ts';
import type { ImportSource } from '../importers/types.ts';

/** kv key holding the epoch-ms watermark of the last Copilot sync. */
export const COPILOT_SYNC_KEY = 'copilot:lastSyncAt';

/** VS Code distributions that share the workspaceStorage layout. */
const VSCODE_DIRS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];

export interface CopilotSyncResult {
  scanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  failed: number;
}

const EMPTY: CopilotSyncResult = { scanned: 0, imported: 0, updated: 0, unchanged: 0, failed: 0 };

/**
 * Every `workspaceStorage` root that exists on this machine.
 *
 * Windows keeps it under `%APPDATA%`, macOS under `~/Library/Application
 * Support`, Linux under `~/.config`.
 */
export async function vscodeStorageRoots(storage: StorageAdapter): Promise<string[]> {
  try {
    const { homeDir, join } = await import('@tauri-apps/api/path');
    const home = await homeDir();

    const bases: string[] = [];
    for (const dir of VSCODE_DIRS) {
      bases.push(await join(home, 'AppData', 'Roaming', dir, 'User', 'workspaceStorage'));
      bases.push(await join(home, 'Library', 'Application Support', dir, 'User', 'workspaceStorage'));
      bases.push(await join(home, '.config', dir, 'User', 'workspaceStorage'));
    }

    // Probing costs one cheap directory listing each; only real ones survive.
    const found: string[] = [];
    for (const base of bases) {
      const probe = await storage.discoverFiles(base, ['json'], { maxDepth: 1, maxFiles: 1 });
      if (probe.ok) found.push(base);
    }
    return found;
  } catch {
    return [];
  }
}

/** Chat session files under the given roots, newest first. */
export async function discoverCopilotSessions(
  storage: StorageAdapter,
  roots: readonly string[],
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];

  for (const root of roots) {
    // workspaceStorage/<hash>/chatSessions/<uuid>.json is exactly three levels.
    const found = await storage.discoverFiles(root, ['json'], { maxDepth: 3, maxFiles: 20_000 });
    if (!found.ok) continue;
    for (const file of found.value) {
      if (file.path.replace(/\\/g, '/').includes('/chatSessions/')) out.push(file);
    }
  }

  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Import Copilot sessions changed since the last sync.
 *
 * Incremental by modification time and batched, so a machine with years of
 * editor history costs one cheap scan per tick and bounded memory when it does
 * have work to do.
 */
export async function syncCopilotSessions(
  storage: StorageAdapter,
  runImport: (sources: ImportSource[]) => Promise<{
    imported: unknown[];
    updated: unknown[];
    duplicates: unknown[];
    failed: unknown[];
  }>,
  options: { force?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<CopilotSyncResult> {
  if (!storage.capabilities.filesystem) return EMPTY;

  const roots = await vscodeStorageRoots(storage);
  if (roots.length === 0) return EMPTY;

  const all = await discoverCopilotSessions(storage, roots);
  if (all.length === 0) return EMPTY;

  let since = 0;
  if (!options.force) {
    const stored = await storage.kvGet(COPILOT_SYNC_KEY);
    if (stored.ok && stored.value) since = Number.parseInt(stored.value, 10) || 0;
  }

  const OVERLAP_MS = 60_000;
  const changed = since > 0 ? all.filter((f) => f.modifiedAt >= since - OVERLAP_MS) : all;
  if (changed.length === 0) {
    await storage.kvSet(COPILOT_SYNC_KEY, String(Date.now()));
    return { ...EMPTY, scanned: all.length };
  }

  const result: CopilotSyncResult = { ...EMPTY, scanned: all.length };
  const BATCH = 12;
  let done = 0;

  for (let start = 0; start < changed.length; start += BATCH) {
    const batch = changed.slice(start, start + BATCH);
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
      options.onProgress?.(++done, changed.length);
    }

    if (sources.length > 0) {
      const report = await runImport(sources);
      result.imported += report.imported.length;
      result.updated += report.updated.length;
      result.unchanged += report.duplicates.length;
      result.failed += report.failed.length;
    }
  }

  await storage.kvSet(COPILOT_SYNC_KEY, String(Date.now()));
  return result;
}
