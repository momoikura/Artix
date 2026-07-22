/**
 * Timeline scrubber.
 *
 * Two handles over a density histogram. Dragging them narrows the visible
 * window, and sessions outside it fade in the shader rather than disappearing —
 * so you always keep a sense of what is being excluded.
 *
 * Drag state lives in a ref, not React state: a pointermove that triggers a
 * re-render of the whole app would make scrubbing feel gluey.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DAY, histogram, isoDate } from '../core/time.ts';
import { useLibrary } from '../state/library-store.ts';
import './Timeline.css';

const BINS = 140;

export function Timeline(): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<'from' | 'to' | 'range' | null>(null);
  const dragOriginRef = useRef({ x: 0, from: 0, to: 0 });

  const sessions = useLibrary((state) => state.sessions);
  const timeFrom = useLibrary((state) => state.timeFrom);
  const timeTo = useLibrary((state) => state.timeTo);
  const setTimeRange = useLibrary((state) => state.setTimeRange);

  /* --------------------------------------------------------------- extent */

  const extent = useMemo(() => {
    if (sessions.length === 0) {
      const now = Date.now();
      return { min: now - 365 * DAY, max: now };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const session of sessions) {
      if (session.startedAt < min) min = session.startedAt;
      if (session.startedAt > max) max = session.startedAt;
    }
    // Pad so the first and last sessions are not flush against the ends.
    const pad = Math.max(DAY, (max - min) * 0.02);
    return { min: min - pad, max: max + pad };
  }, [sessions]);

  const bins = useMemo(
    () => histogram(sessions.map((s) => s.startedAt), extent.min, extent.max, BINS),
    [sessions, extent],
  );

  const peak = useMemo(() => Math.max(1, ...bins), [bins]);

  /* -------------------------------------------------------- window <-> % */

  const from = timeFrom ?? extent.min;
  const to = timeTo ?? extent.max;
  const span = Math.max(1, extent.max - extent.min);

  const toPercent = useCallback(
    (value: number) => ((value - extent.min) / span) * 100,
    [extent.min, span],
  );

  const fromPercent = useCallback(
    (percent: number) => extent.min + (percent / 100) * span,
    [extent.min, span],
  );

  const [live, setLive] = useState<{ from: number; to: number } | null>(null);
  const shownFrom = live?.from ?? from;
  const shownTo = live?.to ?? to;

  /* ---------------------------------------------------------------- drag */

  const beginDrag = (handle: 'from' | 'to' | 'range') => (event: React.PointerEvent) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = handle;
    dragOriginRef.current = { x: event.clientX, from: shownFrom, to: shownTo };
    setLive({ from: shownFrom, to: shownTo });
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const handle = dragRef.current;
      const track = trackRef.current;
      if (!handle || !track) return;

      const rect = track.getBoundingClientRect();
      const origin = dragOriginRef.current;

      if (handle === 'range') {
        // Move the whole window, clamped so neither edge leaves the extent.
        const deltaValue = ((event.clientX - origin.x) / rect.width) * span;
        const width = origin.to - origin.from;
        let nextFrom = origin.from + deltaValue;
        nextFrom = Math.max(extent.min, Math.min(extent.max - width, nextFrom));
        setLive({ from: nextFrom, to: nextFrom + width });
        return;
      }

      const percent = ((event.clientX - rect.left) / rect.width) * 100;
      const value = fromPercent(Math.max(0, Math.min(100, percent)));

      setLive((current) => {
        const base = current ?? { from: origin.from, to: origin.to };
        // Keep at least a day of window so the handles never cross or collapse.
        if (handle === 'from') return { from: Math.min(value, base.to - DAY), to: base.to };
        return { from: base.from, to: Math.max(value, base.from + DAY) };
      });
    };

    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setLive((current) => {
        if (current) {
          // Snap back to "no filter" when the window covers everything.
          const isFull = current.from <= extent.min + DAY && current.to >= extent.max - DAY;
          setTimeRange(isFull ? null : current.from, isFull ? null : current.to);
        }
        return null;
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [extent.min, extent.max, span, fromPercent, setTimeRange]);

  const filtered = timeFrom !== null || timeTo !== null;

  /* --------------------------------------------------------------- render */

  return (
    <div className="timeline">
      <div className="timeline__header">
        <span className="label">Timeline</span>
        <span className="timeline__range mono">
          {isoDate(shownFrom)} → {isoDate(shownTo)}
        </span>
        {filtered && (
          <button className="timeline__reset" onClick={() => setTimeRange(null, null)}>
            Reset
          </button>
        )}
      </div>

      <div className="timeline__track" ref={trackRef}>
        <div className="timeline__histogram" aria-hidden="true">
          {bins.map((count, index) => {
            const binStart = extent.min + (index / BINS) * span;
            const inWindow = binStart >= shownFrom && binStart <= shownTo;
            return (
              <div
                key={index}
                className={`timeline__bar${inWindow ? ' is-active' : ''}`}
                // sqrt keeps a single busy week from flattening every other bar.
                style={{ height: `${Math.sqrt(count / peak) * 100}%` }}
              />
            );
          })}
        </div>

        <div
          className="timeline__window"
          style={{
            left: `${toPercent(shownFrom)}%`,
            width: `${toPercent(shownTo) - toPercent(shownFrom)}%`,
          }}
          onPointerDown={beginDrag('range')}
          role="slider"
          aria-label="Visible time window"
          aria-valuemin={extent.min}
          aria-valuemax={extent.max}
          aria-valuenow={shownFrom}
          tabIndex={0}
        />

        <div
          className="timeline__handle"
          style={{ left: `${toPercent(shownFrom)}%` }}
          onPointerDown={beginDrag('from')}
          aria-label="Window start"
        />
        <div
          className="timeline__handle"
          style={{ left: `${toPercent(shownTo)}%` }}
          onPointerDown={beginDrag('to')}
          aria-label="Window end"
        />
      </div>

      <div className="timeline__axis" aria-hidden="true">
        <span>{isoDate(extent.min)}</span>
        <span className="timeline__axis-hint">
          {filtered ? 'Showing a slice of the archive' : 'Drag to scrub through time'}
        </span>
        <span>{isoDate(extent.max)}</span>
      </div>
    </div>
  );
}
