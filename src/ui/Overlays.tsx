/**
 * Modal overlays: settings, export, shortcuts, about.
 *
 * Grouped in one module because they share the same shell and are each small;
 * splitting them would produce four files of imports and one of content.
 */

import { useEffect, useMemo, useState } from 'react';

import { commands, displayShortcut } from '../commands/registry.ts';
import { exporters, runExport } from '../exporters/registry.ts';
import { DEFAULT_EXPORT_OPTIONS } from '../exporters/types.ts';
import { notify } from '../core/events.ts';
import { pickSaveDestination, downloadText } from '../services/dialogs.ts';
import { APP_VERSION, getApp, updateSettings } from '../state/app.ts';
import { useLibrary } from '../state/library-store.ts';
import { useUi } from '../state/ui-store.ts';
import type { AppSettings } from '../storage/settings.ts';
import type { PluginManifest } from '../plugins/api.ts';
import type { SessionId } from '../core/types.ts';

/* ------------------------------------------------------------------ shell */

function Overlay({
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}): JSX.Element {
  const close = () => useUi.getState().setOverlay('none');

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="overlay overlay--center" onMouseDown={close}>
      <div
        className="overlay__panel"
        style={wide ? { width: 'min(880px, 94vw)' } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="overlay__header">
          <div>
            <div className="overlay__title">{title}</div>
            {subtitle && <div className="overlay__subtitle">{subtitle}</div>}
          </div>
          <button className="btn btn--ghost btn--icon" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="overlay__body">{children}</div>

        {footer && <footer className="overlay__footer">{footer}</footer>}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="field">
      <div>
        <div className="field__label">{label}</div>
        {hint && <div className="field__hint">{hint}</div>}
      </div>
      <button
        className="switch"
        data-on={value}
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
      />
    </div>
  );
}

/* --------------------------------------------------------------- settings */

