/**
 * Time helpers. All Artix timestamps are epoch milliseconds in UTC; formatting
 * happens only at the very edge, in the UI.
 */

import type { Timestamp } from './types.ts';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Parse anything an importer might hand us into epoch ms, or null. */
export function parseTimestamp(value: unknown): Timestamp | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values below ~year 2286 in seconds are almost certainly seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (/^\d+$/.test(trimmed)) return parseTimestamp(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** `2026-07-22` — stable, sortable, locale-independent. */
export function isoDate(ts: Timestamp): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function isoDateTime(ts: Timestamp): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

/** Locale-aware absolute label for tooltips and detail headers. */
export function formatAbsolute(ts: Timestamp): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `3 days ago`, `just now`, `in 2 hours`. */
export function formatRelative(ts: Timestamp, now: Timestamp = Date.now()): string {
  const delta = ts - now;
  const abs = Math.abs(delta);

  if (abs < 45 * SECOND) return 'just now';

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * DAY],
    ['month', 30 * DAY],
    ['week', WEEK],
    ['day', DAY],
    ['hour', HOUR],
    ['minute', MINUTE],
  ];

  for (const [unit, ms] of units) {
    if (abs >= ms) {
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      return rtf.format(Math.round(delta / ms), unit);
    }
  }
  return 'just now';
}

/** `1h 24m`, `3m 02s`, `—` for unknown. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  const s = Math.floor((ms % MINUTE) / SECOND);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Start of the UTC day containing `ts` — the bucket key for the timeline. */
export function startOfDay(ts: Timestamp): Timestamp {
  return Math.floor(ts / DAY) * DAY;
}

/**
 * Bucket timestamps into a fixed number of bins between `from` and `to`.
 * Powers the timeline scrubber's density histogram.
 */
export function histogram(
  timestamps: readonly Timestamp[],
  from: Timestamp,
  to: Timestamp,
  bins: number,
): number[] {
  const out = new Array<number>(bins).fill(0);
  if (bins <= 0 || to <= from) return out;
  const span = to - from;
  for (const ts of timestamps) {
    if (ts < from || ts > to) continue;
    const idx = Math.min(bins - 1, Math.floor(((ts - from) / span) * bins));
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}
