import { describe, expect, it } from 'vitest';

import { classifyCelestial, computeComplexity, computeImportance, nodeRadius } from './celestial.ts';
import { contentHash, hash32, rand01, randGaussian } from './hash.ts';
import { isId, newId, slug } from './id.ts';
import { canonicalLanguageId, dominantLanguage, languageFromPath, resolveLanguage } from './languages.ts';
import {
  detectTechnologies,
  estimateTokens,
  extractCodeBlocks,
  extractDecisions,
  extractFilePaths,
  extractFromMessages,
  extractTodos,
  summarise,
} from './extract.ts';
import { applyPatch, buildSession, computeSessionHash, deriveLinks } from './session.ts';
import { formatDuration, histogram, parseTimestamp } from './time.ts';
import { DAY } from './time.ts';
import type { SessionDraft } from './types.ts';

const NOW = Date.UTC(2026, 6, 22);

/* ------------------------------------------------------------------ hash */

describe('hash', () => {
  it('is deterministic across calls', () => {
    expect(hash32('artix')).toBe(hash32('artix'));
    expect(rand01('session-1', 3)).toBe(rand01('session-1', 3));
  });

  it('separates channels', () => {
    expect(rand01('x', 0)).not.toBe(rand01('x', 1));
  });

  it('produces values inside the unit interval', () => {
    for (let i = 0; i < 500; i++) {
      const v = rand01(`k${i}`, i % 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('keeps gaussian scatter roughly centred', () => {
    let sum = 0;
    for (let i = 0; i < 2000; i++) sum += randGaussian(`g${i}`, 1);
    expect(Math.abs(sum / 2000)).toBeLessThan(0.05);
  });

  it('produces a 32-char content hash that changes with content', () => {
    const a = contentHash('title', 'project', 1000);
    const b = contentHash('title', 'project', 1001);
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

/* -------------------------------------------------------------------- id */

describe('id', () => {
  it('mints sortable, unique ids', () => {
    const ids = Array.from({ length: 200 }, () => newId(NOW));
    expect(new Set(ids).size).toBe(200);
    // Same millisecond: the monotonic counter must keep them ascending.
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every(isId)).toBe(true);
  });

  it('orders ids by time', () => {
    expect(newId(NOW) < newId(NOW + 1000)).toBe(true);
  });

  it('slugs unicode and punctuation', () => {
    expect(slug('  Héllo Wörld!  ')).toBe('hello-world');
    expect(slug('C++')).toBe('c++');
    expect(slug('Three.js')).toBe('three.js');
  });
});

/* -------------------------------------------------------------- languages */

describe('languages', () => {
  it('resolves aliases and labels', () => {
    expect(canonicalLanguageId('TS')).toBe('typescript');
    expect(canonicalLanguageId('golang')).toBe('go');
    expect(canonicalLanguageId('nonsense')).toBeNull();
    expect(resolveLanguage('rust').label).toBe('Rust');
  });

  it('infers language from paths, including extensionless files', () => {
    expect(languageFromPath('src/main.rs').id).toBe('rust');
    expect(languageFromPath('a/b/Dockerfile').id).toBe('docker');
    expect(languageFromPath('notes').id).toBe('unknown');
  });

  it('picks the dominant language deterministically', () => {
    expect(dominantLanguage(['a.ts', 'b.ts', 'c.py'])).toBe('typescript');
    expect(dominantLanguage([])).toBeNull();
  });
});

/* -------------------------------------------------------------- celestial */

describe('celestial classification', () => {
  it('scores complexity monotonically and stays in range', () => {
    const small = computeComplexity({ messageCount: 3, fileCount: 1, artifactCount: 0, startedAt: 0, endedAt: 60_000 });
    const big = computeComplexity({ messageCount: 300, fileCount: 90, artifactCount: 60, startedAt: 0, endedAt: 6 * 3600_000 });
    expect(small).toBeLessThan(big);
    expect(small).toBeGreaterThanOrEqual(0);
    expect(big).toBeLessThanOrEqual(1);
  });

  it('decays importance with age', () => {
    const base = { complexity: 0.5, pinned: false, status: 'completed' as const, now: NOW };
    const fresh = computeImportance({ ...base, startedAt: NOW });
    const old = computeImportance({ ...base, startedAt: NOW - 400 * DAY });
    expect(fresh).toBeGreaterThan(old);
  });

  it('gives pinned sessions a brightness floor', () => {
    const ancient = { complexity: 0.05, startedAt: NOW - 2000 * DAY, status: 'completed' as const, now: NOW };
    expect(computeImportance({ ...ancient, pinned: false })).toBeLessThan(0.3);
    expect(computeImportance({ ...ancient, pinned: true })).toBeGreaterThanOrEqual(0.75);
  });

  it('always renders archived work as debris', () => {
    expect(classifyCelestial(0.99, 'archived')).toBe('asteroid');
    expect(classifyCelestial(0.99, 'active')).toBe('star');
    expect(classifyCelestial(0.3, 'active')).toBe('planet');
    expect(classifyCelestial(0.05, 'active')).toBe('asteroid');
  });

  it('scales radius with complexity', () => {
    expect(nodeRadius('star', 1)).toBeGreaterThan(nodeRadius('star', 0));
    expect(nodeRadius('star', 0.5)).toBeGreaterThan(nodeRadius('asteroid', 0.5));
  });
});

/* ----------------------------------------------------------------- time */

describe('time', () => {
  it('parses seconds, milliseconds, ISO strings and Dates', () => {
    expect(parseTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseTimestamp('2026-07-22T00:00:00Z')).toBe(NOW);
    expect(parseTimestamp(new Date(NOW))).toBe(NOW);
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });

  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(3 * 60_000 + 2000)).toBe('3m 02s');
    expect(formatDuration(3600_000 + 24 * 60_000)).toBe('1h 24m');
  });

  it('buckets timestamps into a histogram', () => {
    const bins = histogram([0, 5, 9], 0, 10, 5);
    expect(bins).toHaveLength(5);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

/* -------------------------------------------------------------- extract */

describe('extraction', () => {
  it('parses fenced code blocks including nested fences', () => {
    const text = [
      'Here you go:',
      '````md',
      'Some markdown with a nested fence:',
      '```ts',
      'const a = 1;',
      '```',
      '````',
    ].join('\n');

    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('markdown');
    expect(blocks[0]!.content).toContain('const a = 1;');
  });

  it('reads a path hint from the fence info string', () => {
    const blocks = extractCodeBlocks('```ts src/core/foo.ts\nexport {};\n```');
    expect(blocks[0]!.path).toBe('src/core/foo.ts');
  });

  it('extracts file paths without matching prose or versions', () => {
    const paths = extractFilePaths(
      'Edit `src/core/foo.ts` and ./scripts/run.sh, but not e.g. or 2.14.3 or plain words.',
    );
    expect(paths).toContain('src/core/foo.ts');
    expect(paths).toContain('./scripts/run.sh');
    expect(paths).not.toContain('2.14.3');
    expect(paths.some((p) => p === 'e.g')).toBe(false);
  });

  it('extracts checkbox and marker todos', () => {
    const todos = extractTodos('- [x] done thing\n- [ ] open thing\nTODO: another thing');
    expect(todos).toEqual([
      { text: 'done thing', done: true },
      { text: 'open thing', done: false },
      { text: 'another thing', done: false },
    ]);
  });

  it('finds decision-shaped sentences and ignores code spans', () => {
    const decisions = extractDecisions(
      "We decided to use a single writer connection because WAL serialises writes anyway. `let x = because;`",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain('decided to use');
  });

  it('detects technologies on word boundaries only', () => {
    expect(detectTechnologies('Built with React and Tauri over SQLite.')).toEqual(
      expect.arrayContaining(['React', 'Tauri', 'SQLite']),
    );
    // "reactive" must not match "react".
    expect(detectTechnologies('a reactive stream')).not.toContain('React');
  });

  it('summarises without cutting mid-word', () => {
    const long = `${'word '.repeat(200)}`;
    const short = summarise(long, 50);
    expect(short.length).toBeLessThanOrEqual(51);
    expect(short.endsWith('…')).toBe(true);
  });

  it('estimates tokens proportionally', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(370))).toBeCloseTo(100, 0);
  });

  it('assembles artifacts, files and technologies from messages', () => {
    const result = extractFromMessages([
      { role: 'user', seq: 0, content: 'Please update `src/app.ts` using React.' },
      {
        role: 'assistant',
        seq: 1,
        content:
          "I'll use a reducer because it keeps the state transitions explicit.\n\n" +
          '```ts src/app.ts\nexport const x = 1;\n```\n\n- [ ] add tests',
      },
    ]);

    expect(result.language).toBe('typescript');
    expect(result.technologies).toContain('React');
    expect(result.files.map((f) => f.path)).toContain('src/app.ts');
    expect(result.artifacts.some((a) => a.kind === 'code')).toBe(true);
    expect(result.artifacts.some((a) => a.kind === 'todo')).toBe(true);
    expect(result.artifacts.some((a) => a.kind === 'decision')).toBe(true);
    // The file was written, not merely mentioned.
    expect(result.files.find((f) => f.path === 'src/app.ts')?.action).toBe('created');
  });
});

/* -------------------------------------------------------------- session */

function draft(overrides: Partial<SessionDraft> = {}): SessionDraft {
  return {
    title: 'Fix the render loop',
    project: 'artix',
    source: 'test',
    startedAt: NOW - DAY,
    messages: [
      { seq: 0, role: 'user', content: 'The loop stutters.', createdAt: NOW - DAY, tokenEstimate: 0, toolName: null },
      { seq: 1, role: 'assistant', content: 'Clamping dt fixes it.', createdAt: NOW - DAY + 5000, tokenEstimate: 0, toolName: null },
    ],
    ...overrides,
  };
}

describe('session assembly', () => {
  it('derives counters, ids and celestial fields', () => {
    const detail = buildSession(draft(), NOW);
    expect(detail.session.messageCount).toBe(2);
    expect(detail.session.tokenEstimate).toBeGreaterThan(0);
    expect(detail.session.complexity).toBeGreaterThan(0);
    expect(detail.messages.every((m) => m.sessionId === detail.session.id)).toBe(true);
    expect(detail.session.endedAt).toBe(NOW - DAY + 5000);
  });

  it('normalises tags and technologies', () => {
    const detail = buildSession(
      draft({ tags: ['  Infra ', 'infra', '', 'Search'], technologies: ['React', 'react'] }),
      NOW,
    );
    expect(detail.session.tags).toEqual(['infra', 'search']);
    expect(detail.session.technologies).toEqual(['React']);
  });

  it('hashes content identically regardless of import time', () => {
    const a = buildSession(draft(), NOW);
    const b = buildSession(draft(), NOW + 100_000);
    expect(a.session.contentHash).toBe(b.session.contentHash);
    expect(a.session.id).not.toBe(b.session.id);
  });

  it('changes the hash when content changes', () => {
    const base = computeSessionHash(draft(), draft().messages!);
    const changed = computeSessionHash(draft({ title: 'Other' }), draft().messages!);
    expect(base).not.toBe(changed);
  });

  it('recomputes derived fields when patched', () => {
    const detail = buildSession(draft(), NOW);
    const archived = applyPatch(detail.session, { status: 'archived' }, NOW);
    expect(archived.kind).toBe('asteroid');
    expect(archived.importance).toBeLessThan(detail.session.importance);
  });
});

describe('link derivation', () => {
  const inputs = [
    { id: 'a', project: 'artix', folder: null, technologies: ['React'], filePaths: ['src/a.ts', 'src/b.ts'], startedAt: NOW },
    { id: 'b', project: 'artix', folder: null, technologies: ['React'], filePaths: ['src/a.ts', 'src/b.ts'], startedAt: NOW - DAY },
    { id: 'c', project: 'other', folder: null, technologies: ['Go'], filePaths: ['main.go'], startedAt: NOW - 2 * DAY },
  ];

  it('links sessions that share files', () => {
    const links = deriveLinks(inputs);
    expect(links.some((l) => l.kind === 'shared-files' && l.weight === 1)).toBe(true);
  });

  it('never links across projects', () => {
    const links = deriveLinks(inputs);
    expect(links.some((l) => l.fromId === 'c' || l.toId === 'c')).toBe(false);
  });

  it('chains sessions chronologically within a project', () => {
    const links = deriveLinks(inputs);
    const continuation = links.find((l) => l.kind === 'continuation');
    expect(continuation).toEqual({ fromId: 'a', toId: 'b', kind: 'continuation', weight: 1 });
  });
});