export function SettingsOverlay(): JSX.Element {
  const settings = useUi((state) => state.settings);
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [plugins, setPlugins] = useState<PluginManifest[]>(() => getApp()?.plugins.manifests() ?? []);

  const storage = getApp()?.storage;

  // The SessionEnd hook's real state lives in ~/.claude/settings.json, not in
  // Artix's own settings — read it directly so the toggle reflects reality.
  const [hook, setHook] = useState<{ installed: boolean; unavailable: boolean; busy: boolean }>({
    installed: false,
    unavailable: true,
    busy: false,
  });

  useEffect(() => {
    const host = getApp()?.plugins;
    if (!host) return;
    return host.subscribe(() => setPlugins(host.manifests()));
  }, []);

  useEffect(() => {
    if (!storage) return;
    let live = true;
    void import('../services/session-hook.ts').then(async ({ sessionHookStatus }) => {
      const status = await sessionHookStatus(storage);
      if (live) setHook((h) => ({ ...h, installed: status.installed, unavailable: status.unavailable ?? false }));
    });
    return () => {
      live = false;
    };
  }, [storage]);

  const toggleHook = async (enable: boolean) => {
    if (!storage) return;

    if (enable) {
      const proceed = window.confirm(
        'Install an instant-sync hook into Claude Code?\n\n' +
          'This adds a SessionEnd hook to ~/.claude/settings.json that runs Artix ' +
          'when a session ends, so finished sessions appear here within seconds ' +
          'instead of on a timer.\n\n' +
          'It edits your global Claude Code config (only the Artix entry; ' +
          'everything else is preserved) and runs a local command — nothing is ' +
          'sent anywhere.',
      );
      if (!proceed) return;
    }

    setHook((h) => ({ ...h, busy: true }));
    const { installSessionHook, removeSessionHook } = await import('../services/session-hook.ts');
    const result = enable ? await installSessionHook(storage) : await removeSessionHook(storage);

    if (result.ok) {
      setHook((h) => ({ ...h, installed: enable, busy: false }));
      notify(
        'success',
        enable ? 'Instant sync enabled.' : 'Instant sync disabled.',
        enable ? 'New Claude Code sessions now sync the moment they end.' : undefined,
      );
    } else {
      setHook((h) => ({ ...h, busy: false }));
      notify('error', result.error.message, result.error.hint);
    }
  };

  const apply = (next: AppSettings) => {
    setDraft(next);
    // Applied live — settings that need a confirmation step usually mean the
    // preview is not trustworthy, and here it is.
    void updateSettings(next);
  };

  const galaxy = draft.galaxy;
  const setGalaxy = (patch: Partial<AppSettings['galaxy']>) =>
    apply({ ...draft, galaxy: { ...galaxy, ...patch } });

  return (
    <Overlay title="Settings" subtitle="Everything is stored locally.">
      <div className="section-heading">Appearance</div>

      <div className="field">
        <div>
          <div className="field__label">Theme</div>
          <div className="field__hint">Affects the interface only, never the galaxy.</div>
        </div>
        <div className="field__control">
          <select
            className="input"
            value={draft.theme}
            onChange={(event) => apply({ ...draft, theme: event.target.value as AppSettings['theme'] })}
          >
            <option value="deep-space">Deep space</option>
            <option value="void">Void</option>
            <option value="observatory">Observatory</option>
          </select>
        </div>
      </div>

      <div className="section-heading">Rendering</div>

      <div className="field">
        <div>
          <div className="field__label">Quality</div>
          <div className="field__hint">
            Automatic watches frame time and steps down if the scene cannot hold 60 FPS.
          </div>
        </div>
        <div className="field__control">
          <select
            className="input"
            value={galaxy.quality}
            onChange={(event) => setGalaxy({ quality: event.target.value as typeof galaxy.quality })}
          >
            <option value="auto">Automatic</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="ultra">Ultra</option>
          </select>
        </div>
      </div>

      <Toggle
        label="Bloom"
        hint="Light bleed around bright stars."
        value={galaxy.bloom}
        onChange={(bloom) => setGalaxy({ bloom })}
      />
      <Toggle
        label="Depth of field"
        hint="Defocuses stars away from the focal plane."
        value={galaxy.depthOfField}
        onChange={(depthOfField) => setGalaxy({ depthOfField })}
      />
      <Toggle
        label="Nebula"
        hint="Volumetric background clouds. The most expensive effect."
        value={galaxy.nebula}
        onChange={(nebula) => setGalaxy({ nebula })}
      />
      <Toggle
        label="Dust"
        hint="Foreground motes that give the camera a parallax reference."
        value={galaxy.dust}
        onChange={(dust) => setGalaxy({ dust })}
      />
      <Toggle
        label="Orbital motion"
        hint="Rigid pattern rotation. Turning this off freezes the galaxy completely."
        value={galaxy.motion}
        onChange={(motion) => setGalaxy({ motion })}
      />
      <Toggle
        label="Star labels"
        hint="Titles beside the nearest stars."
        value={galaxy.labels}
        onChange={(labels) => setGalaxy({ labels })}
      />
      <Toggle
        label="Respect reduced motion"
        hint="Follow the operating system's reduce-motion preference."
        value={galaxy.respectReducedMotion}
        onChange={(respectReducedMotion) => setGalaxy({ respectReducedMotion })}
      />

      <div className="section-heading">Import</div>

      <Toggle
        label="Sync Claude Code automatically"
        hint="Scans ~/.claude/projects shortly after launch and every few minutes, importing only what changed. Everything stays on this machine."
        value={draft.import.autoSync}
        onChange={(autoSync) => apply({ ...draft, import: { ...draft.import, autoSync } })}
      />
      <div className="field">
        <div>
          <div className="field__label">Sync interval</div>
          <div className="field__hint">How often to check while Artix is open.</div>
        </div>
        <div className="field__control">
          <select
            className="input"
            value={draft.import.autoSyncMinutes}
            disabled={!draft.import.autoSync}
            onChange={(event) =>
              apply({
                ...draft,
                import: { ...draft.import, autoSyncMinutes: Number(event.target.value) },
              })
            }
          >
            <option value={2}>Every 2 minutes</option>
            <option value={5}>Every 5 minutes</option>
            <option value={10}>Every 10 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Hourly</option>
          </select>
        </div>
      </div>

      {!hook.unavailable && (
        <div className="field">
          <div>
            <div className="field__label">Instant sync (Claude Code hook)</div>
            <div className="field__hint">
              Sync the moment a Claude Code session ends, instead of waiting for the timer. Adds a
              SessionEnd hook to <code>~/.claude/settings.json</code>; only the Artix entry is
              touched, and it runs a local command — nothing is sent anywhere.
            </div>
          </div>
          <button
            className="switch"
            data-on={hook.installed}
            role="switch"
            aria-checked={hook.installed}
            aria-label="Instant sync hook"
            disabled={hook.busy}
            onClick={() => void toggleHook(!hook.installed)}
          />
        </div>
      )}

      <Toggle
        label="Skip duplicates"
        hint="Sessions whose content hash is already stored are ignored on import."
        value={draft.import.skipDuplicates}
        onChange={(skipDuplicates) =>
          apply({ ...draft, import: { ...draft.import, skipDuplicates } })
        }
      />
      <Toggle
        label="Scan watched folders on launch"
        hint="Artix never reads files in the background unless this is on."
        value={draft.import.scanOnLaunch}
        onChange={(scanOnLaunch) => apply({ ...draft, import: { ...draft.import, scanOnLaunch } })}
      />

      <div className="section-heading">Plugins</div>

      {plugins.length === 0 && <p className="field__hint">No plugins installed.</p>}

      {plugins.map((plugin) => (
        <div className="field" key={plugin.id}>
          <div>
            <div className="field__label">
              {plugin.name}{' '}
              <span className="chip">{plugin.builtin ? 'built-in' : plugin.version}</span>
            </div>
            <div className="field__hint">
              {plugin.error ? <span style={{ color: 'var(--danger)' }}>{plugin.error}</span> : plugin.description}
            </div>
          </div>
          <button
            className="switch"
            data-on={plugin.enabled}
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`Enable ${plugin.name}`}
            onClick={() => {
              const enabled = plugin.enabled
                ? draft.plugins.filter((id) => id !== plugin.id)
                : [...draft.plugins, plugin.id];
              apply({ ...draft, plugins: enabled });
            }}
          />
        </div>
      ))}

      <div className="section-heading">Maintenance</div>

      <div className="field">
        <div>
          <div className="field__label">Search index</div>
          <div className="field__hint">
            Rebuild if search results look stale or incomplete. Safe to run at any time.
          </div>
        </div>
        <div className="field__control">
          <button
            className="btn"
            onClick={() => void commands.run('artix.reindex', { selectedIds: [], inSession: false, inSearch: false })}
          >
            Reindex
          </button>
        </div>
      </div>

      <div className="field">
        <div>
          <div className="field__label">Relationships</div>
          <div className="field__hint">
            Recompute the links between sessions that share files, technologies or a project.
          </div>
        </div>
        <div className="field__control">
          <button className="btn" onClick={() => void useLibrary.getState().rebuildLinks()}>
            Rebuild
          </button>
        </div>
      </div>

      {storage?.capabilities.persistent && (
        <div className="field">
          <div>
            <div className="field__label">Database</div>
            <div className="field__hint">
              Reclaim space after deleting a lot of sessions. {storage.capabilities.label}.
            </div>
          </div>
          <div className="field__control">
            <button
              className="btn"
              onClick={() =>
                void commands.run('artix.vacuum', { selectedIds: [], inSession: false, inSearch: false })
              }
            >
              Compact
            </button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

/* ----------------------------------------------------------------- export */

export function ExportOverlay({ selectedId }: { selectedId: SessionId | null }): JSX.Element {
  const sessions = useLibrary((state) => state.sessions);
  const hits = useLibrary((state) => state.hits);
  const rawQuery = useLibrary((state) => state.rawQuery);

  const [exporterId, setExporterId] = useState('core:markdown');
  const [scope, setScope] = useState<'selected' | 'results' | 'all'>(
    selectedId ? 'selected' : 'all',
  );
  const [options, setOptions] = useState(DEFAULT_EXPORT_OPTIONS);
  const [running, setRunning] = useState(false);

  const available = useMemo(() => exporters.list(), []);

  const ids = useMemo<SessionId[]>(() => {
    if (scope === 'selected') return selectedId ? [selectedId] : [];
    if (scope === 'results') return hits.map((hit) => hit.session.id);
    return sessions.map((session) => session.id);
  }, [scope, selectedId, hits, sessions]);

  const exporter = exporters.get(exporterId);

  const doExport = async () => {
    const app = getApp();
    if (!app || !exporter || ids.length === 0) return;

    setRunning(true);
    try {
      const multi = exporter.multiFile && ids.length > 1;
      const extension = multi ? 'zip' : exporter.extension;
      const defaultName = `artix-export.${extension}`;

      if (app.storage.capabilities.filesystem) {
        const destination = await pickSaveDestination(defaultName, [extension]);
        if (!destination) return;

        const result = await runExport(app.storage, {
          exporterId,
          sessionIds: ids,
          destination,
          options,
        });

        if (result.ok) {
          notify('success', `Exported ${result.value.files} file${result.value.files === 1 ? '' : 's'}.`, destination);
          useUi.getState().setOverlay('none');
        } else {
          notify('error', result.error.message);
        }
        return;
      }

      // Browser build: render in memory and download. Multi-file exports fall
      // back to concatenation, since there is no ZIP writer without the backend.
      const details = [];
      for (const id of ids) {
        const detail = await app.storage.getSession(id);
        if (detail.ok) details.push(detail.value);
      }
      const files = exporter.render(details, options);
      const content = files.map((file) => file.content).join('\n\n---\n\n');
      downloadText(`artix-export.${exporter.extension}`, content);
      notify('success', `Exported ${details.length} session${details.length === 1 ? '' : 's'}.`);
      useUi.getState().setOverlay('none');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Overlay
      title="Export"
      subtitle={`${ids.length.toLocaleString()} session${ids.length === 1 ? '' : 's'} selected`}
      footer={
        <>
          <button className="btn" onClick={() => useUi.getState().setOverlay('none')}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={ids.length === 0 || running}
            onClick={() => void doExport()}
          >
            {running ? 'Exporting…' : 'Export'}
          </button>
        </>
      }
    >
      <div className="section-heading">Format</div>

      {available.map((option) => (
        <label className="field" key={option.id} style={{ cursor: 'pointer' }}>
          <div>
            <div className="field__label">{option.label}</div>
            <div className="field__hint">{option.description}</div>
          </div>
          <div className="field__control">
            <input
              type="radio"
              name="exporter"
              checked={exporterId === option.id}
              onChange={() => setExporterId(option.id)}
            />
          </div>
        </label>
      ))}

      <div className="section-heading">Scope</div>

      <div className="field">
        <div className="field__label">Which sessions</div>
        <div className="field__control">
          <select
            className="input"
            value={scope}
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            <option value="selected" disabled={!selectedId}>
              Selected session
            </option>
            <option value="results" disabled={hits.length === 0}>
              Search results{rawQuery ? ` (${hits.length})` : ''}
            </option>
            <option value="all">Entire library ({sessions.length})</option>
          </select>
        </div>
      </div>

      <div className="section-heading">Contents</div>

      <Toggle
        label="Conversation"
        value={options.includeConversation}
        onChange={(includeConversation) => setOptions({ ...options, includeConversation })}
      />
      <Toggle
        label="Code artifacts"
        value={options.includeCode}
        onChange={(includeCode) => setOptions({ ...options, includeCode })}
      />
      <Toggle
        label="File references"
        value={options.includeFiles}
        onChange={(includeFiles) => setOptions({ ...options, includeFiles })}
      />
      <Toggle
        label="My notes"
        value={options.includeNotes}
        onChange={(includeNotes) => setOptions({ ...options, includeNotes })}
      />
    </Overlay>
  );
}

/* -------------------------------------------------------------- shortcuts */

export function ShortcutsOverlay(): JSX.Element {
  const grouped = useMemo(() => {
    const map = new Map<string, { title: string; shortcut: string }[]>();
    for (const command of commands.list()) {
      if (!command.shortcut) continue;
      const bucket = map.get(command.category) ?? [];
      bucket.push({ title: command.title, shortcut: command.shortcut });
      map.set(command.category, bucket);
    }
    return [...map.entries()];
  }, []);

  return (
    <Overlay title="Keyboard shortcuts" subtitle="Everything is also in the palette.">
      {grouped.map(([category, items]) => (
        <div key={category}>
          <div className="section-heading">{category}</div>
          {items.map((item) => (
            <div className="field" key={item.title}>
              <div className="field__label">{item.title}</div>
              <kbd className="chip mono">{displayShortcut(item.shortcut)}</kbd>
            </div>
          ))}
        </div>
      ))}

      <div className="section-heading">Galaxy</div>
      {[
        ['Zoom', 'Mouse wheel / trackpad'],
        ['Orbit', 'Drag'],
        ['Pan', 'Middle-drag or Shift + drag'],
        ['Select and travel', 'Click'],
        ['Open session', 'Double-click'],
        ['Context menu', 'Right-click'],
        ['Focus search', '/'],
      ].map(([action, gesture]) => (
        <div className="field" key={action}>
          <div className="field__label">{action}</div>
          <span className="chip">{gesture}</span>
        </div>
      ))}
    </Overlay>
  );
}

/* ------------------------------------------------------------------ about */

export function AboutOverlay(): JSX.Element {
  const stats = useLibrary((state) => state.stats);
  const storage = getApp()?.storage;

  return (
    <Overlay title="Artix" subtitle={`Version ${APP_VERSION}`}>
      <p className="field__hint" style={{ maxWidth: 'none', marginBottom: 'var(--space-6)' }}>
        Artix is long-term memory for Claude Code. It archives, indexes and reconstructs past
        development sessions so you can resume work without re-explaining your project.
      </p>

      <div className="section-heading">Privacy</div>
      <p className="field__hint" style={{ maxWidth: 'none' }}>
        Everything lives in a single local database. Artix has no account system, sends no
        telemetry, and makes no network requests — the desktop build does not link a network stack
        at all. It works with the network turned off, permanently.
      </p>

      <div className="section-heading">Storage</div>
      <div className="field">
        <div className="field__label">Backend</div>
        <span className="chip">{storage?.capabilities.label ?? 'unknown'}</span>
      </div>
      <div className="field">
        <div className="field__label">Full-text search</div>
        <span className="chip">
          {storage?.capabilities.fullTextSearch ? 'SQLite FTS5' : 'In-memory index'}
        </span>
      </div>
      {stats && (
        <>
          <div className="field">
            <div className="field__label">Sessions</div>
            <span className="mono">{stats.sessionCount.toLocaleString()}</span>
          </div>
          <div className="field">
            <div className="field__label">Messages indexed</div>
            <span className="mono">{stats.messageCount.toLocaleString()}</span>
          </div>
        </>
      )}
    </Overlay>
  );
}
