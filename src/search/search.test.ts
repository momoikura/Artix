import { describe, expect, it } from 'vitest';

import { DAY } from '../core/time.ts';
import { buildSession } from '../core/session.ts';
import { buildDocument, findHighlights, tokenizeText } from './document.ts';
import { buildFtsMatch, quoteFts } from './fts.ts';
import { editDistance, fuzzyMatch, isSubsequence, trigramSimilarity, typoSimilarity } from './fuzzy.ts';
import { InvertedIndex } from './inverted-index.ts';
import { PINNED_PSEUDO_TAG, parseQuery, splitPseudoTags, stringifyQuery } from './query-parser.ts';
import { normalizeBm25, normalizeRawScore, recencyScore, sortHits } from './rank.ts';
import { SearchEngine } from './engine.ts';
import type { Session, SessionDetail, SessionId } from '../core/types.ts';

const NOW = Date.UTC(2026, 6, 22);

/* ------------------------------------------------------------ query DSL */

describe('query parser', () => {
  it('separates free text from filters', () => {
    const q = parseQuery('auth refactor tag:security lang:rust project:artix', {}, NOW);
    expect(q.terms).toEqual(['auth', 'refactor']);
    expect(q.tags).toEqual(['security']);
    expect(q.languages).toEqual(['rust']);
    expect(q.projects).toEqual(['artix']);
  });

  it('supports # and @ shorthands', () => {
    const q = parseQuery('#infra @artix', {}, NOW);
    expect(q.tags).toEqual(['infra']);
    expect(q.projects).toEqual(['artix']);
  });

  it('handles quoted phrases and negation', () => {
    const q = parseQuery('"connection pool" -deprecated', {}, NOW);
    expect(q.phrases).toEqual(['connection pool']);
    expect(q.negatedTerms).toEqual(['deprecated']);
  });

  it('parses relative and absolute dates', () => {
    const relative = parseQuery('since:30d', {}, NOW);
    expect(relative.range.from).toBe(NOW - 30 * DAY);

    const absolute = parseQuery('before:2026-01-01', {}, NOW);
    expect(absolute.range.to).toBe(Date.UTC(2026, 0, 1));
  });

  it('keeps unrecognised colon tokens as free text', () => {
    // Must never silently swallow a user's search term.
    const q = parseQuery('http://example.com note:this', {}, NOW);
    expect(q.terms).toContain('http://example.com');
    expect(q.terms).toContain('note:this');
  });

  it('maps is:pinned to the reserved pseudo-tag', () => {
    const q = parseQuery('is:pinned', {}, NOW);
    expect(q.tags).toEqual([PINNED_PSEUDO_TAG]);
    const split = splitPseudoTags(q.tags);
    expect(split.pinnedOnly).toBe(true);
    expect(split.tags).toEqual([]);
  });

  it('includes archived sessions when explicitly asked', () => {
    expect(parseQuery('status:archived', {}, NOW).includeArchived).toBe(true);
    expect(parseQuery('anything', {}, NOW).includeArchived).toBe(false);
  });

  it('round-trips through stringify', () => {
    const q = parseQuery('auth tag:security lang:rust sort:recent', {}, NOW);
    const restored = parseQuery(stringifyQuery(q), {}, NOW);
    expect(restored.tags).toEqual(q.tags);
    expect(restored.languages).toEqual(q.languages);
    expect(restored.sort).toBe('recent');
  });
});

/* ---------------------------------------------------------------- fuzzy */

describe('fuzzy matching', () => {
  it('matches subsequences and scores tighter matches higher', () => {
    const tight = fuzzyMatch('gxr', 'gxr-loader');
    const loose = fuzzyMatch('gxr', 'g-something-x-something-r');
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight!.score).toBeGreaterThan(loose!.score);
  });

  it('returns null for non-subsequences', () => {
    expect(fuzzyMatch('zzz', 'galaxy')).toBeNull();
    expect(isSubsequence('gy', 'galaxy')).toBe(true);
    expect(isSubsequence('yg', 'galaxy')).toBe(false);
  });

  it('reports the matched positions for highlighting', () => {
    const match = fuzzyMatch('gr', 'galaxy renderer');
    expect(match).not.toBeNull();
    expect(match!.positions.length).toBe(2);
    expect(match!.positions.every((p) => p >= 0 && p < 'galaxy renderer'.length)).toBe(true);
  });

  it('measures bounded edit distance', () => {
    expect(editDistance('receive', 'recieve')).toBe(1); // transposition
    expect(editDistance('kitten', 'sitting')).toBe(3);
    // Beyond the bound it short-circuits rather than computing the true value.
    expect(editDistance('abc', 'xyzxyzxyz', 2)).toBe(3);
  });

  it('scores trigram similarity between 0 and 1', () => {
    expect(trigramSimilarity('galaxy', 'galaxy')).toBe(1);
    expect(trigramSimilarity('galaxy', 'galexy')).toBeGreaterThan(0.4);
    expect(trigramSimilarity('galaxy', 'zzzzzz')).toBe(0);
  });

  it('tolerates typos', () => {
    expect(typoSimilarity('renderer', 'rendrer')).toBeGreaterThan(0.5);
    expect(typoSimilarity('renderer', 'database')).toBeLessThan(0.4);
  });
});

