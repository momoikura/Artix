/**
 * The galaxy canvas.
 *
 * A thin React wrapper around the imperative renderer. React owns the DOM
 * overlay (labels, tooltip) and the renderer owns everything inside the canvas
 * — they communicate through explicit method calls, never through re-renders.
 * A 100k-node scene must never be driven by the reconciler.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { bus } from '../core/events.ts';
import { GalaxyControls, GalaxyScene } from '../renderer/index.ts';
import { useLibrary } from '../state/library-store.ts';
import { useUi } from '../state/ui-store.ts';
import { languageColor } from '../core/languages.ts';
import type { ScreenLabel } from '../renderer/index.ts';
import type { SessionId } from '../core/types.ts';
import './GalaxyView.css';

export function GalaxyView(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<GalaxyScene | null>(null);
  const controlsRef = useRef<GalaxyControls | null>(null);

  const [labels, setLabels] = useState<ScreenLabel[]>([]);

  const nodes = useLibrary((state) => state.nodes);
  const highlighted = useLibrary((state) => state.highlighted);
  const selectedId = useLibrary((state) => state.selectedId);
  const timeFrom = useLibrary((state) => state.timeFrom);
  const timeTo = useLibrary((state) => state.timeTo);

  const settings = useUi((state) => state.settings.galaxy);
  const hoveredId = useUi((state) => state.hoveredId);

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new GalaxyScene(
      canvas,
      {
        onLabels: setLabels,
        onQualityChange: (tier) => useUi.getState().setQualityTier(tier),
        onFrame: (fps) => useUi.getState().setFps(fps),
      },
      {
        quality: 'auto',
        motion: settings.motion,
        motionSpeed: settings.motionSpeed,
        labels: settings.labels,
        labelBudget: settings.labelBudget,
        bloom: settings.bloom,
        nebula: settings.nebula,
        dust: settings.dust,
        depthOfField: settings.depthOfField,
      },
    );

    const controls = new GalaxyControls(canvas, scene, {
      onSelect: (id) => useLibrary.getState().select(id),
      onOpen: (id) => void useLibrary.getState().open(id),
      onHover: (id, screen) => useUi.getState().setHovered(id, screen),
      onContextMenu: (id, screen) =>
        useUi.getState().openContextMenu({ x: screen.x, y: screen.y, sessionId: id }),
    });

    sceneRef.current = scene;
    controlsRef.current = controls;
    scene.start();

    // The canvas is sized by CSS; a ResizeObserver is the only reliable way to
    // learn about layout-driven size changes (panel toggles, window resize).
    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);

    // `camera:focus` with an empty id is the agreed "go to overview" signal.
    const unsubscribe = bus.on('camera:focus', ({ id, immediate }) => {
      if (id === '') scene.flyToOverview();
      else scene.focusOn(id, { immediate });
    });

    return () => {
      unsubscribe();
      observer.disconnect();
      controls.dispose();
      scene.dispose();
      sceneRef.current = null;
      controlsRef.current = null;
    };
    // Constructed once. Option changes are pushed imperatively below, because
    // rebuilding the scene on a settings toggle would drop the camera position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------- data → scene */

  useEffect(() => {
    sceneRef.current?.setNodes(nodes);
  }, [nodes]);

  useEffect(() => {
    sceneRef.current?.setHighlight(highlighted);
  }, [highlighted]);

  useEffect(() => {
    sceneRef.current?.setSelected(selectedId);
  }, [selectedId]);

  useEffect(() => {
    sceneRef.current?.setTimeWindow(timeFrom, timeTo);
  }, [timeFrom, timeTo]);

  useEffect(() => {
    sceneRef.current?.setOptions({
      motion: settings.motion,
      motionSpeed: settings.motionSpeed,
      labels: settings.labels,
      labelBudget: settings.labelBudget,
      bloom: settings.bloom,
      nebula: settings.nebula,
      dust: settings.dust,
      depthOfField: settings.depthOfField,
      quality: settings.quality === 'auto' ? 'auto' : settings.quality,
    });
  }, [settings]);

  /* ---------------------------------------------------------------- render */

  const sessionsById = useLibrary((state) => state.sessions);
  const lookup = useMemo(() => {
    const map = new Map<SessionId, (typeof sessionsById)[number]>();
    for (const session of sessionsById) map.set(session.id, session);
    return map;
  }, [sessionsById]);

  const hovered = hoveredId ? lookup.get(hoveredId) : null;
  const hoverPosition = useUi((state) => state.hoverPosition);

  return (
    <div className="galaxy">
      <canvas ref={canvasRef} className="galaxy__canvas" />

      {settings.labels && (
        <div className="galaxy__labels" aria-hidden="true">
          {labels.map((label) => {
            const session = lookup.get(label.id);
            if (!session) return null;
            return (
              <div
                key={label.id}
                className={`galaxy-label${label.id === selectedId ? ' is-selected' : ''}`}
                style={{
                  transform: `translate3d(${label.x + label.radius * 0.8 + 8}px, ${label.y - 8}px, 0)`,
                  opacity: label.weight,
                  borderLeftColor: languageColor(session.language),
                }}
              >
                <span className="galaxy-label__title">{session.title}</span>
                <span className="galaxy-label__meta">{session.project}</span>
              </div>
            );
          })}
        </div>
      )}

      {hovered && hoverPosition && (
        <div
          className="galaxy-tooltip"
          style={{
            // Flip to the left near the right edge so the tooltip never clips.
            transform: `translate3d(${
              hoverPosition.x > window.innerWidth - 300 ? hoverPosition.x - 280 : hoverPosition.x + 18
            }px, ${hoverPosition.y + 14}px, 0)`,
          }}
        >
          <div className="galaxy-tooltip__title">{hovered.title}</div>
          <div className="galaxy-tooltip__row">
            <span
              className="galaxy-tooltip__swatch"
              style={{ background: languageColor(hovered.language) }}
            />
            <span>{hovered.project}</span>
            <span className="galaxy-tooltip__dot">·</span>
            <span>{new Date(hovered.startedAt).toLocaleDateString()}</span>
          </div>
          {hovered.technologies.length > 0 && (
            <div className="galaxy-tooltip__stack">
              {hovered.technologies.slice(0, 4).join(' · ')}
            </div>
          )}
          <div className="galaxy-tooltip__hint">Double-click to open</div>
        </div>
      )}
    </div>
  );
}
