/**
 * SQLite FTS5 expression builder.
 *
 * FTS5's query language is powerful and extremely easy to get wrong: an
 * unescaped quote or a bare `-` turns a search into a syntax error, which the
 * user sees as "nothing found". Everything the user types is therefore quoted
 * as a string literal and combined with explicit operators — we never
 * interpolate raw input into the MATCH expression.
 */

import type { ParsedQuery } from './query-parser.ts';

/**
 * Quote a token as an FTS5 string. Internal double quotes are doubled, which is
 * the only escape FTS5 defines.
 */
export function quoteFts(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Strip characters FTS5's default tokenizer would drop anyway. Avoids emitting
 * empty string literals (a syntax error) for input like `--` or `***`.
 */
function sanitizeToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}\s._+#-]/gu, ' ').trim();
}

export interface FtsExpression {
  /** The MATCH expression, or null when the query has no text component. */
  match: string | null;
  /** Terms that survived sanitisation — reused for client-side highlighting. */
  terms: string[];
}

/**
 * Build the MATCH expression for a parsed query.
 *
 * Semantics:
 *  - all positive terms are ANDed (users expect narrowing, not widening)
 *  - the final term gets a `*` prefix operator so results update while typing
 *  - phrases become quoted phrase queries
 *  - negated terms become `NOT`
 */
export function buildFtsMatch(query: ParsedQuery, options: { prefixLastTerm?: boolean } = {}): FtsExpression {
  const prefixLast = options.prefixLastTerm ?? true;

  const terms = query.terms.map(sanitizeToken).filter((t) => t.length > 0);
  const phrases = query.phrases.map(sanitizeToken).filter((t) => t.length > 0);
  const negated = query.negatedTerms.map(sanitizeToken).filter((t) => t.length > 0);

  if (terms.length === 0 && phrases.length === 0) {
    return { match: null, terms: [] };
  }

  const clauses: string[] = [];

  for (const phrase of phrases) clauses.push(quoteFts(phrase));

  terms.forEach((term, index) => {
    const isLast = index === terms.length - 1;
    // A prefix search on a 1-char token matches almost everything; skip it.
    const usePrefix = prefixLast && isLast && term.length >= 2 && !term.includes(' ');
    clauses.push(usePrefix ? `${quoteFts(term)} *` : quoteFts(term));
  });

  let match = clauses.join(' AND ');

  for (const term of negated) {
    match += ` NOT ${quoteFts(term)}`;
  }

  return { match, terms: [...terms, ...phrases] };
}

/**
 * FTS5 `highlight()`/`snippet()` are per-column; Artix does its own
 * highlighting client-side instead so the same code path serves both backends.
 * This helper exists for the SQL that *does* want a snippet (the Rust export
 * command uses it for context bundles).
 */
export function snippetExpression(table: string, columnIndex: number, tokens = 24): string {
  return `snippet(${table}, ${columnIndex}, '<<', '>>', '…', ${tokens})`;
}