/* ------------------------------------------------------------ documents */

describe('documents', () => {
  it('tokenises dotted and hyphenated identifiers into whole and parts', () => {
    const tokens = tokenizeText('three.js snake_case kebab-case C++');
    expect(tokens).toContain('three.js');
    expect(tokens).toContain('three');
    expect(tokens).toContain('snake');
    expect(tokens).toContain('kebab-case');
    expect(tokens).toContain('c++');
  });

  it('highlights only at word starts', () => {
    const ranges = findHighlights('title', 'export the exporter', ['export']);
    // Both "export" and "exporter" start with the term at a word boundary.
    expect(ranges).toHaveLength(2);
    // But a mid-word occurrence must not match.
    expect(findHighlights('title', 'reexport', ['export'])).toHaveLength(0);
  });

  it('caps the indexed body', () => {
    const huge = 'x'.repeat(200_000);
    const detail = buildSession(
      {
        title: 't',
        project: 'p',
        source: 'test',
        startedAt: NOW,
        messages: [{ seq: 0, role: 'user', content: huge, createdAt: null, tokenEstimate: 0, toolName: null }],
      },
      NOW,
    );
    expect(buildDocument(detail).body.length).toBeLessThanOrEqual(64 * 1024 + 16);
  });
});

/* -------------------------------------------------------------- FTS5 */

describe('FTS5 expression builder', () => {
  it('quotes and escapes user input', () => {
    expect(quoteFts('say "hi"')).toBe('"say ""hi"""');
  });

  it('ANDs terms and prefixes the last one', () => {
    const { match } = buildFtsMatch(parseQuery('galaxy rend', {}, NOW));
    expect(match).toBe('"galaxy" AND "rend" *');
  });

  it('emits phrases and negations', () => {
    const { match } = buildFtsMatch(parseQuery('"render loop" -legacy', {}, NOW));
    expect(match).toContain('"render loop"');
    expect(match).toContain('NOT "legacy"');
  });

  it('returns null when the query has no text component', () => {
    expect(buildFtsMatch(parseQuery('tag:infra', {}, NOW)).match).toBeNull();
  });

  it('never emits an empty literal for punctuation-only input', () => {
    const { match } = buildFtsMatch(parseQuery('--- ***', {}, NOW));
    expect(match === null || !match.includes('""')).toBe(true);
  });
});

/* --------------------------------------------------------------- rank */

describe('ranking', () => {
  it('normalises bm25 into 0..1 with better scores higher', () => {
    expect(normalizeBm25(0)).toBe(0);
    expect(normalizeBm25(-10)).toBeGreaterThan(normalizeBm25(-1));
    expect(normalizeBm25(-1000)).toBeLessThanOrEqual(1);
  });

  it('normalises raw scores monotonically', () => {
    expect(normalizeRawScore(0)).toBe(0);
    expect(normalizeRawScore(120)).toBeGreaterThan(normalizeRawScore(30));
  });

  it('decays recency', () => {
    expect(recencyScore(NOW, NOW)).toBeCloseTo(1);
    expect(recencyScore(NOW - 90 * DAY, NOW)).toBeCloseTo(0.5, 2);
  });

  it('sorts stably by id when scores tie', () => {
    const make = (id: string) => ({ session: { id, title: id, startedAt: 0, complexity: 0 } as Session, score: 1 });
    const sorted = sortHits([make('c'), make('a'), make('b')], 'relevance');
    expect(sorted.map((h) => h.session.id)).toEqual(['a', 'b', 'c']);
  });
});

/* ------------------------------------------------------ inverted index */

describe('inverted index', () => {
  const index = new InvertedIndex();
  index.add({ id: '1', title: 'Galaxy renderer', project: 'artix', summary: 'instanced points', notes: '', tags: 'graphics', technologies: 'Three.js', body: 'shader vertex' });
  index.add({ id: '2', title: 'Database migrations', project: 'orbital', summary: 'schema', notes: '', tags: 'backend', technologies: 'SQLite', body: 'sql tables' });

  it('finds exact terms', () => {
    expect(index.search({ terms: ['galaxy'] }).map((m) => m.id)).toEqual(['1']);
  });

  it('ANDs multiple terms', () => {
    expect(index.search({ terms: ['galaxy', 'schema'] })).toHaveLength(0);
    expect(index.search({ terms: ['galaxy', 'shader'] }).map((m) => m.id)).toEqual(['1']);
  });

  it('prefix-matches the final term', () => {
    expect(index.search({ terms: ['rend'], prefixLast: true }).map((m) => m.id)).toEqual(['1']);
  });

  it('falls back to fuzzy expansion and flags it', () => {
    const results = index.search({ terms: ['galxy'], prefixLast: false, fuzzy: true });
    expect(results.map((m) => m.id)).toEqual(['1']);
    expect(results[0]!.fuzzy).toBe(true);
  });

  it('honours phrases and negation', () => {
    expect(index.search({ terms: [], phrases: ['instanced points'] }).map((m) => m.id)).toEqual(['1']);
    expect(index.search({ terms: ['galaxy'], negated: ['shader'] })).toHaveLength(0);
  });

  it('excludes removed documents without a full rebuild', () => {
    const scratch = new InvertedIndex();
    scratch.add({ id: 'x', title: 'temp', project: '', summary: '', notes: '', tags: '', technologies: '', body: '' });
    expect(scratch.search({ terms: ['temp'] })).toHaveLength(1);
    scratch.remove('x');
    expect(scratch.search({ terms: ['temp'] })).toHaveLength(0);
    expect(scratch.size).toBe(0);
  });

  it('weights title matches above body matches', () => {
    const scratch = new InvertedIndex();
    scratch.add({ id: 'title-hit', title: 'auth', project: '', summary: '', notes: '', tags: '', technologies: '', body: '' });
    scratch.add({ id: 'body-hit', title: 'other', project: '', summary: '', notes: '', tags: '', technologies: '', body: 'auth' });
    const results = scratch.search({ terms: ['auth'], prefixLast: false });
    expect(results[0]!.id).toBe('title-hit');
  });
});

