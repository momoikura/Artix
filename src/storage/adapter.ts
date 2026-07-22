/**
 * Storage contract.
 *
 * Everything above this line (UI, renderer, importers) talks only to
 * `StorageAdapter`. Two implementations exist:
 *
 *   TauriStorageAdapter  — SQLite + FTS5 via IPC. The real product.
 *   MemoryStorageAdapter — pure TypeScript. Powers `npm run dev` in a plain
 *                          browser, the unit tests, and the demo library.
 *
 * Keeping the interface honest (same semantics, same ordering, same errors)
 * is what lets the whole app be developed and tested without a Rust toolchain.
 */

import type { Result } from '../core/result.ts';
import type {
  Facets,
  LibraryStats,
  SearchQuery,
  SearchResult,
  Session,
  SessionDetail,
  SessionId,
  SessionLink,
  SessionPatch,
} from '../core/types.ts';
import type { ParsedQuery } from '../search/query-parser.ts';

/** Outcome of a bulk import. Duplicates are expected, not failures. */
export interface ImportOutcome {
  imported: SessionId[];
  /**
   * Sessions that already existed and were refreshed with newer content.
   * A transcript grows while you work, so a re-sync updates rather than
   * duplicating — matched on the source's own session id.
   */
  updated: SessionId[];
  duplicates: SessionId[];
  failed: { reference: string; message: string }[];
}

/** Filesystem entry returned by `discoverFiles`. */
export interface DiscoveredFile {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
}

export interface StorageCapabilities {
  /** SQLite FTS5 is available (desktop) vs. the in-memory index (web). */
  fullTextSearch: boolean;
  /** The adapter can read and write arbitrary user-picked paths. */
  filesystem: boolean;
  /** Data survives a restart. */
  persistent: boolean;
  /** Human label shown in Settings → About. */
  label: string;
}

export interface StorageAdapter {
  readonly capabilities: StorageCapabilities;

  /** Open the library and warm any in-memory indexes. Idempotent. */
  init(): Promise<Result<LibraryStats>>;

  /* ---- reads ---- */

  /** Every session, ordered newest first. The galaxy's data source. */
  listSessions(filters?: Partial<SearchQuery>): Promise<Result<Session[]>>;
  getSession(id: SessionId): Promise<Result<SessionDetail>>;
  search(query: ParsedQuery): Promise<Result<SearchResult>>;
  facets(): Promise<Result<Facets>>;
  stats(): Promise<Result<LibraryStats>>;
  /** Content hashes already stored — lets importers skip work before parsing. */
  knownHashes(): Promise<Result<Set<string>>>;
  /** Sessions that touched a path. Powers the file-centric view. */
  sessionsForPath(path: string, limit?: number): Promise<Result<SessionId[]>>;

  /* ---- writes ---- */

  saveSession(detail: SessionDetail): Promise<Result<SessionId>>;
  saveSessions(details: SessionDetail[]): Promise<Result<ImportOutcome>>;
  updateSession(id: SessionId, patch: SessionPatch): Promise<Result<void>>;
  deleteSessions(ids: SessionId[]): Promise<Result<number>>;
  replaceLinks(links: SessionLink[]): Promise<Result<number>>;

  /* ---- maintenance ---- */

  /** Rebuild the search index from scratch. */
  reindex(onProgress?: (done: number, total: number) => void): Promise<Result<number>>;
  /** Compact the database. No-op for the in-memory adapter. */
  vacuum(): Promise<Result<void>>;

  /* ---- key/value (settings, plugin config, saved views) ---- */

  kvGet(key: string): Promise<Result<string | null>>;
  kvSet(key: string, value: string): Promise<Result<void>>;
  kvDelete(key: string): Promise<Result<void>>;

  /* ---- filesystem (no-ops without `capabilities.filesystem`) ---- */

  discoverFiles(
    root: string,
    extensions: string[],
    options?: { maxDepth?: number; maxFiles?: number },
  ): Promise<Result<DiscoveredFile[]>>;
  readTextFile(path: string): Promise<Result<string>>;
  writeTextFile(path: string, contents: string): Promise<Result<void>>;
  writeZip(path: string, entries: [string, string][]): Promise<Result<number>>;
  readZip(path: string): Promise<Result<[string, string][]>>;
  revealPath(path: string): Promise<Result<void>>;
}
