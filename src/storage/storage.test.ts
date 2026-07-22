/**
 * Storage adapter conformance.
 *
 * These tests define the contract that `TauriStorageAdapter` must also satisfy.
 * The in-memory adapter is the executable specification.
 */

import { describe, expect, it } from 'vitest';

import { buildSession } from '../core/session.ts';
import { DAY } from '../core/time.ts';
import { parseQuery } from '../search/query-parser.ts';
import { MemoryStorageAdapter } from './memory-adapter.ts';
import { generateDemoLibrary } from './demo-library.ts';
import { DEFAULT_SETTINGS, mergeSettings, resolveQuality } from './settings.ts';
import type { SessionDetail, SessionId } from '../core/types.ts';

const NOW = Date.UTC(2026, 6, 22);

function make(title: string, overrides: Parameters<typeof buildSession>[0] extends never ? never : Partial<Parameters<typeof buildSession>[0]> = {}): SessionDetail {
  return buildSession(
    {
      title,
      project: 'artix',
      source: 'test',
      startedAt: NOW - DAY,
      messages: [
        { seq: 0, role: 'user', content: `about ${title}`, createdAt: NOW - DAY, tokenEstimate: 0, toolName: null },
      ],
      ...overrides,
    },
    NOW,
  );
}

async function seeded(details: SessionDetail[]): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter();
  await storage.init();
  await storage.saveSessions(details);
  return storage;
}

describe('memory storage adapter', () => {
  it('reports its capabilities honestly', () => {
    const storage = new MemoryStorageAdapter();
    expect(storage.capabilities.filesystem).toBe(false);
    expect(storage.capabilities.fullTextSearch).toBe(false);
  });

  it('stores and reads back a session', async () => {
    const detail = make('Fix auth');
    const storage = await seeded([detail]);

    const loaded = await storage.getSession(detail.session.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.session.title).toBe('Fix auth');
      expect(loaded.value.messages).toHaveLength(1);
    }
  });

  it('returns not-found for an unknown id', async () => {
    const storage = await seeded([]);
    const result = await storage.getSession('nope' as SessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('rejects a duplicate content hash', async () => {
    const detail = make('Duplicate me');
    const storage = await seeded([detail]);

    // A second build of the same draft has a different id but the same hash.
    const again = make('Duplicate me');
    const result = await storage.saveSession(again);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('duplicate');
  });

  it('reports duplicates in bulk without failing the batch', async () => {
    const storage = await seeded([make('A')]);
    const result = await storage.saveSessions([make('A'), make('B')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.imported).toHaveLength(1);
      expect(result.value.duplicates).toHaveLength(1);
    }
  });

  it('orders sessions newest first', async () => {
    const storage = await seeded([
      make('old', { startedAt: NOW - 30 * DAY }),
      make('new', { startedAt: NOW - DAY }),
      make('middle', { startedAt: NOW - 10 * DAY }),
    ]);
    const list = await storage.listSessions();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value.map((s) => s.title)).toEqual(['new', 'middle', 'old']);
  });

  it('hides archived sessions unless asked', async () => {
    const storage = await seeded([make('live'), make('gone', { status: 'archived' })]);

    const defaults = await storage.listSessions();
    if (defaults.ok) expect(defaults.value.map((s) => s.title)).toEqual(['live']);

    const all = await storage.listSessions({ includeArchived: true });
    if (all.ok) expect(all.value).toHaveLength(2);
  });

  it('updates a session and keeps derived fields consistent', async () => {
    const detail = make('Editable');
    const storage = await seeded([detail]);

    await storage.updateSession(detail.session.id, { title: 'Renamed', status: 'archived' });

    const loaded = await storage.getSession(detail.session.id);
    if (loaded.ok) {
      expect(loaded.value.session.title).toBe('Renamed');
      // `archived` must re-derive the celestial kind.
      expect(loaded.value.session.kind).toBe('asteroid');
    }
  });

  it('makes an edited session findable by its new title', async () => {
    const detail = make('Before');
    const storage = await seeded([detail]);

    await storage.updateSession(detail.session.id, { title: 'Zephyr protocol' });

    const found = await storage.search(parseQuery('zephyr', {}, NOW));
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.hits.map((h) => h.session.id)).toContain(detail.session.id);
  });

  it('deletes sessions and drops them from the index', async () => {
    const detail = make('Ephemeral');
    const storage = await seeded([detail]);

    const deleted = await storage.deleteSessions([detail.session.id]);
    expect(deleted.ok && deleted.value).toBe(1);

    const found = await storage.search(parseQuery('ephemeral', {}, NOW));
    if (found.ok) expect(found.value.hits).toHaveLength(0);

    // Deleting frees the hash, so the same content can be re-imported.
    const reimport = await storage.saveSession(make('Ephemeral'));
    expect(reimport.ok).toBe(true);
  });

  it('computes facets', async () => {
    const storage = await seeded([
      make('a', { language: 'rust', tags: ['infra'] }),
      make('b', { language: 'rust', project: 'orbital' }),
      make('c', { language: 'typescript' }),
    ]);

    const facets = await storage.facets();
    expect(facets.ok).toBe(true);
    if (facets.ok) {
      expect(facets.value.languages[0]).toEqual({ value: 'rust', count: 2 });
      expect(facets.value.projects.map((p) => p.value)).toContain('orbital');
      expect(facets.value.tags).toContainEqual({ value: 'infra', count: 1 });
    }
  });

  it('aggregates library statistics', async () => {
    const storage = await seeded([make('a'), make('b', { project: 'orbital' })]);
    const stats = await storage.stats();
    expect(stats.ok).toBe(true);
    if (stats.ok) {
      expect(stats.value.sessionCount).toBe(2);
      expect(stats.value.projectCount).toBe(2);
      expect(stats.value.messageCount).toBe(2);
      expect(stats.value.tokenEstimate).toBeGreaterThan(0);
    }
  });

  it('exposes known hashes so importers can skip work', async () => {
    const detail = make('Hashed');
    const storage = await seeded([detail]);
    const hashes = await storage.knownHashes();
    expect(hashes.ok && hashes.value.has(detail.session.contentHash)).toBe(true);
  });

  it('finds sessions that touched a path', async () => {
    const detail = make('Touched', {
      files: [{ path: 'src/loop.ts', action: 'modified', language: 'typescript', bytes: 10, snippet: null }],
    });
    const storage = await seeded([detail]);
    const found = await storage.sessionsForPath('src/loop.ts');
    expect(found.ok && found.value).toEqual([detail.session.id]);
  });

  it('rebuilds the index without losing anything', async () => {
    const storage = await seeded([make('Reindexable')]);
    const result = await storage.reindex();
    expect(result.ok && result.value).toBe(1);

    const found = await storage.search(parseQuery('reindexable', {}, NOW));
    if (found.ok) expect(found.value.hits).toHaveLength(1);
  });

  it('refuses filesystem operations with a clear error', async () => {
    const storage = await seeded([]);
    const result = await storage.readTextFile();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported');
      expect(result.error.hint).toContain('desktop');
    }
  });
});

