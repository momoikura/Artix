/**
 * SQLite storage adapter (desktop).
 *
 * Hybrid search strategy, which is the interesting part of this file:
 *
 *   1. FTS5 does the heavy text matching over full transcripts. It is fast and
 *      scales, but it has no typo tolerance.
 *   2. A *shallow* in-memory index (titles, projects, summaries, tags, tech —
 *      a few MB even at 100k sessions) provides fuzzy expansion when FTS finds
 *      nothing, so `galxy rendrer` still lands on the right star.
 *   3. Filtering and ranking always happen in TypeScript against the cached
 *      session records, so results are ordered identically in both backends.
 *
 * The full session list is cached in memory because the galaxy needs it
 * anyway; search reuses that cache rather than round-tripping to SQL.
 */

import { invoke } from '@tauri-apps/api/core';

import { artixError, err, ok, toArtixError } from '../core/result.ts';
import { buildDocument, buildShallowDocument } from '../search/document.ts';
import { buildFtsMatch } from '../search/fts.ts';
import { SearchEngine, compileFilters } from '../search/engine.ts';
import { splitPseudoTags } from '../search/query-parser.ts';
import { combineScore, normalizeBm25, sortHits } from '../search/rank.ts';
import { findHighlights } from '../search/document.ts';
import { emptyQuery } from '../core/types.ts';
import type { Result } from '../core/result.ts';
import type { ParsedQuery } from '../search/query-parser.ts';
import type {
  Facets,
  Highlight,
  LibraryStats,
  SearchHit,
  SearchQuery,
  SearchResult,
  Session,
  SessionDetail,
  SessionId,
  SessionLink,
  SessionPatch,
} from '../core/types.ts';
import type {
  DiscoveredFile,
  ImportOutcome,
  StorageAdapter,
  StorageCapabilities,
} from './adapter.ts';

