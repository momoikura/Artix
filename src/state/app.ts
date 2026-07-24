/**
 * Application container.
 *
 * Wires storage, plugins, commands and settings together and hands the result
 * to React. This is the only place that knows about *all* the subsystems —
 * everything else depends on one or two.
 */

import { bus, notify } from '../core/events.ts';
import { commands } from '../commands/registry.ts';
import { copyContextBundle, exporters, runExport } from '../exporters/registry.ts';
import { importers, runImport } from '../importers/registry.ts';
import { BUILTIN_PLUGINS, PluginHost } from '../plugins/index.ts';
import { createStorage, loadSettings, saveSettings } from '../storage/index.ts';
import { isTauri } from '../storage/tauri-adapter.ts';
import { downloadText, pickFolder, pickImportSources, pickSaveDestination } from '../services/dialogs.ts';
import { useLibrary } from './library-store.ts';
import { useUi, connectNotifications } from './ui-store.ts';
import type { AppSettings } from '../storage/settings.ts';
import type { StorageAdapter } from '../storage/adapter.ts';
import type { SessionId } from '../core/types.ts';

export const APP_VERSION = '0.1.2';

export interface ArtixApp {
  storage: StorageAdapter;
  plugins: PluginHost;
  dispose: () => void;
}

let instance: ArtixApp | null = null;

/**
 * Boot the application. Idempotent — React strict mode calls effects twice and
 * must not produce two databases, two plugin hosts and two command sets.
 */
export async function bootstrapApp(options: { demoSessions?: number } = {}): Promise<ArtixApp> {
  if (instance) return instance;

  // The native window starts hidden (so the hook's `--sync` path can exit
  // without a flash). Reveal it now that the webview is live — the boot splash
  // in index.html covers the rest of the load.
  void revealWindow();

  const storage = createStorage({ demoSessions: options.demoSessions ?? 0 });
  const plugins = new PluginHost(storage, APP_VERSION);
  for (const plugin of BUILTIN_PLUGINS) plugins.add(plugin, true);

  const disposeNotifications = connectNotifications();

  await useLibrary.getState().attach(storage);

  const settings = await loadSettings(storage);
  useUi.getState().setSettings(settings);
  await plugins.sync(settings.plugins);

  const disposeCommands = registerCoreCommands(storage);
  const stopAutoSync = startAutoSync(storage, settings);
  const disposeSyncBridge = connectSyncBridge(storage);

  instance = {
    storage,
    plugins,
    dispose: () => {
      stopAutoSync();
      disposeSyncBridge();
      disposeCommands();
      disposeNotifications();
      void plugins.deactivateAll();
      instance = null;
    },
  };

  return instance;
}

/**
 * Bridge the native "sync requested" event to an incremental sync.
 *
 * The Claude Code SessionEnd hook launches `artix --sync`; the single-instance
 * plugin forwards that to the running app as an event, which lands here and
 * triggers exactly the same incremental sync the interval timer uses. That is
 * what makes a finished session appear in the galaxy within a second or two,
 * rather than at the next timer tick.
 */
function connectSyncBridge(storage: StorageAdapter): () => void {
  if (!isTauri()) return () => {};

  let unlisten: (() => void) | undefined;
  let disposed = false;
  let running = false;

  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const stop = await listen('artix://sync-requested', async () => {
      if (running) return;
      running = true;
      try {
        const { syncClaudeSessions } = await import('../services/claude-code.ts');
        const result = await syncClaudeSessions(storage, (sources) =>
          runImport(storage, { sources }),
        );
        const changed = result.imported + result.updated;
        if (changed > 0) {
          notify('success', `Synced ${changed} session${changed === 1 ? '' : 's'} from Claude Code.`);
        }
      } catch (e) {
        console.warn('[artix] hook-triggered sync failed', e);
      } finally {
        running = false;
      }
    });
    if (disposed) stop();
    else unlisten = stop;
  })();

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Keep the library current with Claude Code without the user doing anything.
 *
 * Runs once shortly after launch, then on an interval while Artix is open.
 * Deliberately *not* a filesystem watcher: transcripts are written
 * continuously during a session, so a watcher would fire hundreds of times and
 * repeatedly import half-finished conversations. A periodic incremental scan
 * costs almost nothing (it compares modification times and usually reads
 * nothing) and naturally captures a session once it has settled.
 *
 * Nothing leaves the machine — this is a local file read into a local database.
 */
