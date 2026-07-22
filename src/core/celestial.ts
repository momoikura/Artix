/**
 * Celestial classification.
 *
 * Every visual property of a star in the galaxy is *derived*, never random.
 * This module is the single source of truth for that derivation so the
 * renderer, the legend and the session workspace can never disagree.
 *
 *   complexity -> node radius       (how much work the session contains)
 *   importance -> node brightness   (how much it should pull your attention)
 *   kind       -> silhouette        (star / planet / asteroid)
 *
 * All outputs are normalised to 0..1 and are pure functions of stored data.
 */

import type { CelestialKind, Session, SessionStatus, Timestamp } from './types.ts';

/** Weights for the complexity score. Tuned so a typical session lands near 0.4. */
const COMPLEXITY_WEIGHTS = {
  messages: 0.30,
  files: 0.30,
  artifacts: 0.25,
  duration: 0.15,
} as const;

/** Saturating curve: cheap, monotonic, and flattens gracefully for huge inputs. */
function saturate(value: number, halfPoint: number): number {
  if (value <= 0) return 0;
  return value / (value + halfPoint);
}

export interface ComplexityInput {
  messageCount: number;
  fileCount: number;
  artifactCount: number;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
}

/**
 * 0..1 measure of how much a session contains.
 *
 * Half-points are set from realistic session shapes: 40 messages, 12 files,
 * 10 artifacts and a 45-minute duration each contribute half of their weight.
 */
export function computeComplexity(input: ComplexityInput): number {
  const durationMs = input.endedAt !== null ? Math.max(0, input.endedAt - input.startedAt) : 0;

  const score =
    COMPLEXITY_WEIGHTS.messages * saturate(input.messageCount, 40) +
    COMPLEXITY_WEIGHTS.files * saturate(input.fileCount, 12) +
    COMPLEXITY_WEIGHTS.artifacts * saturate(input.artifactCount, 10) +
    COMPLEXITY_WEIGHTS.duration * saturate(durationMs / 60_000, 45);

  return clamp01(score);
}

export interface ImportanceInput {
  complexity: number;
  startedAt: Timestamp;
  pinned: boolean;
  status: SessionStatus;
  /** Evaluation time — injected so the value is testable and deterministic. */
  now: Timestamp;
}

const DAY_MS = 86_400_000;

/** Recency half-life in days. After 60 days a session has half its glow left. */
const RECENCY_HALF_LIFE_DAYS = 60;

const STATUS_MULTIPLIER: Record<SessionStatus, number> = {
  active: 1.0,
  paused: 0.85,
  completed: 0.8,
  archived: 0.45,
};

/**
 * 0..1 brightness.
 *
 * Recency dominates (a session you touched yesterday should be findable at a
 * glance) but never wins outright — a huge archived project still out-glows a
 * trivial one from this morning. Pinned sessions get a floor, so the user can
 * always keep something visible.
 */
export function computeImportance(input: ImportanceInput): number {
  const ageDays = Math.max(0, (input.now - input.startedAt) / DAY_MS);
  const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);

  const base = 0.62 * recency + 0.38 * input.complexity;
  const scored = base * STATUS_MULTIPLIER[input.status];

  return clamp01(input.pinned ? Math.max(scored, 0.75) : scored);
}

/**
 * Silhouette class.
 *
 * Archived work becomes asteroid-belt debris regardless of size — that is what
 * makes the outer galaxy read as "old stuff" at a glance. Otherwise the split
 * is purely on complexity.
 */
export function classifyCelestial(complexity: number, status: SessionStatus): CelestialKind {
  if (status === 'archived') return 'asteroid';
  if (complexity >= 0.5) return 'star';
  if (complexity >= 0.18) return 'planet';
  return 'asteroid';
}

/** World-space radius for a node, in galaxy units. */
export function nodeRadius(kind: CelestialKind, complexity: number): number {
  const base = { star: 1.0, planet: 0.55, asteroid: 0.3 }[kind];
  // sqrt keeps the *area* roughly proportional to complexity, which is what the
  // eye actually integrates.
  return base * (0.55 + 0.85 * Math.sqrt(clamp01(complexity)));
}

/**
 * Recompute every derived field on a session. Called after import and after any
 * edit that changes the counters, so stored values never drift from their inputs.
 */
export function deriveCelestialFields(
  session: Session,
  now: Timestamp = Date.now(),
): Pick<Session, 'complexity' | 'importance' | 'kind'> {
  const complexity = computeComplexity({
    messageCount: session.messageCount,
    fileCount: session.fileCount,
    artifactCount: session.artifactCount,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  });

  return {
    complexity,
    importance: computeImportance({
      complexity,
      startedAt: session.startedAt,
      pinned: session.pinned,
      status: session.status,
      now,
    }),
    kind: classifyCelestial(complexity, session.status),
  };
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
