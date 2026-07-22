/**
 * Application shell.
 *
 * Owns bootstrap, global keybindings, and the layout of the persistent
 * chrome. Everything visual is a sibling of the galaxy canvas rather than a
 * child, so no panel can ever force a canvas reflow.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { attachShortcuts, commands } from './commands/registry.ts';
import { bootstrapApp } from './state/app.ts';
import { useLibrary } from './state/library-store.ts';
import { useUi } from './state/ui-store.ts';
import { GalaxyView } from './ui/GalaxyView.tsx';
import { Hud } from './ui/Hud.tsx';
import { Inspector } from './ui/Inspector.tsx';
import { Timeline } from './ui/Timeline.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { ContextMenu } from './ui/ContextMenu.tsx';
import { Toasts } from './ui/Toasts.tsx';
import { SessionWorkspace } from './ui/SessionWorkspace.tsx';
import { AboutOverlay, ExportOverlay, SettingsOverlay, ShortcutsOverlay } from './ui/Overlays.tsx';
import { EmptyLibrary } from './ui/EmptyLibrary.tsx';
import { useFileDrop } from './ui/useFileDrop.ts';
import type { CommandContext } from './commands/registry.ts';
import './App.css';

export interface AppProps {
  onReady?: () => void;
}

/**
 * Demo library size for the browser build.
 *
 * The desktop app starts empty — it is a real archive. The browser preview
 * seeds a generated galaxy so the visualisation can be evaluated immediately.
 */
const DEMO_SESSIONS = import.meta.env.DEV ? 320 : 0;

export function App({ onReady }: AppProps): JSX.Element {
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const readyFired = useRef(false);

  const overlay = useUi((state) => state.overlay);
  const inspectorOpen = useUi((state) => state.inspectorOpen);
  const timelineOpen = useUi((state) => state.timelineOpen);
  const theme = useUi((state) => state.settings.theme);

  const openSession = useLibrary((state) => state.openSession);
  const selectedId = useLibrary((state) => state.selectedId);
  const sessionCount = useLibrary((state) => state.sessions.length);
  const loading = useLibrary((state) => state.loading);
  const storage = useLibrary((state) => state.storage);

  const dropping = useFileDrop(storage);

  /* -------------------------------------------------------------- bootstrap */

  useEffect(() => {
    let cancelled = false;

    void bootstrapApp({ demoSessions: DEMO_SESSIONS })
      .then(() => {
        if (cancelled) return;
        setBooted(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setBootError(e instanceof Error ? e.message : String(e));
        setBooted(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Dismiss the splash once, after the first committed frame with data.
  useEffect(() => {
    if (!booted || readyFired.current) return;
    readyFired.current = true;
    onReady?.();
  }, [booted, onReady]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /* ------------------------------------------------------------- shortcuts */

  const getContext = useCallback((): CommandContext => {
    const library = useLibrary.getState();
    return {
      selectedIds: library.selectedId ? [library.selectedId] : [],
      inSession: library.openSession !== null,
      inSearch: useUi.getState().overlay === 'palette',
    };
  }, []);

  useEffect(() => {
    if (!booted) return;
    return attachShortcuts(commands, getContext);
  }, [booted, getContext]);

  /* ----------------------------------------------------------------- render */

  if (bootError) {
    return (
      <div className="app app--error">
        <div className="panel app__error">
          <h1>Artix could not start</h1>
          <p className="selectable">{bootError}</p>
          <p className="app__error-hint">
            Your data is untouched. If this persists, the library file may need repairing —
            see <code>docs/INSTALL.md</code>.
          </p>
        </div>
      </div>
    );
  }

  const showEmpty = booted && !loading && sessionCount === 0;

  return (
    <div className="app" data-inspector={inspectorOpen} data-timeline={timelineOpen}>
      <GalaxyView />

      <Hud />

      {inspectorOpen && <Inspector />}
      {timelineOpen && <Timeline />}

      {showEmpty && <EmptyLibrary />}

      {openSession && <SessionWorkspace key={openSession.session.id} detail={openSession} />}

      {overlay === 'palette' && <CommandPalette />}
      {overlay === 'settings' && <SettingsOverlay />}
      {overlay === 'export' && <ExportOverlay selectedId={selectedId} />}
      {overlay === 'shortcuts' && <ShortcutsOverlay />}
      {overlay === 'about' && <AboutOverlay />}

      {dropping && (
        <div className="drop-target" aria-hidden="true">
          <div className="drop-target__panel">
            <div className="drop-target__icon">↓</div>
            <div className="drop-target__title">Drop to import</div>
            <div className="drop-target__hint">
              Transcripts, exports and archives. Duplicates are skipped automatically.
            </div>
          </div>
        </div>
      )}

      <ContextMenu />
      <Toasts />
    </div>
  );
}
