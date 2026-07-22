/**
 * In-memory inverted index.
 *
 * This is the search backend used when SQLite is unavailable (web/dev mode,
 * unit tests) and — more importantly — the *fuzzy expansion* layer used in
 * front of FTS5 in the desktop build. FTS5 has no typo tolerance; this index
 * supplies the candidate terms that make `galxy` find `galaxy`.
 *
 * Documents are addressed by a dense integer ordinal so postings are
 * `Map<token, Map<ordinal, weight>>` — compact, and cheap to intersect.
 */

import { typoSimilarity } from './fuzzy.ts';
import { FIELD_WEIGHTS, SEARCH_FIELDS, tokenizeText } from './document.ts';
import type { SearchDocument, SearchField } from './document.ts';

/** A token's accumulated weight within one document. */
type Postings = Map<number, number>;

export interface IndexMatch {
  id: string;
  /** Unbounded additive score; normalise before blending. */
  score: number;
  /** Terms that actually matched — drives highlighting. */
  matchedTerms: string[];
  /** True when at least one term matched only via typo tolerance. */
  fuzzy: boolean;
}

export interface SearchOptions {
  /** Positive terms; all must match (possibly fuzzily). */
  terms: readonly string[];
  /** Contiguous phrases; checked against the raw field text. */
  phrases?: readonly string[];
  /** Documents containing any of these are excluded. */
  negated?: readonly string[];
  /** Treat the last term as a prefix. Enabled while the user is typing. */
  prefixLast?: boolean;
  /** Allow typo-tolerant expansion when a term has no exact/prefix matches. */
  fuzzy?: boolean;
  limit?: number;
}

export class InvertedIndex {
  readonly #postings = new Map<string, Postings>();
  readonly #ordinalById = new Map<string, number>();
  /** Dense array; holes are `undefined` after removal and skipped on scan. */
  readonly #docs: (SearchDocument | undefined)[] = [];

  /** Sorted token list, rebuilt lazily — powers prefix and fuzzy expansion. */
  #sortedTokens: string[] | null = null;
  #size = 0;

  get size(): number {
    return this.#size;
  }

  get tokenCount(): number {
    return this.#postings.size;
  }

  clear(): void {
    this.#postings.clear();
    this.#ordinalById.clear();
    this.#docs.length = 0;
    this.#sortedTokens = null;
    this.#size = 0;
  }

  has(id: string): boolean {
    return this.#ordinalById.has(id);
  }

  getDocument(id: string): SearchDocument | undefined {
    const ordinal = this.#ordinalById.get(id);
    return ordinal === undefined ? undefined : this.#docs[ordinal];
  }

  /** Insert or replace a document. */
  add(doc: SearchDocument): void {
    this.remove(doc.id);

    const ordinal = this.#docs.length;
    this.#docs.push(doc);
    this.#ordinalById.set(doc.id, ordinal);
    this.#size++;

    for (const field of SEARCH_FIELDS) {
      const weight = FIELD_WEIGHTS[field];
      const text = doc[field];
      if (!text) continue;

      for (const token of tokenizeText(text)) {
        let postings = this.#postings.get(token);
        if (!postings) {
          postings = new Map();
          this.#postings.set(token, postings);
          this.#sortedTokens = null; // vocabulary grew
        }
        postings.set(ordinal, (postings.get(ordinal) ?? 0) + weight);
      }
    }
  }

  addAll(docs: Iterable<SearchDocument>): void {
    for (const doc of docs) this.add(doc);
  }

  remove(id: string): boolean {
    const ordinal = this.#ordinalById.get(id);
    if (ordinal === undefined) return false;

    // Postings are left to be filtered at query time rather than walked here;
    // a full sweep would be O(vocabulary) per delete. The hole in `#docs` makes
    // the stale ordinals unreachable.
    this.#docs[ordinal] = undefined;
    this.#ordinalById.delete(id);
    this.#size--;
    return true;
  }

  /**
   * Compact the index after many deletions. Called by the storage adapter when
   * the hole ratio crosses a threshold, never on the hot path.
   */
  compact(): void {
    const live = this.#docs.filter((d): d is SearchDocument => d !== undefined);
    this.clear();
    this.addAll(live);
  }

  /* ---------------------------------------------------------- term lookup */

