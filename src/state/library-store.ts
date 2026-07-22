/**
 * Library state.
 *
 * Holds the session list the galaxy renders, the active search, and the
 * currently open session. Deliberately one store: these three things change
 * together constantly, and splitting them would mean either duplicated
 * subscriptions or cross-store effects.
 *
 * The store never talks to SQLite directly — it goes through the injected
 * `StorageAdapter`, which is what makes the whole app testable headlessly.
 */

import { create } from 'zustand';

import { bus, notify } from '../core/events.ts';
import { emptyQuery } from '../core/types.ts';
import { parseQuery } from '../search/query-parser.ts';
import { deriveLinks } from '../core/session.ts';
import type {
  Facets,
  GalaxyNode,
  LibraryStats,
  SearchHit,
  SearchQuery,
  Session,
  SessionDetail,
  SessionId,
  SessionPatch,
} from '../core/types.ts';
import type { StorageAdapter } from '../storage/adapter.ts';

export interface LibraryState {
  /* ---- data ---- */
  storage: StorageAdapter | null;
  sessions: Session[];
  /** Projection uploaded to the renderer. Recomputed only when sessions change. */
  nodes: GalaxyNode[];
  facets: Facets | null;
  stats: LibraryStats | null;

  /* ---- status ---- */
  loading: boolean;
  error: string | null;
  /** True while a background job (import/reindex) is running. */
  busy: boolean;
  busyLabel: string;
  busyProgress: number;

  /* ---- search ---- */
  query: SearchQuery;
  rawQuery: string;
  hits: SearchHit[];
  /** Ids matching the current query, or null when no search is active. */
  highlighted: Set<SessionId> | null;
  searchElapsedMs: number;
  searchTotal: number;

  /* ---- selection ---- */
  selectedId: SessionId | null;
  openSession: SessionDetail | null;
  openLoading: boolean;

  /* ---- timeline ---- */
  timeFrom: number | null;
  timeTo: number | null;

  /* ---- actions ---- */
  attach: (storage: StorageAdapter) => Promise<void>;
  refresh: () => Promise<void>;
  setRawQuery: (raw: string) => void;
  runSearch: (raw?: string) => Promise<void>;
  clearSearch: () => void;
  select: (id: SessionId | null) => void;
  open: (id: SessionId) => Promise<void>;
  closeSession: () => void;
  patch: (id: SessionId, patch: SessionPatch) => Promise<void>;
  remove: (ids: SessionId[]) => Promise<void>;
  setTimeRange: (from: number | null, to: number | null) => void;
  rebuildLinks: () => Promise<void>;
}