/* ------------------------------------------------------------ demo data */

describe('demo library', () => {
  it('is deterministic for a given seed', () => {
    const a = generateDemoLibrary({ count: 25, seed: 'fixed', now: NOW });
    const b = generateDemoLibrary({ count: 25, seed: 'fixed', now: NOW });
    expect(a.map((d) => d.session.contentHash)).toEqual(b.map((d) => d.session.contentHash));
  });

  it('produces distinct sessions', () => {
    const library = generateDemoLibrary({ count: 120, seed: 'x', now: NOW });
    const hashes = new Set(library.map((d) => d.session.contentHash));
    // A few natural collisions are fine; wholesale duplication is not.
    expect(hashes.size).toBeGreaterThan(100);
  });

  it('spreads sessions across projects and time', () => {
    const library = generateDemoLibrary({ count: 200, seed: 'x', now: NOW, spanDays: 365 });
    const projects = new Set(library.map((d) => d.session.project));
    expect(projects.size).toBeGreaterThan(4);

    const times = library.map((d) => d.session.startedAt);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(NOW - 366 * DAY);
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW);
  });

  it('can generate a large library quickly without message bodies', () => {
    const started = performance.now();
    const library = generateDemoLibrary({ count: 5000, seed: 'bench', now: NOW, withMessages: false });
    expect(library).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(8000);
  });
});

/* ------------------------------------------------------------- settings */

describe('settings', () => {
  it('fills in defaults for a partial document', () => {
    const merged = mergeSettings({ theme: 'void', galaxy: { bloom: false } });
    expect(merged.theme).toBe('void');
    expect(merged.galaxy.bloom).toBe(false);
    // Unspecified nested keys keep their defaults.
    expect(merged.galaxy.nebula).toBe(DEFAULT_SETTINGS.galaxy.nebula);
    expect(merged.import.extensions).toEqual(DEFAULT_SETTINGS.import.extensions);
  });

  it('survives corrupt input', () => {
    expect(mergeSettings(null).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(mergeSettings('nonsense').galaxy.quality).toBe('auto');
  });

  it('resolves automatic quality from device hints', () => {
    expect(resolveQuality(DEFAULT_SETTINGS.galaxy, { deviceMemoryGb: 4, nodeCount: 100 }).tier).toBe('low');
    expect(resolveQuality(DEFAULT_SETTINGS.galaxy, { deviceMemoryGb: 32, nodeCount: 100 }).tier).toBe('ultra');
    expect(resolveQuality(DEFAULT_SETTINGS.galaxy, { deviceMemoryGb: 32, nodeCount: 250_000 }).tier).toBe('low');
  });

  it('honours reduced motion', () => {
    const resolved = resolveQuality(DEFAULT_SETTINGS.galaxy, { nodeCount: 10, reducedMotion: true });
    expect(resolved.motion).toBe(false);
  });

  it('respects an explicit quality override', () => {
    const settings = { ...DEFAULT_SETTINGS.galaxy, quality: 'high' as const };
    expect(resolveQuality(settings, { deviceMemoryGb: 2, nodeCount: 1_000_000 }).tier).toBe('high');
  });
});