  #tokens(): string[] {
    if (this.#sortedTokens === null) {
      this.#sortedTokens = [...this.#postings.keys()].sort();
    }
    return this.#sortedTokens;
  }

  /** Tokens starting with `prefix`, via binary search on the sorted vocabulary. */
  prefixTokens(prefix: string, limit = 64): string[] {
    if (prefix.length === 0) return [];
    const tokens = this.#tokens();

    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tokens[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }

    const out: string[] = [];
    for (let i = lo; i < tokens.length && out.length < limit; i++) {
      const token = tokens[i]!;
      if (!token.startsWith(prefix)) break;
      out.push(token);
    }
    return out;
  }

  /**
   * Typo-tolerant expansion. Scans the vocabulary, which is why it is only ever
   * reached after exact and prefix lookup both come up empty.
   */
  fuzzyTokens(term: string, limit = 8, threshold = 0.62): string[] {
    if (term.length < 3) return [];
    const scored: { token: string; score: number }[] = [];

    for (const token of this.#postings.keys()) {
      // Cheap length gate before the expensive comparison.
      if (Math.abs(token.length - term.length) > 3) continue;
      const score = typoSimilarity(term, token);
      if (score >= threshold) scored.push({ token, score });
    }

    scored.sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));
    return scored.slice(0, limit).map((s) => s.token);
  }

  /* --------------------------------------------------------------- search */

  search(options: SearchOptions): IndexMatch[] {
    const { terms, phrases = [], negated = [], prefixLast = true, fuzzy = true } = options;
    const limit = options.limit ?? 500;

    if (terms.length === 0 && phrases.length === 0) return [];

    // Accumulate per-document scores, requiring every term to contribute.
    let candidates: Map<number, number> | null = null;
    const matchedTerms: string[] = [];
    let usedFuzzy = false;

    for (let index = 0; index < terms.length; index++) {
      if (candidates !== null && candidates.size === 0) break; // already empty

      const term = terms[index]!;
      const isLast = index === terms.length - 1;
      const expansions = this.#expand(term, prefixLast && isLast, fuzzy);
      if (expansions.tokens.length > 0) matchedTerms.push(term);
      if (expansions.fuzzy) usedFuzzy = true;

      const termScores = new Map<number, number>();
      for (const { token, penalty } of expansions.tokens) {
        const postings = this.#postings.get(token);
        if (!postings) continue;
        for (const [ordinal, weight] of postings) {
          if (this.#docs[ordinal] === undefined) continue; // deleted
          const scaled = weight * penalty;
          const existing = termScores.get(ordinal);
          if (existing === undefined || scaled > existing) termScores.set(ordinal, scaled);
        }
      }

      candidates = candidates === null ? termScores : intersect(candidates, termScores);
    }

    let result: Map<number, number> = candidates ?? new Map();

    // Phrases are verified against the raw text; they cannot be answered from
    // an unpositioned index.
    if (phrases.length > 0) {
      if (terms.length === 0) {
        // Phrase-only query: seed from the first phrase's rarest token.
        result = this.#seedFromPhrase(phrases[0]!);
      }
      for (const phrase of phrases) {
        for (const ordinal of [...result.keys()]) {
          const doc = this.#docs[ordinal];
          if (!doc || !documentContainsPhrase(doc, phrase)) result.delete(ordinal);
          else result.set(ordinal, (result.get(ordinal) ?? 0) + 40); // strong signal
        }
      }
      matchedTerms.push(...phrases);
    }

    // Exclusions.
    if (negated.length > 0 && result.size > 0) {
      for (const term of negated) {
        const postings = this.#postings.get(term);
        if (postings) for (const ordinal of postings.keys()) result.delete(ordinal);
      }
    }

    const out: IndexMatch[] = [];
    for (const [ordinal, score] of result) {
      const doc = this.#docs[ordinal];
      if (!doc) continue;
      out.push({ id: doc.id, score, matchedTerms, fuzzy: usedFuzzy });
    }

    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return out.slice(0, limit);
  }

  /**
   * Resolve one user term to the index tokens it should match, with a score
   * penalty reflecting how far the expansion strayed from what was typed.
   */
  #expand(
    term: string,
    allowPrefix: boolean,
    allowFuzzy: boolean,
  ): { tokens: { token: string; penalty: number }[]; fuzzy: boolean } {
    const tokens: { token: string; penalty: number }[] = [];

    if (this.#postings.has(term)) tokens.push({ token: term, penalty: 1 });

    if (allowPrefix && term.length >= 2) {
      for (const token of this.prefixTokens(term)) {
        if (token === term) continue;
        // Longer completions are weaker evidence than near-exact ones.
        tokens.push({ token, penalty: 0.55 + 0.35 * (term.length / token.length) });
      }
    }

    if (tokens.length > 0 || !allowFuzzy) return { tokens, fuzzy: false };

    for (const token of this.fuzzyTokens(term)) {
      tokens.push({ token, penalty: 0.4 });
    }
    return { tokens, fuzzy: tokens.length > 0 };
  }

  /** Candidate set for a phrase-only query: the rarest constituent token. */
  #seedFromPhrase(phrase: string): Map<number, number> {
    const tokens = tokenizeText(phrase);
    let rarest: Postings | null = null;
    for (const token of tokens) {
      const postings = this.#postings.get(token);
      if (!postings) return new Map();
      if (rarest === null || postings.size < rarest.size) rarest = postings;
    }
    if (rarest === null) return new Map();

    const out = new Map<number, number>();
    for (const [ordinal, weight] of rarest) {
      if (this.#docs[ordinal] !== undefined) out.set(ordinal, weight);
    }
    return out;
  }
}

/** Intersection that sums scores — a document must satisfy every term. */
function intersect(a: Map<number, number>, b: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [ordinal, score] of small) {
    const other = large.get(ordinal);
    if (other !== undefined) out.set(ordinal, score + other);
  }
  return out;
}

/** Case-insensitive contiguous match across any indexed field. */
function documentContainsPhrase(doc: SearchDocument, phrase: string): boolean {
  const needle = phrase.toLowerCase();
  for (const field of SEARCH_FIELDS as readonly SearchField[]) {
    const value = doc[field];
    if (value && value.toLowerCase().includes(needle)) return true;
  }
  return false;
}