function startAutoSync(storage: StorageAdapter, settings: AppSettings): () => void {
  if (!storage.capabilities.filesystem || !settings.import.autoSync) return () => {};

  let stopped = false;
  let running = false;

  const runOnce = async (announce: boolean) => {
    if (stopped || running) return;
    running = true;
    try {
      const importSources = (sources: Parameters<typeof runImport>[1]['sources']) =>
        runImport(storage, { sources });

      // 1. Claude Code's own local transcript store.
      const { syncClaudeSessions } = await import('../services/claude-code.ts');
      const cc = await syncClaudeSessions(storage, importSources);

      // 2. Copilot Chat — also stored locally, so it needs no export step.
      const { syncCopilotSessions } = await import('../services/copilot-source.ts');
      const cp = settings.import.syncCopilot
        ? await syncCopilotSessions(storage, importSources)
        : null;

      // 3. Watched folders — where exports from ChatGPT, Claude.ai, Gemini and
      //    anything else land. The importer registry auto-detects each format.
      const { syncWatchedFolders } = await import('../services/folder-sync.ts');
      const folders = settings.import.watchedFolders;
      const wf = folders.length > 0 ? await syncWatchedFolders(storage, folders, importSources) : null;

      const imported = cc.imported + (cp?.imported ?? 0) + (wf?.imported ?? 0);
      const updated = cc.updated + (cp?.updated ?? 0) + (wf?.updated ?? 0);
      const changed = imported + updated;

      if (changed > 0) {
        notify('success', `Synced ${changed} session${changed === 1 ? '' : 's'}.`, [
          imported > 0 ? `${imported} new` : '',
          updated > 0 ? `${updated} updated` : '',
        ]
          .filter(Boolean)
          .join(' · '));
      } else if (announce) {
        notify('info', 'Sessions are up to date.');
      }
    } catch (e) {
      // A background sync must never interrupt the user with a stack trace.
      console.warn('[artix] auto-sync failed', e);
    } finally {
      running = false;
    }
  };

  // Let the galaxy render before touching the disk.
  const initial = setTimeout(() => void runOnce(false), 2500);
  const interval = setInterval(
    () => void runOnce(false),
    Math.max(1, settings.import.autoSyncMinutes) * 60_000,
  );

  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}

export function getApp(): ArtixApp | null {
  return instance;
}

/** Show the native window (a no-op in the browser build). */
async function revealWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('show_main_window');
  } catch {
    // If the window cannot be shown the app is unusable anyway; nothing to do.
  }
}

/** Persist settings and apply any side effects (plugin enable/disable). */
export async function updateSettings(next: AppSettings): Promise<void> {
  const app = instance;
  useUi.getState().setSettings(next);
  if (!app) return;

  await saveSettings(app.storage, next);
  await app.plugins.sync(next.plugins);
}

/* ---------------------------------------------------------------- commands */