/** Debounce handle for search-as-you-type. */
let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useLibrary = create<LibraryState>((set, get) => ({
  storage: null,
  sessions: [],
  nodes: [],
  facets: null,
  stats: null,

  loading: false,
  error: null,
  busy: false,
  busyLabel: '',
  busyProgress: 0,

  query: emptyQuery(),
  rawQuery: '',
  hits: [],
  highlighted: null,
  searchElapsedMs: 0,
  searchTotal: 0,

  selectedId: null,
  openSession: null,
  openLoading: false,

  timeFrom: null,
  timeTo: null,

  async attach(storage) {
    set({ storage, loading: true, error: null });

    const initialised = await storage.init();
    if (!initialised.ok) {
      set({ loading: false, error: initialised.error.message });
      return;
    }

    // Keep the store in sync with writes made anywhere in the app.
    bus.on('library:changed', () => {
      void get().refresh();
    });
    bus.on('job:progress', ({ label, done, total }) => {
      set({ busy: true, busyLabel: label, busyProgress: total > 0 ? done / total : 0 });
    });
    bus.on('job:finished', () => {
      set({ busy: false, busyLabel: '', busyProgress: 0 });
    });

    await get().refresh();
  },

  async refresh() {
    const { storage } = get();
    if (!storage) return;

    set({ loading: true, error: null });

    const [sessionsResult, facetsResult, statsResult] = await Promise.all([
      storage.listSessions({ includeArchived: true }),
      storage.facets(),
      storage.stats(),
    ]);

    if (!sessionsResult.ok) {
      set({ loading: false, error: sessionsResult.error.message });
      return;
    }

    const sessions = sessionsResult.value;
    set({
      sessions,
      nodes: sessions.map(toGalaxyNode),
      facets: facetsResult.ok ? facetsResult.value : null,
      stats: statsResult.ok ? statsResult.value : null,
      loading: false,
    });

    // A refresh can invalidate the open session (deleted elsewhere).
    const { openSession } = get();
    if (openSession && !sessions.some((s) => s.id === openSession.session.id)) {
      set({ openSession: null, selectedId: null });
    }

    // Re-run any active search against the new data.
    if (get().rawQuery.trim().length > 0) await get().runSearch();
  },

  setRawQuery(raw) {
    set({ rawQuery: raw });

    // Debounced so every keystroke does not hit storage, but short enough that
    // the galaxy still feels like it is reacting live.
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void get().runSearch(raw);
    }, 90);
  },

  async runSearch(raw) {
    const { storage } = get();
    if (!storage) return;

    const text = raw ?? get().rawQuery;
    if (text.trim().length === 0) {
      get().clearSearch();
      return;
    }

    const parsed = parseQuery(text, {
      includeArchived: true,
      range: { from: get().timeFrom, to: get().timeTo },
    });

    const result = await storage.search(parsed);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }

    set({
      query: parsed,
      hits: result.value.hits,
      highlighted: new Set(result.value.hits.map((hit) => hit.session.id)),
      searchElapsedMs: result.value.elapsedMs,
      searchTotal: result.value.total,
    });
  },

  clearSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    set({
      rawQuery: '',
      query: emptyQuery(),
      hits: [],
      highlighted: null,
      searchElapsedMs: 0,
      searchTotal: 0,
    });
  },

  select(id) {
    set({ selectedId: id });
    bus.emit('selection:changed', { id });
  },

  async open(id) {
    const { storage } = get();
    if (!storage) return;

    set({ openLoading: true, selectedId: id });

    const detail = await storage.getSession(id);
    if (!detail.ok) {
      set({ openLoading: false, error: detail.error.message });
      notify('error', detail.error.message);
      return;
    }

    set({ openSession: detail.value, openLoading: false });
  },

  closeSession() {
    set({ openSession: null });
  },

  async patch(id, patch) {
    const { storage } = get();
    if (!storage) return;

    const result = await storage.updateSession(id, patch);
    if (!result.ok) {
      notify('error', result.error.message);
      return;
    }

    // Patch locally so the UI updates immediately, then reconcile in the
    // background. A full refresh here would rebuild the whole galaxy for a
    // one-character title edit.
    set((state) => {
      const sessions = state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
      return {
        sessions,
        nodes: sessions.map(toGalaxyNode),
        openSession:
          state.openSession?.session.id === id
            ? { ...state.openSession, session: { ...state.openSession.session, ...patch } }
            : state.openSession,
      };
    });
  },

  async remove(ids) {
    const { storage } = get();
    if (!storage || ids.length === 0) return;

    const result = await storage.deleteSessions(ids);
    if (!result.ok) {
      notify('error', result.error.message);
      return;
    }

    notify('success', `Deleted ${result.value} session${result.value === 1 ? '' : 's'}.`);
    bus.emit('library:changed', { reason: 'delete', ids });
  },

  setTimeRange(from, to) {
    set({ timeFrom: from, timeTo: to });
    if (get().rawQuery.trim().length > 0) void get().runSearch();
  },

  /**
   * Recompute the knowledge graph.
   *
   * Needs each session's file paths, which the galaxy projection does not
   * carry, so this loads details in batches. Explicitly user-triggered rather
   * than automatic — on a large library it is genuinely expensive.
   */
  async rebuildLinks() {
    const { storage, sessions } = get();
    if (!storage) return;

    set({ busy: true, busyLabel: 'Rebuilding relationships', busyProgress: 0 });

    const inputs = [];
    for (const [index, session] of sessions.entries()) {
      const detail = await storage.getSession(session.id);
      inputs.push({
        id: session.id,
        project: session.project,
        folder: session.folder,
        technologies: session.technologies,
        filePaths: detail.ok ? detail.value.files.map((f) => f.path) : [],
        startedAt: session.startedAt,
      });

      if (index % 50 === 0) {
        set({ busyProgress: index / Math.max(1, sessions.length) });
        await Promise.resolve();
      }
    }

    const links = deriveLinks(inputs);
    await storage.replaceLinks(links);

    set({ busy: false, busyLabel: '', busyProgress: 0 });
    notify('success', `Derived ${links.length} relationships.`);
  },
}));

/** Strip a session down to what the renderer needs. */
function toGalaxyNode(session: Session): GalaxyNode {
  return {
    id: session.id,
    title: session.title,
    project: session.project,
    language: session.language,
    status: session.status,
    kind: session.kind,
    startedAt: session.startedAt,
    complexity: session.complexity,
    importance: session.importance,
    pinned: session.pinned,
    technologies: session.technologies,
  };
}
