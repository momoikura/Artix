/**
 * Heads-up display.
 *
 * Instrumentation, not a toolbar: it reports the state of the galaxy and gives
 * one-key access to the palette. Everything else lives in commands, so the HUD
 * never grows into a ribbon.
 */

import { useEffect, useRef } from 'react';

import { commands, displayShortcut } from '../commands/registry.ts';
import { languageColor, resolveLanguage } from '../core/languages.ts';
import { useLibrary } from '../state/library-store.ts';
import { useUi } from '../state/ui-store.ts';
import './Hud.css';

export function Hud(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  const rawQuery = useLibrary((state) => state.rawQuery);
  const setRawQuery = useLibrary((state) => state.setRawQuery);
  const clearSearch = useLibrary((state) => state.clearSearch);
  const total = useLibrary((state) => state.searchTotal);
  const elapsed = useLibrary((state) => state.searchElapsedMs);
  const sessionCount = useLibrary((state) => state.sessions.length);
  const busy = useLibrary((state) => state.busy);
  const busyLabel = useLibrary((state) => state.busyLabel);
  const busyProgress = useLibrary((state) => state.busyProgress);

  const fps = useUi((state) => state.fps);
  const qualityTier = useUi((state) => state.qualityTier);
  const inspectorOpen = useUi((state) => state.inspectorOpen);
  const timelineOpen = useUi((state) => state.timelineOpen);
  const legendOpen = useUi((state) => state.legendOpen);

  const searching = rawQuery.trim().length > 0;

  // `/` focuses the inline search the way it does in every developer tool.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <header className="hud">
      <div className="hud__brand">
        <span className="hud__mark" aria-hidden="true" />
        <span className="hud__name">Artix</span>
        <span className="hud__count mono">
          {sessionCount.toLocaleString()} session{sessionCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="hud__search">
        <svg className="hud__search-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>

        <input
          ref={inputRef}
          className="hud__search-input"
          type="search"
          value={rawQuery}
          placeholder="Search sessions…  try  tag:infra  lang:rust  since:30d"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setRawQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              clearSearch();
              inputRef.current?.blur();
            }
            if (event.key === 'Enter') {
              // Enter hands off to the palette, where results are navigable.
              useUi.getState().setOverlay('palette');
            }
          }}
          aria-label="Search sessions"
        />

        {searching ? (
          <span className="hud__search-meta mono">
            {total.toLocaleString()} · {elapsed.toFixed(1)}ms
          </span>
        ) : (
          <kbd className="hud__kbd">{displayShortcut(commands.get('artix.search')?.shortcut ?? 'Mod+K')}</kbd>
        )}
      </div>

      <div className="hud__actions">
        {/* Always reachable. Previously importing was only offered on the empty
            state, so the moment a library had one session the feature became
            invisible and the only route left was a shortcut nobody would guess. */}
        <button
          className="btn btn--primary hud__import"
          onClick={() =>
            void commands.run('artix.importClaudeCode', {
              selectedIds: [],
              inSession: false,
              inSearch: false,
            })
          }
          title="Scan ~/.claude/projects and import every session (Ctrl+Shift+I)"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M8 2v8M8 10L5 7M8 10l3-3M3 12.5h10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Import sessions
        </button>

        {busy && (
          <div className="hud__job" title={busyLabel}>
            <div className="hud__job-bar">
              <div className="hud__job-fill" style={{ width: `${Math.round(busyProgress * 100)}%` }} />
            </div>
            <span className="hud__job-label truncate">{busyLabel}</span>
          </div>
        )}

        <div className="hud__stats mono" title={`Render quality: ${qualityTier}`}>
          <span className={fps < 45 ? 'is-warn' : ''}>{fps}</span>
          <span className="hud__stats-unit">fps</span>
        </div>

        <HudToggle
          label="Legend"
          active={legendOpen}
          onClick={() => useUi.getState().setLegendOpen(!legendOpen)}
        />
        <HudToggle
          label="Timeline"
          active={timelineOpen}
          onClick={() => useUi.getState().setTimelineOpen(!timelineOpen)}
        />
        <HudToggle
          label="Inspector"
          active={inspectorOpen}
          onClick={() => useUi.getState().setInspectorOpen(!inspectorOpen)}
        />

        <button
          className="btn btn--ghost btn--icon"
          onClick={() => useUi.getState().setOverlay('settings')}
          title="Settings"
          aria-label="Settings"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {legendOpen && <Legend />}
    </header>
  );
}

function HudToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      className={`hud__toggle${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

/**
 * Colour legend.
 *
 * Only shows languages actually present in the library — a full registry dump
 * would be a wall of colours the user has never seen in their galaxy.
 */
function Legend(): JSX.Element {
  const facets = useLibrary((state) => state.facets);
  const languages = facets?.languages.slice(0, 14) ?? [];

  return (
    <div className="legend panel">
      <div className="label legend__heading">Language</div>
      <ul className="legend__list">
        {languages.map((bucket) => (
          <LegendRow key={bucket.value} value={bucket.value} count={bucket.count} />
        ))}
        {languages.length === 0 && <li className="legend__empty">No sessions yet</li>}
      </ul>

      <div className="label legend__heading">Object</div>
      <ul className="legend__list">
        <li className="legend__row">
          <span className="legend__glyph legend__glyph--star" />
          <span>Star — large project</span>
        </li>
        <li className="legend__row">
          <span className="legend__glyph legend__glyph--planet" />
          <span>Planet — focused task</span>
        </li>
        <li className="legend__row">
          <span className="legend__glyph legend__glyph--asteroid" />
          <span>Asteroid — small or archived</span>
        </li>
      </ul>

      <p className="legend__note">
        Distance from the core is age. Size is complexity. Brightness is importance.
      </p>
    </div>
  );
}

function LegendRow({ value, count }: { value: string; count: number }): JSX.Element {
  const color = languageColor(value);
  return (
    <li className="legend__row">
      <span className="legend__swatch" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      <span className="legend__label truncate">{resolveLanguage(value).label}</span>
      <span className="legend__count mono">{count}</span>
    </li>
  );
}
