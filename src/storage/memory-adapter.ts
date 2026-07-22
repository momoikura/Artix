/**
 * In-memory storage adapter.
 *
 * Not a mock — this is a complete, correct implementation of the storage
 * contract that happens to keep everything in JS structures. It is what runs
 * when Artix is opened in a plain browser (`npm run dev`), what the unit tests
 * exercise, and what backs the bundled demo library.
 *
 * Optional persistence to `localStorage` keeps a browser session's edits across
 * reloads; it is capped and gracefully degrades when quota is exceeded.
 */

import { SearchEngine } from '../search/engine.ts';
import { buildDocument } from '../search/document.ts';
import { artixError, err, ok } from '../core/result.ts';
import { applyPatch } from '../core/session.ts';
import { compileFilters } from '../search/engine.ts';
import { splitPseudoTags } from '../search/query-parser.ts';
import { emptyQuery } from '../core/types.ts';
import type { Result } from '../core/result.ts';
import type { ParsedQuery } from '../search/query-parser.ts';
import type {
  Facets,
  FacetBucket,
  LibraryStats,
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

const PERSIST_KEY = 'artix:library:v1';
/** Roughly the safe ceiling for localStorage across browsers. */
const PERSIST_LIMIT_BYTES = 4 * 1024 * 1024;

export interface MemoryAdapterOptions {
  /** Mirror writes into localStorage. Off in tests, on in the browser build. */
  persist?: boolean;
  /** Seed data used when nothing has been persisted yet. */
  seed?: SessionDetail[];
}

export class MemoryStorageAdapter implements StorageAdapter {
  readonly capabilities: StorageCapabilities = {
    fullTextSearch: false,
    filesystem: false,
    persistent: false,
    label: 'In-memory (browser preview)',
  };

  readonly #sessions = new Map<SessionId, Session>();
  readonly #details = new Map<SessionId, SessionDetail>();
  readonly #hashes = new Set<string>();
  #links: SessionLink[] = [];

  readonly #engine: SearchEngine;
  readonly #options: MemoryAdapterOptions;
  #initialised = false;

  constructor(options: MemoryAdapterOptions = {}) {
    this.#options = options;
    this.capabilities.persistent = options.persist === true;
    if (options.persist) this.capabilities.label = 'In-memory + localStorage (browser preview)';
    this.#engine = new SearchEngine({ sessions: this.#sessions });
  }

  async init(): Promise<Result<LibraryStats>> {
    if (this.#initialised) return this.stats();

    const restored = this.#options.persist ? this.#restore() : null;
    const seed = restored ?? this.#options.seed ?? [];
    for (const detail of seed) this.#insert(detail);

    this.#initialised = true;
    return this.stats();
  }

  /* -------------------------------------------------------------- reads */

  async listSessions(filters: Partial<SearchQuery> = {}): Promise<Result<Session[]>> {
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
    const detail = this.#details.get(id);
    if (!detail) return err(artixError('not-found', `Session ${id} is not in this library.`));
    return ok({ ...detail, links: this.#links.filter((l) => l.fromId === id || l.toId === id) });
  }

  async search(query: ParsedQuery): Promise<Result<SearchResult>> {
    return ok(this.#engine.search(query));
  }

  async facets(): Promise<Result<Facets>> {
    const languages = new Map<string, number>();
    const projects = new Map<string, number>();
    const tags = new Map<string, number>();
    const technologies = new Map<string, number>();
    const statuses = new Map<string, number>();

    for (const s of this.#sessions.values()) {
      if (s.language) bump(languages, s.language);
      bump(projects, s.project);
      bump(statuses, s.status);
      for (const t of s.tags) bump(tags, t);
      for (const t of s.technologies) bump(technologies, t);
    }

    return ok({
      languages: toBuckets(languages),
      projects: toBuckets(projects),
      tags: toBuckets(tags),
      technologies: toBuckets(technologies),
      statuses: toBuckets(statuses),
    });
  }

  async stats(): Promise<Result<LibraryStats>> {
    let messageCount = 0;
    let artifactCount = 0;
    let fileCount = 0;
    let tokenEstimate = 0;
    let earliest: number | null = null;
    let latest: number | null = null;
    const projects = new Set<string>();

    for (const s of this.#sessions.values()) {
      messageCount += s.messageCount;
      artifactCount += s.artifactCount;
      fileCount += s.fileCount;
      tokenEstimate += s.tokenEstimate;
      projects.add(s.project);
      if (earliest === null || s.startedAt < earliest) earliest = s.startedAt;
      if (latest === null || s.startedAt > latest) latest = s.startedAt;
    }

    return ok({
      sessionCount: this.#sessions.size,
      messageCount,
      artifactCount,
      fileCount,
      projectCount: projects.size,
      tokenEstimate,
      earliest,
      latest,
      databaseBytes: 0,
    });
  }

  async knownHashes(): Promise<Result<Set<string>>> {
    return ok(new Set(this.#hashes));
  }

  async sessionsForPath(path: string, limit = 50): Promise<Result<SessionId[]>> {
    const out: SessionId[] = [];
    for (const detail of this.#details.values()) {
      if (detail.files.some((f) => f.path === path)) out.push(detail.session.id);
      if (out.length >= limit) break;
    }
    return ok(out);
  }

  /* ------------------------------------------------------------- writes */

  async saveSession(detail: SessionDetail): Promise<Result<SessionId>> {
    if (this.#hashes.has(detail.session.contentHash)) {
      return err(artixError('duplicate', 'This session is already in your library.'));
    }
    this.#insert(detail);
    this.#persist();
    return ok(detail.session.id);
  }

  async saveSessions(details: SessionDetail[]): Promise<Result<ImportOutcome>> {
    const outcome: ImportOutcome = { imported: [], updated: [], duplicates: [], failed: [] };

    for (const detail of details) {
      // Mirror the SQLite adapter: identity is (source, sourceRef) when the
      // source provides one, so a grown transcript refreshes in place.
      const existing = this.#findBySourceRef(detail.session);
      if (existing) {
        if (existing.session.contentHash === detail.session.contentHash) {
          outcome.duplicates.push(existing.session.id);
          continue;
        }
        this.#refresh(existing, detail);
        outcome.updated.push(existing.session.id);
        continue;
      }

      if (this.#hashes.has(detail.session.contentHash)) {
        outcome.duplicates.push(detail.session.id);
        continue;
      }
      try {
        this.#insert(detail);
        outcome.imported.push(detail.session.id);
      } catch (e) {
        outcome.failed.push({
          reference: detail.session.sourceRef ?? detail.session.title,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    this.#persist();
    return ok(outcome);
  }

  async updateSession(id: SessionId, patch: SessionPatch): Promise<Result<void>> {
    const detail = this.#details.get(id);
    if (!detail) return err(artixError('not-found', `Session ${id} is not in this library.`));

    const updated = applyPatch(detail.session, patch);
    const next: SessionDetail = { ...detail, session: updated };

    this.#sessions.set(id, updated);
    this.#details.set(id, next);
    this.#engine.indexDocument(buildDocument(next));
    this.#persist();
    return ok(undefined);
  }

  async deleteSessions(ids: SessionId[]): Promise<Result<number>> {
    let deleted = 0;
    for (const id of ids) {
      const detail = this.#details.get(id);
      if (!detail) continue;
      this.#hashes.delete(detail.session.contentHash);
      this.#details.delete(id);
      this.#sessions.delete(id);
      this.#engine.removeDocument(id);
      deleted++;
    }
    this.#links = this.#links.filter((l) => this.#sessions.has(l.fromId) && this.#sessions.has(l.toId));
    this.#persist();
    return ok(deleted);
  }

  async replaceLinks(links: SessionLink[]): Promise<Result<number>> {
    this.#links = links.filter((l) => this.#sessions.has(l.fromId) && this.#sessions.has(l.toId));
    return ok(this.#links.length);
  }

  /* -------------------------------------------------------- maintenance */

  async reindex(onProgress?: (done: number, total: number) => void): Promise<Result<number>> {
    this.#engine.index.clear();
    const total = this.#details.size;
    let done = 0;
    for (const detail of this.#details.values()) {
      this.#engine.indexDocument(buildDocument(detail));
      if (++done % 250 === 0) onProgress?.(done, total);
    }
    onProgress?.(total, total);
    return ok(total);
  }

  async vacuum(): Promise<Result<void>> {
    this.#engine.index.compact();
    return ok(undefined);
  }

  /* ------------------------------------------------------------ key/value */

  async kvGet(key: string): Promise<Result<string | null>> {
    try {
      return ok(globalThis.localStorage?.getItem(`artix:kv:${key}`) ?? null);
    } catch {
      return ok(null);
    }
  }

  async kvSet(key: string, value: string): Promise<Result<void>> {
    try {
      globalThis.localStorage?.setItem(`artix:kv:${key}`, value);
    } catch {
      // Private-browsing / quota: settings simply do not persist. Not fatal.
    }
    return ok(undefined);
  }

  async kvDelete(key: string): Promise<Result<void>> {
    try {
      globalThis.localStorage?.removeItem(`artix:kv:${key}`);
    } catch {
      /* see kvSet */
    }
    return ok(undefined);
  }

  /* ----------------------------------------------------------- filesystem */

  async discoverFiles(): Promise<Result<DiscoveredFile[]>> {
    return err(this.#noFilesystem());
  }

  async readTextFile(): Promise<Result<string>> {
    return err(this.#noFilesystem());
  }

  async writeTextFile(): Promise<Result<void>> {
    return err(this.#noFilesystem());
  }

  async writeZip(): Promise<Result<number>> {
    return err(this.#noFilesystem());
  }

  async readZip(): Promise<Result<[string, string][]>> {
    return err(this.#noFilesystem());
  }

  async revealPath(): Promise<Result<void>> {
    return err(this.#noFilesystem());
  }

  #noFilesystem() {
    return artixError('unsupported', 'Filesystem access needs the Artix desktop app.', {
      hint: 'Run `npm run dev:desktop` or install a release build.',
    });
  }

  /* --------------------------------------------------------------- internals */

  /** Existing record with the same `(source, sourceRef)` identity, if any. */
  #findBySourceRef(session: Session): SessionDetail | null {
    if (!session.sourceRef) return null;
    for (const detail of this.#details.values()) {
      if (detail.session.source === session.source && detail.session.sourceRef === session.sourceRef) {
        return detail;
      }
    }
    return null;
  }

  /**
   * Replace derived content while keeping identity and anything the user wrote.
   * Notes and pinned state must survive a re-sync.
   */
  #refresh(existing: SessionDetail, incoming: SessionDetail): void {
    const id = existing.session.id;
    this.#hashes.delete(existing.session.contentHash);

    const merged: SessionDetail = {
      session: {
        ...incoming.session,
        id,
        notes: existing.session.notes,
        pinned: existing.session.pinned,
      },
      messages: incoming.messages.map((m) => ({ ...m, sessionId: id })),
      artifacts: incoming.artifacts.map((a) => ({ ...a, sessionId: id })),
      files: incoming.files.map((f) => ({ ...f, sessionId: id })),
      links: existing.links,
    };

    this.#insert(merged);
  }

  #insert(detail: SessionDetail): void {
    this.#sessions.set(detail.session.id, detail.session);
    this.#details.set(detail.session.id, detail);
    this.#hashes.add(detail.session.contentHash);
    this.#engine.indexDocument(buildDocument(detail));
  }

  /**
   * Persist a *trimmed* copy: full transcripts blow the localStorage quota
   * instantly, so messages are dropped and rebuilt as empty on restore. The
   * galaxy, search over metadata, and all editing still work.
   */
  #persist(): void {
    if (!this.#options.persist) return;
    try {
      const payload = [...this.#details.values()].map((d) => ({
        ...d,
        messages: d.messages.slice(0, 40),
      }));
      const json = JSON.stringify(payload);
      if (json.length > PERSIST_LIMIT_BYTES) {
        globalThis.localStorage?.removeItem(PERSIST_KEY);
        return;
      }
      globalThis.localStorage?.setItem(PERSIST_KEY, json);
    } catch {
      // Quota or serialisation failure: the in-memory library is still correct.
    }
  }

  #restore(): SessionDetail[] | null {
    try {
      const raw = globalThis.localStorage?.getItem(PERSIST_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      return parsed as SessionDetail[];
    } catch {
      return null;
    }
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toBuckets(map: Map<string, number>): FacetBucket[] {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
