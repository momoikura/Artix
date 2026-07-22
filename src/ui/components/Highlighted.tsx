/**
 * Renders text with search matches wrapped in `<mark>`.
 *
 * Ranges come from the search engine as `[start, end)` offsets and are already
 * merged and sorted, but this component re-validates them: an out-of-range
 * offset (from a stale result set) must render plain text, never throw.
 */

import { Fragment } from 'react';
import type { Highlight } from '../../core/types.ts';

export interface HighlightedProps {
  text: string;
  ranges: readonly Highlight[];
}

export function Highlighted({ text, ranges }: HighlightedProps): JSX.Element {
  if (ranges.length === 0) return <>{text}</>;

  const valid = ranges
    .filter((range) => range.start >= 0 && range.end <= text.length && range.start < range.end)
    .sort((a, b) => a.start - b.start);

  if (valid.length === 0) return <>{text}</>;

  const parts: JSX.Element[] = [];
  let cursor = 0;

  for (const [index, range] of valid.entries()) {
    // Skip a range that overlaps one already emitted.
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      parts.push(<Fragment key={`t${index}`}>{text.slice(cursor, range.start)}</Fragment>);
    }
    parts.push(<mark key={`m${index}`}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }

  if (cursor < text.length) parts.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);

  return <>{parts}</>;
}