/* ------------------------------------------------------------- engine */

function session(overrides: Partial<Session>): Session {
  const detail: SessionDetail = buildSession(
    {
      title: 'Untitled',
      project: 'artix',
      source: 'test',
      startedAt: NOW - DAY,
      messages: [{ seq: 0, role: 'user', content: 'body text', createdAt: null, tokenEstimate: 0, toolName: null }],
    },
    NOW,
  );
  return { ...detail.session, ...overrides };
}

describe('search engine', () => {
  const sessions = new Map<SessionId, Session>();
  const engine = new SearchEngine({ sessions });

  const add = (s: Session, body = '') => {
    sessions.set(s.id, s);
    engine.indexDocument({
      id: s.id,
      title: s.title,
      project: s.project,
      summary: s.summary,
      notes: s.notes,
      tags: s.tags.join(' '),
      technologies: s.technologies.join(' '),
      body,
    });
  };

  const rust = session({ id: 'r1' as SessionId, title: 'Rewrite the query planner', project: 'quartz', language: 'rust', tags: ['perf'] });
  const ts = session({ id: 't1' as SessionId, title: 'Galaxy renderer instancing', project: 'artix', language: 'typescript', tags: ['graphics'] });
  const archived = session({ id: 'a1' as SessionId, title: 'Old planner experiment', project: 'quartz', language: 'rust', status: 'archived' });

  add(rust, 'planner cost model');
  add(ts, 'instanced points shader');
  add(archived, 'abandoned planner work');

  it('matches on text', () => {
    const result = engine.search(parseQuery('planner', {}, NOW), NOW);
    expect(result.hits.map((h) => h.session.id)).toContain('r1');
  });

  it('excludes archived sessions by default', () => {
    const result = engine.search(parseQuery('planner', {}, NOW), NOW);
    expect(result.hits.map((h) => h.session.id)).not.toContain('a1');
  });

  it('includes archived when asked', () => {
    const result = engine.search(parseQuery('planner status:archived', {}, NOW), NOW);
    expect(result.hits.map((h) => h.session.id)).toContain('a1');
  });

  it('applies language and project filters', () => {
    expect(engine.search(parseQuery('lang:rust', {}, NOW), NOW).hits.map((h) => h.session.id)).toEqual(['r1']);
    expect(engine.search(parseQuery('project:artix', {}, NOW), NOW).hits.map((h) => h.session.id)).toEqual(['t1']);
  });

  it('returns everything matching a filter-only query', () => {
    const result = engine.search(parseQuery('tag:graphics', {}, NOW), NOW);
    expect(result.total).toBe(1);
    expect(result.hits[0]!.via).toBe('filter');
  });

  it('flags exact title matches', () => {
    const result = engine.search(parseQuery('galaxy renderer', {}, NOW), NOW);
    expect(result.hits[0]!.session.id).toBe('t1');
    expect(result.hits[0]!.via).toBe('exact');
  });

  it('produces highlight ranges for the title', () => {
    const result = engine.search(parseQuery('galaxy', {}, NOW), NOW);
    const highlight = result.hits[0]!.highlights.find((h) => h.field === 'title');
    expect(highlight).toBeDefined();
    expect(ts.title.slice(highlight!.start, highlight!.end).toLowerCase()).toBe('galaxy');
  });

  it('narrows to exactly the requested status', () => {
    // `status:archived` means "show me archived work", not "also include it".
    const result = engine.search(parseQuery('planner status:archived', {}, NOW), NOW);
    expect(result.hits.map((h) => h.session.id)).toEqual(['a1']);
  });

  it('reports elapsed time and a total independent of paging', () => {
    const query = parseQuery('planner', { includeArchived: true }, NOW);
    const all = engine.search(query, NOW);
    expect(all.total).toBeGreaterThan(1);

    const paged = engine.search({ ...query, limit: 1 }, NOW);
    expect(paged.hits).toHaveLength(1);
    expect(paged.total).toBe(all.total);
    expect(paged.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
