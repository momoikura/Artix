/**
 * Claude Code session discovery.
 *
 * Claude Code keeps its transcripts as line-delimited JSON under the user's
 * home directory:
 *
 *   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
 *
 * Nothing here depends on an undocumented API — it reads files the user
 * already has, and every path is shown before anything is imported. Artix never
 * watches this directory in the background; a scan only happens when asked.
 *
 * IMPORTANT: the directory name is *not* reliably decodable. Claude Code
 * replaces both `:` and the path separator with `-`, so
 * `C--Users-me-Desktop-my-app` is ambiguous between `my-app` and `my/app`.
 * The real working directory is carried inside the file as `cwd`, so the
 * importer uses that and this module treats the folder name as a display hint
 * only.
 */

import { isTauri } from '../storage/tauri-adapter.ts';
import type { StorageAdapter, DiscoveredFile } from '../storage/adapter.ts';
import type { ImportSource } from '../importers/types.ts';

/** Where Claude Code stores transcripts, relative to the home directory. */
export const CLAUDE_PROJECTS_SUBPATH = '.claude/projects';

export interface DiscoveredSession {
  /** Absolute path to the `.jsonl` transcript. */
  path: string;
  /** The session UUID, taken from the file name. */
  id: string;
  /** Best-effort project label derived from the containing directory. */
  projectHint: string;
  bytes: number;
  modifiedAt: number;
  /**
   * Sub-agent transcripts belonging to this session, found at
   * `<session-id>/subagents/agent-*.jsonl`. They are read together with the
   * parent — on their own they contain only sidechain turns and would import
   * as empty phantom sessions.
   */
  subagentPaths: string[];
}

/**
 * Best-effort reversal of the directory encoding, for display only.
 *
 * `C--Users-me-Desktop-app` → `C:\Users\me\Desktop\app`. Ambiguous whenever a
 * real folder name contains a hyphen, which is why this result is never used as
 * the authoritative project — only as a label when a file carries no `cwd`.
 */
export function decodeProjectDir(name: string): string {
  // A leading single letter followed by `--` is a Windows drive.
  const drive = /^([A-Za-z])--(.*)$/.exec(name);
  if (drive) return `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/-/g, '\\')}`;
  // Otherwise assume a POSIX absolute path.
  return `/${name.replace(/^-+/, '').replace(/-/g, '/')}`;
}

/** Last path segment of the decoded directory — a readable project label. */
export function projectHintFromDir(name: string): string {
  const decoded = decodeProjectDir(name);
  const parts = decoded.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || name;
}

/**
 * Locate Claude Code's transcript directory.
 *
 * Returns null when it cannot be determined (browser build, or the user has
 * never run Claude Code).
 */
export async function claudeProjectsDir(storage: StorageAdapter): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { homeDir, join } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    const dir = await join(home, '.claude', 'projects');

    // `discoverFiles` fails cleanly when the directory is absent, which is the
    // cheapest existence probe available to us.
    const probe = await storage.discoverFiles(dir, ['jsonl'], { maxDepth: 1, maxFiles: 1 });
    return probe.ok ? dir : null;
  } catch {
    return null;
  }
}

