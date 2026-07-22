/**
 * Ranking.
 *
 * Text relevance alone is the wrong answer for a memory tool. When you search
 * "auth bug", the session from last Tuesday almost always beats the equally
 * relevant one from two years ago — so relevance, recency and importance are
 * blended into a single score.
 *
 * The blend is the same whether the text score came from SQLite's BM25 or the
 * in-memory engine, which is why it lives in its own module.
 */

import { DAY } from '../core/time.ts';
import type { SearchSort, Session, Timestamp } from '../core/types.ts';

export interface RankInput {
  /** 0..1 normalised text relevance. */
  relevance: number;
  session: Session;
  now: Timestamp;
}

const WEIGHTS = {
  relevance: 0.62,
  recency: 0.23,
  importance: 0.15,
} as const;

/** Recency decays with a 90-day half-life — slower than star brightness, since
 * an old-but-relevant result should still be reachable. */
const RECENCY_HALF_LIFE_DAYS = 90;

export function recencyScore(startedAt: Timestamp, now: Timestamp): number {
  const ageDays = Math.max(0, (now - startedAt) / DAY);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function combineScore(input: RankInput): number {
  const { relevance, session, now } = input;

  const score =
    WEIGHTS.relevance * clamp01(relevance) +
    WEIGHTS.recency * recencyScore(session.startedAt, now) +
    WEIGHTS.importance * clamp01(session.importance);

  // Pinned sessions get a modest, bounded lift — enough to surface them, not
  // enough to bury a perfect text match.
  return session.pinned ? Math.min(1, score * 1.15) : score;
}

/**
 * SQLite's `bm25()` returns a *negative* number where more-negative is better.
 * Map it onto 0..1 with a smooth saturating curve so it can be blended.
 */
export function normalizeBm25(bm25: number): number {
  const magnitude = Math.max(0, -bm25);
  return magnitude / (magnitude + 4);
}

/** Normalise the in-memory engine's unbounded additive score. */
export function normalizeRawScore(score: number): number {
  return score <= 0 ? 0 : score / (score + 60);
}

export interface Sortable {
  session: Session;
  score: number;
}

/**
 * Apply the user's chosen ordering. Every comparator falls back to `id` so the
 * result order is total and stable across queries.
 */
export function sortHits<T extends Sortable>(hits: T[], sort: SearchSort): T[] {
  const byId = (a: T, b: T) => (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0);

  switch (sort) {
    case 'recent':
      return hits.sort((a, b) => b.session.startedAt - a.session.startedAt || byId(a, b));
    case 'oldest':
      return hits.sort((a, b) => a.session.startedAt - b.session.startedAt || byId(a, b));
    case 'complexity':
      return hits.sort((a, b) => b.session.complexity - a.session.complexity || byId(a, b));
    case 'title':
      return hits.sort((a, b) => a.session.title.localeCompare(b.session.title) || byId(a, b));
    case 'relevance':
    default:
      return hits.sort((a, b) => b.score - a.score || byId(a, b));
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
