/**
 * Search document construction.
 *
 * A session is indexed as a small set of weighted fields rather than one blob,
 * so a title hit outranks a hit buried in message 400. Both the SQLite FTS5
 * table and the in-memory engine consume exactly this shape — one definition,
 * two backends, no drift.
 */

import type { Highlight, Session, SessionDetail } from '../core/types.ts';

export const SEARCH_FIELDS = [
  'title',
  'project',
  'summary',
  'notes',
  'tags',
  'technologies',
  'body',
] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * Field weights, mirrored in the SQLite `bm25()` call. Body is deliberately
 * low: transcripts are long, and without damping every session matches
 * everything.
 */
export const FIELD_WEIGHTS: Record<SearchField, number> = {
  title: 10,
  project: 6,
  summary: 4,
  notes: 4,
  tags: 5,
  technologies: 3,
  body: 1,
};

/** Ordered weight vector for `bm25(fts, ...)`. Order must match the DDL. */
export const BM25_WEIGHTS: readonly number[] = SEARCH_FIELDS.map((f) => FIELD_WEIGHTS[f]);

export type SearchDocument = Record<SearchField, string> & { id: string };

/**
 * How much of a transcript makes it into the index.
 *
 * 64 KB per session keeps a 100k-session index around a few GB worst case while
 * still covering the overwhelming majority of real sessions in full. Messages
 * are taken from both ends: the opening states intent, the ending states the
 * outcome, and those are what people actually search for.
 */
const MAX_BODY_CHARS = 64 * 1024;

export function buildDocument(detail: SessionDetail): SearchDocument {
  const { session, messages, artifacts, files } = detail;

  const parts: string[] = [];
  let budget = MAX_BODY_CHARS;

  // Artifacts first — they are the distilled signal.
  for (const artifact of artifacts) {
    if (budget <= 0) break;
    const chunk = `${artifact.title}\n${artifact.content}`;
    parts.push(chunk.slice(0, budget));
    budget -= chunk.length;
  }

  // File paths are cheap and extremely high-value for recall.
  if (budget > 0 && files.length > 0) {
    const chunk = files.map((f) => f.path).join('\n');
    parts.push(chunk.slice(0, budget));
    budget -= chunk.length;
  }

  // Then conversation, alternating from the start and the end inward.
  if (budget > 0 && messages.length > 0) {
    let head = 0;
    let tail = messages.length - 1;
    let takeHead = true;
    while (budget > 0 && head <= tail) {
      const message = takeHead ? messages[head++]! : messages[tail--]!;
      const chunk = message.content;
      parts.push(chunk.length > budget ? chunk.slice(0, budget) : chunk);
      budget -= chunk.length;
      takeHead = !takeHead;
    }
  }

  return {
    id: session.id,
    title: session.title,
    project: session.project,
    summary: session.summary,
    notes: session.notes,
    tags: session.tags.join(' '),
    technologies: session.technologies.join(' '),
    body: parts.join('\n\n'),
  };
}

/** Lightweight document for sessions loaded without their messages. */
export function buildShallowDocument(session: Session): SearchDocument {
  return {
    id: session.id,
    title: session.title,
    project: session.project,
    summary: session.summary,
    notes: session.notes,
    tags: session.tags.join(' '),
    technologies: session.technologies.join(' '),
    body: '',
  };
}

/* -------------------------------------------------------------- tokenizing */

/**
 * Tokeniser shared by the in-memory index and the highlighter.
 *
 * Splits on non-alphanumerics but keeps `.`/`-`/`_`/`+`/`#` inside tokens so
 * `three.js`, `c++`, `snake_case` and `kebab-case` survive intact, then also
 * emits the sub-parts so `three` still finds `three.js`.
 */
export function tokenizeText(text: string): string[] {
  const tokens: string[] = [];
  const raw = text.toLowerCase().match(/[a-z0-9][a-z0-9.+#_-]*/g) ?? [];

  for (const token of raw) {
    const trimmed = token.replace(/[.\-_]+$/, '');
    if (trimmed.length === 0) continue;
    tokens.push(trimmed);
    if (/[.\-_]/.test(trimmed)) {
      for (const part of trimmed.split(/[.\-_]+/)) {
        if (part.length > 1) tokens.push(part);
      }
    }
  }
  return tokens;
}

/**
 * Locate every occurrence of the query terms in a field, for UI highlighting.
 * Case-insensitive, whole-word-prefix aware, capped so a pathological match
 * cannot produce a million ranges.
 */
export function findHighlights(
  field: Highlight['field'],
  text: string,
  terms: readonly string[],
  limit = 12,
): Highlight[] {
  if (terms.length === 0 || text.length === 0) return [];
  const lower = text.toLowerCase();
  const out: Highlight[] = [];

  for (const term of terms) {
    if (term.length < 2) continue;
    let from = 0;
    while (out.length < limit) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      // Only highlight at a word start, otherwise "ex" lights up every word.
      const prev = at > 0 ? lower[at - 1]! : ' ';
      if (!/[a-z0-9]/.test(prev)) out.push({ field, start: at, end: at + term.length });
      from = at + term.length;
    }
    if (out.length >= limit) break;
  }

  return mergeRanges(out);
}

function mergeRanges(ranges: Highlight[]): Highlight[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Highlight[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = sorted[i]!;
    if (cur.start <= prev.end) prev.end = Math.max(prev.end, cur.end);
    else out.push(cur);
  }
  return out;
}