/** Every transcript under the Claude Code store, newest first. */
export async function discoverClaudeSessions(
  storage: StorageAdapter,
  root?: string,
): Promise<DiscoveredSession[]> {
  const dir = root ?? (await claudeProjectsDir(storage));
  if (!dir) return [];

  const found = await storage.discoverFiles(dir, ['jsonl'], { maxDepth: 4, maxFiles: 20_000 });
  if (!found.ok) return [];

  const sessions: DiscoveredSession[] = [];
  // Parent session id -> its sub-agent transcripts.
  const subagents = new Map<string, { paths: string[]; bytes: number }>();

  for (const file of found.value as DiscoveredFile[]) {
    const segments = file.path.replace(/\\/g, '/').split('/');
    const parentDir = segments[segments.length - 2] ?? '';

    // `<project>/<session-id>/subagents/agent-x.jsonl`
    if (parentDir === 'subagents') {
      const owner = segments[segments.length - 3] ?? '';
      const entry = subagents.get(owner) ?? { paths: [], bytes: 0 };
      entry.paths.push(file.path);
      entry.bytes += file.bytes;
      subagents.set(owner, entry);
      continue;
    }

    sessions.push({
      path: file.path,
      id: file.name.replace(/\.jsonl$/i, ''),
      projectHint: projectHintFromDir(parentDir),
      bytes: file.bytes,
      modifiedAt: file.modifiedAt,
      subagentPaths: [],
    });
  }

  for (const session of sessions) {
    const owned = subagents.get(session.id);
    if (!owned) continue;
    session.subagentPaths = owned.paths;
    session.bytes += owned.bytes;
    subagents.delete(session.id);
  }

  return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Read discovered transcripts into import sources.
 *
 * `onProgress` fires per file because a 65 MB store takes a noticeable moment
 * and silent work looks like a hang.
 */
export async function readClaudeSessions(
  storage: StorageAdapter,
  sessions: readonly DiscoveredSession[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ sources: ImportSource[]; failed: string[] }> {
  const sources: ImportSource[] = [];
  const failed: string[] = [];

  for (const [index, session] of sessions.entries()) {
    const contents = await storage.readTextFile(session.path);
    if (contents.ok) {
      // Append sub-agent transcripts so they import as part of this session.
      // Line-delimited JSON concatenates cleanly, and the parser routes
      // sidechain turns into artifacts rather than the main thread.
      const parts = [contents.value];
      for (const path of session.subagentPaths) {
        const sub = await storage.readTextFile(path);
        if (sub.ok) parts.push(sub.value);
      }

      sources.push({
        reference: session.path,
        name: `${session.projectHint}-${session.id.slice(0, 8)}.jsonl`,
        content: parts.join('\n'),
        modifiedAt: session.modifiedAt,
      });
    } else {
      failed.push(session.path);
    }
    onProgress?.(index + 1, sessions.length);
  }

  return { sources, failed };
}

/* ------------------------------------------------------------ auto-sync */

/** kv key holding the epoch-ms watermark of the last successful sync. */
export const LAST_SYNC_KEY = 'claude-code:lastSyncAt';

export interface SyncResult {
  scanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  failed: number;
}

/**
 * Import transcripts changed since the last sync.
 *
 * Incremental by modification time, so a routine sync of a 65 MB store reads
 * only what actually changed — usually nothing, occasionally one file.
 *
 * A one-minute overlap is subtracted from the watermark because a transcript
 * being written *as* the scan runs can land a modification a moment before the
 * timestamp we record; without the overlap that write would be skipped forever.
 */
export async function syncClaudeSessions(
  storage: StorageAdapter,
  runImport: (sources: ImportSource[]) => Promise<{
    imported: unknown[];
    updated: unknown[];
    duplicates: unknown[];
    failed: unknown[];
  }>,
  options: { force?: boolean } = {},
): Promise<SyncResult> {
  const empty: SyncResult = { scanned: 0, imported: 0, updated: 0, unchanged: 0, failed: 0 };

  const all = await discoverClaudeSessions(storage);
  if (all.length === 0) return empty;

  let since = 0;
  if (!options.force) {
    const stored = await storage.kvGet(LAST_SYNC_KEY);
    if (stored.ok && stored.value) since = Number.parseInt(stored.value, 10) || 0;
  }

  const OVERLAP_MS = 60_000;
  const changed = since > 0 ? all.filter((s) => s.modifiedAt >= since - OVERLAP_MS) : all;
  if (changed.length === 0) {
    await storage.kvSet(LAST_SYNC_KEY, String(Date.now()));
    return { ...empty, scanned: all.length };
  }

  const { sources, failed } = await readClaudeSessions(storage, changed);
  const report = await runImport(sources);

  // Only advance the watermark on success, so a failed sync retries next time.
  await storage.kvSet(LAST_SYNC_KEY, String(Date.now()));

  return {
    scanned: all.length,
    imported: report.imported.length,
    updated: report.updated.length,
    unchanged: report.duplicates.length,
    failed: report.failed.length + failed.length,
  };
}

/** Human summary of a scan, for the confirmation step. */
export function describeScan(sessions: readonly DiscoveredSession[]): string {
  if (sessions.length === 0) return 'No Claude Code transcripts found.';

  const projects = new Set(sessions.map((s) => s.projectHint));
  const megabytes = sessions.reduce((sum, s) => sum + s.bytes, 0) / 1_048_576;

  return `${sessions.length} transcript${sessions.length === 1 ? '' : 's'} across ${
    projects.size
  } project${projects.size === 1 ? '' : 's'} · ${megabytes.toFixed(1)} MB`;
}
