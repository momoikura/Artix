import { describe, expect, it } from 'vitest';

import { syncWatchedFolders } from './folder-sync.ts';
import { ok } from '../core/result.ts';
import type { StorageAdapter } from '../storage/adapter.ts';
import type { ImportSource } from '../importers/types.ts';

/** In-memory storage stub: a virtual folder of files, plus a kv store. */
function makeStorage(files: { path: string; name: string; content: string; modifiedAt: number }[]) {
  const kv = new Map<string, string>();
  return {
    adapter: {
      capabilities: { filesystem: true, fullTextSearch: false, persistent: true, label: 't' },
      async discoverFiles(_root: string, _ext: string[]) {
        return ok(files.map((f) => ({ path: f.path, name: f.name, bytes: f.content.length, modifiedAt: f.modifiedAt })));
      },
      async readTextFile(path: string) {
        const f = files.find((x) => x.path === path);
        return f ? ok(f.content) : { ok: false as const, error: { code: 'io' as const, message: 'missing' } };
      },
      async kvGet(key: string) {
        return ok(kv.get(key) ?? null);
      },
      async kvSet(key: string, value: string) {
        kv.set(key, value);
        return ok(undefined);
      },
    } as unknown as StorageAdapter,
    kv,
  };
}

describe('watched-folder sync', () => {
  const chatgpt = JSON.stringify([
    {
      title: 'From ChatGPT', create_time: 1_700_000_000, conversation_id: 'c1',
      mapping: {
        r: { id: 'r', message: null, parent: null, children: ['u'] },
        u: { id: 'u', parent: 'r', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hello from chatgpt'] } } },
      },
    },
  ]);
  const markdown = '---\ntitle: From a website\n---\n\n## User\nhi\n\n## Assistant\nhello';

  it('imports files of mixed formats, detecting each', async () => {
    const { adapter } = makeStorage([
      { path: '/dl/conversations.json', name: 'conversations.json', content: chatgpt, modifiedAt: 1000 },
      { path: '/dl/notes.md', name: 'notes.md', content: markdown, modifiedAt: 1000 },
    ]);

    const runs: { sourceName: string }[] = [];
    const runImport = async (sources: ImportSource[]) => {
      runs.push(...sources.map((s) => ({ sourceName: s.name })));
      return { imported: sources.map((s) => s.reference), updated: [], duplicates: [], failed: [] };
    };

    const result = await syncWatchedFolders(adapter, ['/dl'], runImport);
    expect(result.imported).toBe(2);
    // Real filenames are preserved — importers rely on them for detection.
    expect(runs.map((r) => r.sourceName).sort()).toEqual(['conversations.json', 'notes.md']);
  });

  it('is incremental: only files newer than the watermark are re-read', async () => {
    const store = makeStorage([
      { path: '/dl/old.json', name: 'old.json', content: chatgpt, modifiedAt: 1000 },
      { path: '/dl/new.json', name: 'new.json', content: chatgpt, modifiedAt: 500_000 },
    ]);
    // Watermark 160_000: after subtracting the 60s overlap the threshold is
    // 100_000 — above the old file (1_000), below the new one (500_000).
    store.kv.set('folders:lastSyncAt', String(160_000));

    const read: string[] = [];
    const runImport = async (sources: ImportSource[]) => {
      read.push(...sources.map((s) => s.name));
      return { imported: sources.map((s) => s.reference), updated: [], duplicates: [], failed: [] };
    };

    const result = await syncWatchedFolders(store.adapter, ['/dl'], runImport);
    expect(read).toEqual(['new.json']);
    expect(result.imported).toBe(1);
  });

  it('advances the watermark even when nothing changed', async () => {
    const store = makeStorage([{ path: '/dl/x.json', name: 'x.json', content: chatgpt, modifiedAt: 1000 }]);
    store.kv.set('folders:lastSyncAt', String(1_000_000_000_000));

    await syncWatchedFolders(store.adapter, ['/dl'], async () => ({
      imported: [], updated: [], duplicates: [], failed: [],
    }));
    expect(Number(store.kv.get('folders:lastSyncAt'))).toBeGreaterThan(1_000_000_000_000);
  });

  it('does nothing when no folders are configured', async () => {
    const { adapter } = makeStorage([]);
    const result = await syncWatchedFolders(adapter, [], async () => ({
      imported: [], updated: [], duplicates: [], failed: [],
    }));
    expect(result).toEqual({ scanned: 0, imported: 0, updated: 0, unchanged: 0, failed: 0 });
  });
});