/** True when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface Bootstrap {
  dataDir: string;
  databasePath: string;
  schemaVersion: number;
  appVersion: string;
  stats: LibraryStats;
}

export class TauriStorageAdapter implements StorageAdapter {
  readonly capabilities: StorageCapabilities = {
    fullTextSearch: true,
    filesystem: true,
    persistent: true,
    label: 'SQLite + FTS5 (local)',
  };

  /** Cache of every session. Rebuilt on init and patched on write. */
  readonly #sessions = new Map<SessionId, Session>();
  /** Shallow index used only for fuzzy expansion. */
  readonly #engine: SearchEngine;

  #bootstrap: Bootstrap | null = null;

  constructor() {
    this.#engine = new SearchEngine({ sessions: this.#sessions });
  }

  get bootstrapInfo(): Bootstrap | null {
    return this.#bootstrap;
  }

  async init(): Promise<Result<LibraryStats>> {
    try {
      this.#bootstrap = await invoke<Bootstrap>('bootstrap');
      const sessions = await invoke<Session[]>('list_sessions', {
        filters: { includeArchived: true },
      });

      this.#sessions.clear();
      this.#engine.index.clear();
      for (const session of sessions) {
        this.#sessions.set(session.id, session);
        this.#engine.indexDocument(buildShallowDocument(session));
      }

      return ok(this.#bootstrap.stats);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  /* -------------------------------------------------------------- reads */

  async listSessions(filters: Partial<SearchQuery> = {}): Promise<Result<Session[]>> {
    // Served from cache — the galaxy calls this on every filter change.
    const query = emptyQuery(filters);
    const { tags, pinnedOnly } = splitPseudoTags(query.tags);
    const predicate = compileFilters(query, tags, pinnedOnly);

    const out: Session[] = [];
    for (const session of this.#sessions.values()) {
      if (predicate(session)) out.push(session);
    }
    out.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
    return ok(out);
  }

  async getSession(id: SessionId): Promise<Result<SessionDetail>> {
    try {
      return ok(await invoke<SessionDetail>('get_session', { id }));
    } catch (e) {
      return err(toArtixError(e, 'not-found'));
    }
  }

  async search(query: ParsedQuery): Promise<Result<SearchResult>> {
    const started = performance.now();
    const now = Date.now();

    const hasText = query.terms.length > 0 || query.phrases.length > 0;
    if (!hasText) {
      // Filter-only: the local engine already does exactly this.
      return ok(this.#engine.search(query, now));
    }

    try {
      const { match, terms } = buildFtsMatch(query);
      let scores = new Map<SessionId, number>();
      let via: SearchHit['via'] = 'fts';

      if (match !== null) {
        const hits = await invoke<{ id: string; bm25: number }[]>('search_fts', {
          expression: match,
          limit: Math.max(query.limit * 4, 2000),
        });
        for (const hit of hits) scores.set(hit.id as SessionId, normalizeBm25(hit.bm25));
      }

      // Nothing matched exactly — fall back to typo-tolerant metadata search.
      if (scores.size === 0) {
        const fuzzy = this.#engine.search({ ...query, limit: query.limit * 4 }, now);
        if (fuzzy.hits.length > 0) {
          return ok({ ...fuzzy, elapsedMs: performance.now() - started });
        }
        scores = new Map();
        via = 'fuzzy';
      }

      const { tags, pinnedOnly } = splitPseudoTags(query.tags);
      const predicate = compileFilters(query, tags, pinnedOnly);

      const hits: SearchHit[] = [];
      for (const [id, relevance] of scores) {
        const session = this.#sessions.get(id);
        if (!session || !predicate(session)) continue;

        const titleMatch = query.terms.every((t) => session.title.toLowerCase().includes(t));
        hits.push({
          session,
          score: combineScore({ relevance, session, now }),
          highlights: collectHighlights(session, terms),
          via: titleMatch ? 'exact' : via,
        });
      }

      sortHits(hits, query.sort);
      if (query.sort === 'relevance') {
        hits.sort((a, b) => rankVia(b.via) - rankVia(a.via) || b.score - a.score);
      }

      return ok({
        hits: hits.slice(query.offset, query.offset + query.limit),
        total: hits.length,
        elapsedMs: performance.now() - started,
      });
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async facets(): Promise<Result<Facets>> {
    try {
      return ok(await invoke<Facets>('facets'));
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async stats(): Promise<Result<LibraryStats>> {
    try {
      return ok(await invoke<LibraryStats>('stats'));
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async knownHashes(): Promise<Result<Set<string>>> {
    try {
      return ok(new Set(await invoke<string[]>('content_hashes')));
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async sessionsForPath(path: string, limit = 50): Promise<Result<SessionId[]>> {
    try {
      return ok((await invoke<string[]>('sessions_for_path', { path, limit })) as SessionId[]);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  /* ------------------------------------------------------------- writes */

  async saveSession(detail: SessionDetail): Promise<Result<SessionId>> {
    try {
      const id = await invoke<string>('save_session', {
        detail,
        document: buildDocument(detail),
      });
      this.#cache(detail.session);
      return ok(id as SessionId);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async saveSessions(details: SessionDetail[]): Promise<Result<ImportOutcome>> {
    try {
      // Chunked so a 20k-file import reports progress and never builds one
      // multi-hundred-megabyte IPC payload.
      const CHUNK = 250;
      const outcome: ImportOutcome = { imported: [], duplicates: [], failed: [] };

      for (let i = 0; i < details.length; i += CHUNK) {
        const slice = details.slice(i, i + CHUNK);
        const items = slice.map((d) => [d, buildDocument(d)]);
        const partial = await invoke<ImportOutcome>('save_sessions', { items });

        outcome.imported.push(...partial.imported);
        outcome.duplicates.push(...partial.duplicates);
        outcome.failed.push(...partial.failed);

        const importedSet = new Set<string>(partial.imported);
        for (const detail of slice) {
          if (importedSet.has(detail.session.id)) this.#cache(detail.session);
        }
      }

      return ok(outcome);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async updateSession(id: SessionId, patch: SessionPatch): Promise<Result<void>> {
    try {
      await invoke('update_session', { id, patch });

      const cached = this.#sessions.get(id);
      if (cached) this.#cache({ ...cached, ...patch, updatedAt: Date.now() });

      // The FTS row must follow an edit, or search goes stale.
      const detail = await this.getSession(id);
      if (detail.ok) {
        await invoke('upsert_documents', { documents: [buildDocument(detail.value)] });
        this.#cache(detail.value.session);
      }
      return ok(undefined);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async deleteSessions(ids: SessionId[]): Promise<Result<number>> {
    try {
      const deleted = await invoke<number>('delete_sessions', { ids });
      for (const id of ids) {
        this.#sessions.delete(id);
        this.#engine.removeDocument(id);
      }
      return ok(deleted);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async replaceLinks(links: SessionLink[]): Promise<Result<number>> {
    try {
      return ok(await invoke<number>('replace_links', { links }));
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  /* -------------------------------------------------------- maintenance */

  async reindex(onProgress?: (done: number, total: number) => void): Promise<Result<number>> {
    try {
      const ids = [...this.#sessions.keys()];
      const documents = [];
      const CHUNK = 100;

      for (let i = 0; i < ids.length; i += CHUNK) {
        for (const id of ids.slice(i, i + CHUNK)) {
          const detail = await this.getSession(id);
          if (detail.ok) documents.push(buildDocument(detail.value));
        }
        onProgress?.(Math.min(i + CHUNK, ids.length), ids.length);
      }

      const count = await invoke<number>('reindex', { documents });

      this.#engine.index.clear();
      for (const session of this.#sessions.values()) {
        this.#engine.indexDocument(buildShallowDocument(session));
      }

      return ok(count);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async vacuum(): Promise<Result<void>> {
    try {
      await invoke('vacuum');
      return ok(undefined);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  /* ------------------------------------------------------------ key/value */

  async kvGet(key: string): Promise<Result<string | null>> {
    try {
      return ok(await invoke<string | null>('kv_get', { key }));
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async kvSet(key: string, value: string): Promise<Result<void>> {
    try {
      await invoke('kv_set', { key, value });
      return ok(undefined);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  async kvDelete(key: string): Promise<Result<void>> {
    try {
      await invoke('kv_delete', { key });
      return ok(undefined);
    } catch (e) {
      return err(toArtixError(e, 'storage'));
    }
  }

  /* ----------------------------------------------------------- filesystem */

  async discoverFiles(
    root: string,
    extensions: string[],
    options: { maxDepth?: number; maxFiles?: number } = {},
  ): Promise<Result<DiscoveredFile[]>> {
    try {
      return ok(
        await invoke<DiscoveredFile[]>('discover_files', {
          root,
          extensions,
          maxDepth: options.maxDepth ?? 8,
          maxFiles: options.maxFiles ?? 20_000,
        }),
      );
    } catch (e) {
      return err(toArtixError(e, 'io'));
    }
  }

  async readTextFile(path: string): Promise<Result<string>> {
    try {
      return ok(await invoke<string>('read_text_file', { path }));
    } catch (e) {
      return err(toArtixError(e, 'io'));
    }
  }

  async writeTextFile(path: string, contents: string): Promise<Result<void>> {
    try {
      await invoke('write_text_file', { path, contents });
      return ok(undefined);
    } catch (e) {
      return err(toArtixError(e, 'io'));
    }
  }

  async writeZip(path: string, entries: [string, string][]): Promise<Result<number>> {
    try {
      return ok(await invoke<number>('write_zip', { path, entries }));
    } catch (e) {
      return err(toArtixError(e, 'io'));
    }
  }

  async readZip(path: string): Promise<Result<[string, string][]>> {
    try {
      return ok(await invoke<[string, string][]>('read_zip', { path }));
    } catch (e) {
      return err(toArtixError(e, 'io'));
    }
  }

  async revealPath(path: string): Promise<Result<void>> {
    try {
      await invoke('reveal_path', { path });
      return ok(undefined);
    } catch (e) {
      return err(toArtixError(e, 'io'));
    }
  }

  /* ---------------------------------------------------------- internals */

  #cache(session: Session): void {
    this.#sessions.set(session.id, session);
    this.#engine.indexDocument(buildShallowDocument(session));
  }
}

function collectHighlights(session: Session, terms: readonly string[]): Highlight[] {
  if (terms.length === 0) return [];
  return [
    ...findHighlights('title', session.title, terms, 6),
    ...findHighlights('project', session.project, terms, 3),
    ...findHighlights('summary', session.summary, terms, 6),
  ];
}

function rankVia(via: SearchHit['via']): number {
  return via === 'exact' ? 3 : via === 'fts' ? 2 : via === 'fuzzy' ? 1 : 0;
}

/** Guard so callers can produce a clear message rather than a stack trace. */
export function requireTauri(): Result<true> {
  return isTauri()
    ? ok(true)
    : err(artixError('unsupported', 'This action needs the Artix desktop app.'));
}
