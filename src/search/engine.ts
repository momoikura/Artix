/**
 * Local search engine.
 *
 * Owns the full pipeline: parse → filter → match → rank → highlight. The
 * SQLite adapter delegates *matching* to FTS5 but reuses this module's
 * filtering, ranking and highlighting so both backends behave identically.
 *
 * Design constraint: a keystroke must produce results in well under 16 ms on a
 * 100k-session library, so the filter pass is a single linear scan over compact
 * session records and the index is only consulted for the text component.
 */

import { findHighlights } from './document.ts';
import { InvertedIndex } from './inverted-index.ts';
import { PINNED_PSEUDO_TAG, parseQuery, splitPseudoTags } from './query-parser.ts';
import { combineScore, normalizeRawScore, sortHits } from './rank.ts';
import type { ParsedQuery } from './query-parser.ts';
import type { SearchDocument } from './document.ts';
import type {
  Highlight,
  SearchHit,
  SearchQuery,
  SearchResult,
  Session,
  SessionId,
  Timestamp,
} from '../core/types.ts';

export interface EngineSource {
  /** All sessions, keyed by id. The engine never mutates this. */
  sessions: ReadonlyMap<SessionId, Session>;
}

export class SearchEngine {
  readonly index = new InvertedIndex();
  #source: EngineSource;

  constructor(source: EngineSource) {
    this.#source = source;
  }

  setSource(source: EngineSource): void {
    this.#source = source;
  }

  indexDocument(doc: SearchDocument): void {
    this.index.add(doc);
  }

  removeDocument(id: string): void {
    this.index.remove(id);
  }

  /** Parse a raw string and run it. Convenience for the command palette. */
  searchText(raw: string, base: Partial<SearchQuery> = {}, now = Date.now()): SearchResult {
    return this.search(parseQuery(raw, base, now), now);
  }

  search(query: ParsedQuery, now: Timestamp = Date.now()): SearchResult {
    const started = performance.now();

    const hasText = query.terms.length > 0 || query.phrases.length > 0;

    // 1. Text matching (or "everything" when the query is filters-only).
    let textScores: Map<string, number> | null = null;
    let matchedTerms: readonly string[] = [];
    let via: SearchHit['via'] = 'filter';

    if (hasText) {
      const matches = this.index.search({
        terms: query.terms,
        phrases: query.phrases,
        negated: query.negatedTerms,
        prefixLast: true,
        fuzzy: true,
        limit: Math.max(query.limit * 4, 1000),
      });

      textScores = new Map();
      let anyFuzzy = false;
      for (const match of matches) {
        textScores.set(match.id, match.score);
        if (match.fuzzy) anyFuzzy = true;
        matchedTerms = match.matchedTerms;
      }
      via = anyFuzzy ? 'fuzzy' : 'fts';
    }

    // 2. Filter + score.
    const { tags: realTags, pinnedOnly } = splitPseudoTags(query.tags);
    const filters = compileFilters(query, realTags, pinnedOnly);

    const hits: SearchHit[] = [];
    const candidates: Iterable<SessionId> =
      textScores !== null ? (textScores.keys() as Iterable<SessionId>) : this.#source.sessions.keys();

    for (const id of candidates) {
      const session = this.#source.sessions.get(id);
      if (!session) continue;
      if (!filters(session)) continue;

      const relevance = textScores === null ? 0.5 : normalizeRawScore(textScores.get(id) ?? 0);
      const score = combineScore({ relevance, session, now });

      hits.push({
        session,
        score,
        highlights: hasText ? collectHighlights(session, matchedTerms) : [],
        via: exactTitleMatch(session, query) ? 'exact' : via,
      });
    }

    // 3. Order and page.
    sortHits(hits, query.sort);

    // Exact title matches always float to the top of a relevance sort — this is
    // what makes "type the name you remember" reliably land on the right star.
    if (query.sort === 'relevance') {
      hits.sort((a, b) => rankVia(b.via) - rankVia(a.via) || b.score - a.score);
    }

    const total = hits.length;
    const page = hits.slice(query.offset, query.offset + query.limit);

    return { hits: page, total, elapsedMs: performance.now() - started };
  }

  /** Distinct ids matching a query — the fast path the galaxy uses to highlight. */
  matchingIds(query: ParsedQuery, now: Timestamp = Date.now()): Set<SessionId> {
    const result = this.search({ ...query, limit: 100_000, offset: 0 }, now);
    return new Set(result.hits.map((h) => h.session.id));
  }
}

/* --------------------------------------------------------------- filtering */

type Filter = (session: Session) => boolean;

/**
 * Compile the query's filter clauses into a single closure. Building the sets
 * once and closing over them keeps the per-session cost to a handful of hash
 * lookups.
 */
export function compileFilters(query: SearchQuery, tags: string[], pinnedOnly: boolean): Filter {
  const tagSet = tags.length > 0 ? new Set(tags.map(lower)) : null;
  const techSet = query.technologies.length > 0 ? new Set(query.technologies.map(lower)) : null;
  const langSet = query.languages.length > 0 ? new Set(query.languages.map(lower)) : null;
  const projectSet = query.projects.length > 0 ? new Set(query.projects.map(lower)) : null;
  const statusSet = query.statuses.length > 0 ? new Set(query.statuses) : null;
  const { from, to } = query.range;
  const { includeArchived } = query;

  return (session) => {
    if (!includeArchived && session.status === 'archived') return false;
    if (pinnedOnly && !session.pinned) return false;
    if (statusSet && !statusSet.has(session.status)) return false;
    if (langSet && (session.language === null || !langSet.has(session.language))) return false;
    if (projectSet && !projectSet.has(session.project.toLowerCase())) return false;
    if (from !== null && session.startedAt < from) return false;
    if (to !== null && session.startedAt > to) return false;

    if (tagSet) {
      let found = false;
      for (const tag of session.tags) {
        if (tagSet.has(tag.toLowerCase())) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }

    if (techSet) {
      let found = false;
      for (const tech of session.technologies) {
        if (techSet.has(tech.toLowerCase())) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }

    return true;
  };
}

/* ------------------------------------------------------------ highlighting */

function collectHighlights(session: Session, terms: readonly string[]): Highlight[] {
  if (terms.length === 0) return [];
  return [
    ...findHighlights('title', session.title, terms, 6),
    ...findHighlights('project', session.project, terms, 3),
    ...findHighlights('summary', session.summary, terms, 6),
  ];
}

function exactTitleMatch(session: Session, query: ParsedQuery): boolean {
  if (query.terms.length === 0) return false;
  const title = session.title.toLowerCase();
  return query.terms.every((term) => title.includes(term));
}

function rankVia(via: SearchHit['via']): number {
  return via === 'exact' ? 3 : via === 'fts' ? 2 : via === 'fuzzy' ? 1 : 0;
}

function lower(value: string): string {
  return value.toLowerCase();
}

export { PINNED_PSEUDO_TAG };
