/**
 * Plugin API.
 *
 * The contract a plugin sees. Everything a plugin can do goes through this
 * object — plugins never import Artix internals directly, which is what makes
 * the core replaceable underneath them.
 *
 * Design rules:
 *  - Every `contribute*` call returns a disposer. Deactivation is exact.
 *  - Storage is exposed read-mostly; writes go through narrow, audited methods.
 *  - No network primitives are provided, deliberately. Artix is offline, and a
 *    plugin cannot change that through this API.
 */

import type { ArtixEventName, ArtixEvents, Unsubscribe } from '../core/events.ts';
import type { Session, SessionDetail, SessionId } from '../core/types.ts';
import type { Result } from '../core/result.ts';
import type { Importer } from '../importers/types.ts';
import type { Exporter } from '../exporters/types.ts';
import type { Command } from '../commands/registry.ts';

/** Where a panel contribution can appear. */
export type PanelSlot = 'session-sidebar' | 'session-tab' | 'galaxy-overlay' | 'settings';

export interface PanelContribution {
  id: string;
  title: string;
  slot: PanelSlot;
  /** Rendered by the host. Returning null hides the panel for this context. */
  render: (context: PanelContext) => unknown;
  order?: number;
}

export interface PanelContext {
  session: SessionDetail | null;
  selectedIds: SessionId[];
}

/**
 * An alternative way to visualise the library. The galaxy itself is registered
 * through this same mechanism, so a plugin's visualisation is a first-class
 * peer rather than a bolt-on.
 */
export interface VisualizationContribution {
  id: string;
  label: string;
  description: string;
  /** Mounts into a container and returns a teardown function. */
  mount: (container: HTMLElement, api: VisualizationHost) => () => void;
}

export interface VisualizationHost {
  sessions: readonly Session[];
  selectedId: SessionId | null;
  highlighted: ReadonlySet<SessionId> | null;
  onSelect: (id: SessionId | null) => void;
  onOpen: (id: SessionId) => void;
}

/** Read-only view of the library handed to plugins. */
export interface PluginStorage {
  listSessions(): Promise<Result<Session[]>>;
  getSession(id: SessionId): Promise<Result<SessionDetail>>;
  /** Namespaced key/value store. Keys are prefixed with the plugin id. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface ArtixPluginApi {
  /** The host application version, for compatibility checks. */
  readonly version: string;
  /** The plugin's own id — namespaces its storage and contributions. */
  readonly pluginId: string;

  contributeImporter(importer: Importer): Unsubscribe;
  contributeExporter(exporter: Exporter): Unsubscribe;
  contributeCommand(command: Command): Unsubscribe;
  contributePanel(panel: PanelContribution): Unsubscribe;
  contributeVisualization(visualization: VisualizationContribution): Unsubscribe;

  /** Subscribe to application events. Automatically disposed on deactivate. */
  on<K extends ArtixEventName>(event: K, listener: (payload: ArtixEvents[K]) => void): Unsubscribe;

  readonly storage: PluginStorage;

  /** Show a message to the user. */
  notify(level: 'info' | 'success' | 'warn' | 'error', message: string, detail?: string): void;

  /** Structured logging, prefixed with the plugin id. */
  readonly log: {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  };
}

/** Everything a plugin module must export. */
export interface ArtixPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Minimum host version this plugin supports, e.g. `>=0.1.0`. */
  readonly requires?: string;

  /** Called when the plugin is enabled. May be async. */
  activate(api: ArtixPluginApi): void | Promise<void>;
  /** Called when the plugin is disabled. Contributions are disposed for you. */
  deactivate?(): void | Promise<void>;
}

/** Metadata the settings UI shows without activating anything. */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  builtin: boolean;
  /** Populated when activation failed. */
  error?: string;
}
