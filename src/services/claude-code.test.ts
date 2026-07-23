import { describe, expect, it } from 'vitest';

import {
  decodeProjectDir,
  describeScan,
  importClaudeSessions,
  projectHintFromDir,
} from './claude-code.ts';
import type { DiscoveredSession } from './claude-code.ts';
import type { StorageAdapter } from '../storage/adapter.ts';
import type { ImportSource } from '../importers/types.ts';
import { ok } from '../core/result.ts';

describe('Claude Code project directory decoding', () => {
  it('reverses the Windows encoding', () => {
    expect(decodeProjectDir('C--Users-dev-Projects-Artix')).toBe(
      'C:\\Users\\dev\\Projects\\Artix',
    );
  });

  it('reverses a POSIX encoding', () => {
    expect(decodeProjectDir('-home-dev-projects-artix')).toBe('/home/dev/projects/artix');
  });

  it('extracts a readable project label', () => {
    expect(projectHintFromDir('C--Users-dev-Projects-Artix')).toBe('Artix');
    expect(projectHintFromDir('-home-dev-artix')).toBe('artix');
  });

  /**
   * The encoding is lossy: `:` and the separator both become `-`, so a folder
   * whose real name contains a hyphen cannot be recovered. This documents the
   * limitation rather than pretending it round-trips — the importer relies on
   * the `cwd` field inside the transcript instead.
   */
  it('is ambiguous for hyphenated folder names, hence cwd is authoritative', () => {
    const decoded = decodeProjectDir('C--Users-me-Desktop-game-ni-mark');
    expect(decoded).toBe('C:\\Users\\me\\Desktop\\game\\ni\\mark');
    // The true folder was `game-ni-mark`; the hint is wrong, which is exactly
    // why it is only ever a fallback.
    expect(projectHintFromDir('C--Users-me-Desktop-game-ni-mark')).toBe('mark');
  });
});

describe('scan description', () => {
  const session = (project: string, bytes: number): DiscoveredSession => ({
    path: `/x/${project}/a.jsonl`,
    id: 'a',
    projectHint: project,
    bytes,
    modifiedAt: 0,
    subagentPaths: [],
  });

  it('summarises count, projects and size', () => {
    const text = describeScan([
      session('artix', 1_048_576),
      session('artix', 1_048_576),
      session('orbital', 2_097_152),
    ]);
    expect(text).toContain('3 transcripts');
    expect(text).toContain('2 projects');
    expect(text).toContain('4.0 MB');
  });

  it('uses singular forms for one of each', () => {
    expect(describeScan([session('artix', 1024)])).toContain('1 transcript across 1 project');
  });

  it('handles an empty scan', () => {
    expect(describeScan([])).toBe('No Claude Code transcripts found.');
  });
});

describe('batched import', () => {
  /** A discovered session whose "transcript" is just its id, for accounting. */
  const session = (id: string): DiscoveredSession => ({
    path: `/x/${id}.jsonl`,
    id,
    projectHint: 'proj',
    bytes: 1000,
    modifiedAt: 0,
    subagentPaths: [],
  });

  /**
   * A storage stub that records the high-water mark of transcripts held in
   * memory simultaneously. The whole point of batching is that this never
   * reaches the total.
   */
  function trackingStorage(liveRef: { current: number; peak: number }): StorageAdapter {
    return {
      capabilities: { filesystem: true, fullTextSearch: false, persistent: true, label: 't' },
      async readTextFile(path: string) {
        liveRef.current++;
        liveRef.peak = Math.max(liveRef.peak, liveRef.current);
        return ok(`content for ${path}`);
      },
    } as unknown as StorageAdapter;
  }

  it('never holds more than one batch of transcripts at once', async () => {
    const sessions = Array.from({ length: 100 }, (_, i) => session(`s${i}`));
    const live = { current: 0, peak: 0 };
    const storage = trackingStorage(live);

    const batchSizes: number[] = [];
    // Each runImport call releases the batch it was given.
    const runImport = async (sources: ImportSource[]) => {
      batchSizes.push(sources.length);
      live.current -= sources.length; // the batch is now consumed and freed
      return { imported: sources.map((s) => s.reference), updated: [], duplicates: [], failed: [] };
    };

    const result = await importClaudeSessions(storage, sessions, runImport, { batchSize: 20 });

    expect(result.imported).toBe(100);
    // Peak in-memory transcripts must be one batch, not all 100.
    expect(live.peak).toBeLessThanOrEqual(20);
    expect(batchSizes).toEqual([20, 20, 20, 20, 20]);
  });

  it('reports progress across every file, not just every batch', async () => {
    const sessions = Array.from({ length: 45 }, (_, i) => session(`s${i}`));
    const live = { current: 0, peak: 0 };
    const runImport = async (sources: ImportSource[]) => {
      live.current -= sources.length;
      return { imported: sources, updated: [], duplicates: [], failed: [] };
    };

    const seen: number[] = [];
    await importClaudeSessions(trackingStorage(live), sessions, runImport, {
      batchSize: 20,
      onProgress: (done) => seen.push(done),
    });

    // Monotonic, one tick per file, ending exactly at the total.
    expect(seen).toHaveLength(45);
    expect(seen[seen.length - 1]).toBe(45);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('aggregates imported / updated / unchanged / failed across batches', async () => {
    const sessions = Array.from({ length: 6 }, (_, i) => session(`s${i}`));
    const runImport = async (sources: ImportSource[]) => ({
      imported: [sources[0]!.reference],
      updated: [sources[1]?.reference].filter(Boolean),
      duplicates: [sources[2]?.reference].filter(Boolean),
      failed: [],
    });

    const live = { current: 0, peak: 0 };
    const result = await importClaudeSessions(trackingStorage(live), sessions, runImport, {
      batchSize: 3,
    });

    // Two batches of 3, each yielding 1 imported / 1 updated / 1 unchanged.
    expect(result).toEqual({ imported: 2, updated: 2, unchanged: 2, failed: 0 });
  });

  it('counts unreadable transcripts as failures without aborting', async () => {
    const sessions = [session('good'), session('bad'), session('good2')];
    const storage = {
      capabilities: { filesystem: true, fullTextSearch: false, persistent: true, label: 't' },
      async readTextFile(path: string) {
        return path.includes('bad') ? { ok: false as const, error: { code: 'io' as const, message: 'nope' } } : ok('data');
      },
    } as unknown as StorageAdapter;

    const runImport = async (sources: ImportSource[]) => ({
      imported: sources.map((s) => s.reference),
      updated: [],
      duplicates: [],
      failed: [],
    });

    const result = await importClaudeSessions(storage, sessions, runImport, { batchSize: 20 });
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(1);
  });
});