function registerCoreCommands(storage: StorageAdapter): () => void {
  const library = () => useLibrary.getState();
  const ui = () => useUi.getState();

  return commands.registerAll([
    {
      id: 'artix.search',
      title: 'Search sessions',
      category: 'Navigate',
      shortcut: 'Mod+K',
      keywords: ['find', 'filter', 'query', 'palette'],
      order: 1,
      run: () => ui().setOverlay('palette'),
    },
    {
      id: 'artix.overview',
      title: 'Return to galaxy overview',
      category: 'Navigate',
      shortcut: 'Mod+0',
      keywords: ['zoom out', 'home', 'reset camera'],
      order: 2,
      run: () => bus.emit('camera:focus', { id: '' as SessionId, immediate: false }),
    },
    {
      id: 'artix.close',
      title: 'Close overlay',
      category: 'Navigate',
      shortcut: 'Escape',
      order: 3,
      when: (context) => context.inSession || useUi.getState().overlay !== 'none',
      run: () => {
        const state = ui();
        if (state.overlay !== 'none') state.setOverlay('none');
        else library().closeSession();
      },
    },
    {
      id: 'artix.openSelected',
      title: 'Open selected session',
      category: 'Session',
      keywords: ['detail', 'inspect'],
      when: (context) => context.selectedIds.length > 0,
      run: (context) => {
        const id = context.selectedIds[0];
        if (id) void library().open(id as SessionId);
      },
    },
    {
      id: 'artix.copyContext',
      title: 'Copy context bundle',
      category: 'Session',
      shortcut: 'Mod+Shift+C',
      keywords: ['resume', 'paste', 'claude', 'continue', 'clipboard'],
      order: 1,
      when: (context) => context.selectedIds.length > 0,
      run: async (context) => {
        const ids = context.selectedIds as SessionId[];
        const result = await copyContextBundle(storage, ids);
        if (!result.ok) {
          // Clipboard denied: fall back to a download so the work is not lost.
          notify('warn', result.error.message, result.error.hint);
        }
      },
    },
    {
      id: 'artix.resumeInClaude',
      title: 'Resume in Claude Code (write CLAUDE.md)',
      category: 'Session',
      shortcut: 'Mod+Shift+R',
      keywords: ['resume', 'claude', 'memory', 'context', 'continue', 'handoff'],
      order: 2,
      when: (context) => context.selectedIds.length > 0 && storage.capabilities.filesystem,
      run: async (context) => {
        const { writeResumeContext } = await import('../services/resume.ts');

        const details = [];
        for (const id of context.selectedIds) {
          const detail = await storage.getSession(id as SessionId);
          if (detail.ok) details.push(detail.value);
        }

        const folder = details[0]?.session.folder;
        if (!folder) {
          notify('warn', 'That session has no recorded project folder.', 'Use Copy context bundle instead.');
          return;
        }

        // Writing into someone's repo is not something to do silently.
        const proceed = window.confirm(
          `Write prior-session context into:\n\n${folder}\\CLAUDE.md\n\n` +
            'Claude Code loads this automatically, so your next session there starts ' +
            'with the context already in place.\n\n' +
            'Only the Artix-managed block is touched — the rest of the file is preserved.',
        );
        if (!proceed) return;

        const result = await writeResumeContext(storage, details);
        if (!result.ok) {
          notify('error', result.error.message, result.error.hint);
          return;
        }

        notify(
          'success',
          result.value.replaced ? 'Updated CLAUDE.md.' : 'Wrote CLAUDE.md.',
          `${result.value.path}\nYour next Claude Code session here starts with this context.`,
        );
      },
    },
    {
      id: 'artix.pin',
      title: 'Pin / unpin session',
      category: 'Session',
      keywords: ['star', 'favourite', 'favorite'],
      when: (context) => context.selectedIds.length > 0,
      run: async (context) => {
        const id = context.selectedIds[0] as SessionId | undefined;
        if (!id) return;
        const session = library().sessions.find((s) => s.id === id);
        if (!session) return;
        await library().patch(id, { pinned: !session.pinned });
      },
    },
    {
      id: 'artix.archive',
      title: 'Archive session',
      category: 'Session',
      keywords: ['hide', 'retire'],
      when: (context) => context.selectedIds.length > 0,
      run: async (context) => {
        for (const id of context.selectedIds) {
          await library().patch(id as SessionId, { status: 'archived' });
        }
        notify('success', 'Archived.');
      },
    },
    {
      id: 'artix.delete',
      title: 'Delete session',
      category: 'Session',
      keywords: ['remove', 'destroy'],
      when: (context) => context.selectedIds.length > 0,
      run: async (context) => {
        const ids = context.selectedIds as SessionId[];
        // Deletion is irreversible and there is no server-side undo, so it is
        // always confirmed regardless of where it was triggered from.
        const confirmed = window.confirm(
          ids.length === 1
            ? 'Delete this session permanently?'
            : `Delete ${ids.length} sessions permanently?`,
        );
        if (!confirmed) return;
        await library().remove(ids);
      },
    },

    {
      id: 'artix.import',
      title: 'Import sessions…',
      category: 'Library',
      shortcut: 'Mod+I',
      keywords: ['add', 'load', 'jsonl', 'markdown', 'json'],
      order: 1,
      run: async () => {
        const sources = await pickImportSources(
          { title: 'Import sessions', extensions: importers.extensions(), multiple: true },
          async (path) => {
            const result = await storage.readTextFile(path);
            return result.ok ? result.value : null;
          },
        );

        if (sources.length === 0) return;

        const report = await runImport(storage, { sources });
        notify(
          report.failed.length > 0 ? 'warn' : 'success',
          `Imported ${report.imported.length} session${report.imported.length === 1 ? '' : 's'}.`,
          [
            report.skipped.length > 0 ? `${report.skipped.length} already in library` : '',
            ...report.warnings.slice(0, 3),
          ]
            .filter(Boolean)
            .join('\n'),
        );
      },
    },
    {
      id: 'artix.importClaudeCode',
      title: 'Import from Claude Code',
      category: 'Library',
      shortcut: 'Mod+Shift+I',
      keywords: ['claude', 'sessions', 'transcripts', 'scan', 'local', 'jsonl'],
      order: 0,
      when: () => storage.capabilities.filesystem,
      run: async () => {
        const { discoverClaudeSessions, describeScan, importClaudeSessions, claudeProjectsDir } =
          await import('../services/claude-code.ts');

        const dir = await claudeProjectsDir(storage);
        if (!dir) {
          notify(
            'warn',
            'No Claude Code session store found.',
            'Expected ~/.claude/projects. Use Import… to pick transcripts manually.',
          );
          return;
        }

        const sessions = await discoverClaudeSessions(storage, dir);
        if (sessions.length === 0) {
          notify('info', 'No Claude Code transcripts found.', dir);
          return;
        }

        // Everything stays local, but reading a whole session store is still a
        // big action — say exactly what will happen before doing it.
        const proceed = window.confirm(
          `Import ${describeScan(sessions)}?\n\nFrom: ${dir}\n\n` +
            'Transcripts are copied into your local Artix library. Nothing leaves this machine.',
        );
        if (!proceed) return;

        // Batched read+import so a very large store never loads whole into RAM.
        const jobId = 'claude-scan';
        const result = await importClaudeSessions(
          storage,
          sessions,
          (sources) => runImport(storage, { sources }),
          {
            onProgress: (done, total) =>
              bus.emit('job:progress', {
                jobId,
                label: `Importing sessions (${done}/${total})`,
                done,
                total,
              }),
          },
        );
        bus.emit('job:finished', { jobId, ok: result.failed === 0, message: 'Import complete' });

        const changed = result.imported + result.updated;
        notify(
          result.failed > 0 ? 'warn' : 'success',
          `Imported ${changed} Claude Code session${changed === 1 ? '' : 's'}.`,
          [
            result.updated > 0 ? `${result.updated} updated` : '',
            result.unchanged > 0 ? `${result.unchanged} already current` : '',
            result.failed > 0 ? `${result.failed} unreadable` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        );
      },
    },
    {
      id: 'artix.importFolder',
      title: 'Import from folder…',
      category: 'Library',
      keywords: ['scan', 'directory', 'watch', 'bulk'],
      order: 2,
      when: () => storage.capabilities.filesystem,
      run: async () => {
        const folder = await pickFolder('Choose a folder to scan');
        if (!folder) return;

        const discovered = await storage.discoverFiles(folder, importers.extensions());
        if (!discovered.ok) {
          notify('error', discovered.error.message);
          return;
        }
        if (discovered.value.length === 0) {
          notify('info', 'No importable files found in that folder.');
          return;
        }

        const sources = [];
        for (const file of discovered.value) {
          const content = await storage.readTextFile(file.path);
          if (!content.ok) continue;
          sources.push({
            reference: file.path,
            name: file.name,
            content: content.value,
            modifiedAt: file.modifiedAt,
          });
        }

        const report = await runImport(storage, { sources });
        notify('success', `Imported ${report.imported.length} of ${sources.length} files.`);
      },
    },
    {
      id: 'artix.export',
      title: 'Export…',
      category: 'Library',
      shortcut: 'Mod+E',
      keywords: ['save', 'backup', 'markdown', 'zip', 'json'],
      order: 3,
      run: () => ui().setOverlay('export'),
    },
    {
      id: 'artix.backup',
      title: 'Export entire library (JSON)',
      category: 'Library',
      keywords: ['backup', 'archive', 'everything'],
      order: 4,
      run: async () => {
        const ids = library().sessions.map((s) => s.id);
        if (ids.length === 0) {
          notify('info', 'The library is empty.');
          return;
        }

        if (storage.capabilities.filesystem) {
          const destination = await pickSaveDestination('artix-backup.json', ['json']);
          if (!destination) return;
          const result = await runExport(storage, {
            exporterId: 'core:json',
            sessionIds: ids,
            destination,
          });
          notify(result.ok ? 'success' : 'error', result.ok ? `Backed up ${ids.length} sessions.` : result.error.message);
          return;
        }

        // Browser build: render in-memory and download.
        const details = [];
        for (const id of ids) {
          const detail = await storage.getSession(id);
          if (detail.ok) details.push(detail.value);
        }
        const exporter = exporters.get('core:json');
        const files = exporter?.render(details, {
          includeConversation: true,
          includeCode: true,
          includeFiles: true,
          includeNotes: true,
          maxChars: Number.MAX_SAFE_INTEGER,
        });
        if (files?.[0]) downloadText(files[0].path, files[0].content, 'application/json');
      },
    },
    {
      id: 'artix.reindex',
      title: 'Rebuild search index',
      category: 'Library',
      keywords: ['repair', 'fts', 'fix search'],
      order: 10,
      run: async () => {
        const result = await storage.reindex((done, total) => {
          bus.emit('job:progress', { jobId: 'reindex', label: 'Reindexing', done, total });
        });
        bus.emit('job:finished', { jobId: 'reindex', ok: result.ok, message: 'Reindexed' });
        notify(
          result.ok ? 'success' : 'error',
          result.ok ? `Reindexed ${result.value} sessions.` : result.error.message,
        );
      },
    },
    {
      id: 'artix.rebuildLinks',
      title: 'Rebuild relationships',
      category: 'Library',
      keywords: ['graph', 'links', 'clusters', 'related'],
      order: 11,
      run: () => library().rebuildLinks(),
    },
    {
      id: 'artix.vacuum',
      title: 'Compact database',
      category: 'Library',
      keywords: ['vacuum', 'optimise', 'optimize', 'shrink'],
      order: 12,
      run: async () => {
        const result = await storage.vacuum();
        notify(result.ok ? 'success' : 'error', result.ok ? 'Database compacted.' : result.error.message);
      },
    },

    {
      id: 'artix.settings',
      title: 'Settings',
      category: 'Application',
      shortcut: 'Mod+,',
      keywords: ['preferences', 'options', 'config'],
      order: 1,
      run: () => ui().setOverlay('settings'),
    },
    {
      id: 'artix.shortcuts',
      title: 'Keyboard shortcuts',
      category: 'Application',
      shortcut: 'Mod+/',
      keywords: ['keys', 'bindings', 'help'],
      order: 2,
      run: () => ui().setOverlay('shortcuts'),
    },
    {
      id: 'artix.toggleTimeline',
      title: 'Toggle timeline',
      category: 'View',
      shortcut: 'Mod+T',
      keywords: ['scrub', 'history', 'time'],
      run: () => ui().setTimelineOpen(!ui().timelineOpen),
    },
    {
      id: 'artix.toggleInspector',
      title: 'Toggle inspector',
      category: 'View',
      shortcut: 'Mod+B',
      keywords: ['sidebar', 'panel', 'details'],
      run: () => ui().setInspectorOpen(!ui().inspectorOpen),
    },
    {
      id: 'artix.toggleLegend',
      title: 'Toggle legend',
      category: 'View',
      shortcut: 'Mod+L',
      keywords: ['colors', 'colours', 'key', 'languages'],
      run: () => ui().setLegendOpen(!ui().legendOpen),
    },
    {
      id: 'artix.about',
      title: 'About Artix',
      category: 'Application',
      keywords: ['version', 'storage', 'offline'],
      order: 20,
      run: () => ui().setOverlay('about'),
    },
  ]);
}
