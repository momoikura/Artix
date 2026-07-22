/**
 * Plugin host.
 *
 * Owns activation, deactivation and — critically — cleanup. Every contribution
 * a plugin makes is tracked, so deactivating always leaves the application in
 * exactly the state it was in before activation. A plugin that throws during
 * activation is disabled and reported rather than taking the app down.
 */

import { bus, notify } from '../core/events.ts';
import { commands } from '../commands/registry.ts';
import { exporters } from '../exporters/registry.ts';
import { importers } from '../importers/registry.ts';
import type { Unsubscribe } from '../core/events.ts';
import type { StorageAdapter } from '../storage/adapter.ts';
import type {
  ArtixPlugin,
  ArtixPluginApi,
  PanelContribution,
  PluginManifest,
  PluginStorage,
  VisualizationContribution,
} from './api.ts';

interface Registration {
  plugin: ArtixPlugin;
  builtin: boolean;
  active: boolean;
  disposers: Unsubscribe[];
  error?: string;
}

export class PluginHost {
  readonly #plugins = new Map<string, Registration>();
  readonly #panels = new Map<string, PanelContribution>();
  readonly #visualizations = new Map<string, VisualizationContribution>();
  readonly #listeners = new Set<() => void>();

  readonly #storage: StorageAdapter;
  readonly #version: string;

  constructor(storage: StorageAdapter, version: string) {
    this.#storage = storage;
    this.#version = version;
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Make a plugin known without activating it. */
  add(plugin: ArtixPlugin, builtin = false): void {
    if (this.#plugins.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already registered.`);
    }
    this.#plugins.set(plugin.id, { plugin, builtin, active: false, disposers: [] });
    this.#emit();
  }

  async activate(id: string): Promise<boolean> {
    const registration = this.#plugins.get(id);
    if (!registration || registration.active) return false;

    if (!this.#satisfiesRequirement(registration.plugin)) {
      registration.error = `Requires Artix ${registration.plugin.requires}, running ${this.#version}.`;
      this.#emit();
      return false;
    }

    const api = this.#makeApi(registration);

    try {
      await registration.plugin.activate(api);
      registration.active = true;
      delete registration.error;
      this.#emit();
      return true;
    } catch (e) {
      // Roll back anything the plugin managed to contribute before failing.
      this.#disposeAll(registration);
      registration.active = false;
      registration.error = e instanceof Error ? e.message : String(e);
      notify('error', `Plugin "${registration.plugin.name}" failed to start.`, registration.error);
      this.#emit();
      return false;
    }
  }

  async deactivate(id: string): Promise<boolean> {
    const registration = this.#plugins.get(id);
    if (!registration || !registration.active) return false;

    try {
      await registration.plugin.deactivate?.();
    } catch (e) {
      // Even a badly-behaved deactivate must not leak contributions.
      console.error(`[artix] plugin ${id} threw during deactivate`, e);
    }

    this.#disposeAll(registration);
    registration.active = false;
    this.#emit();
    return true;
  }

  /** Activate exactly the plugins in `enabledIds`, deactivating the rest. */
  async sync(enabledIds: readonly string[]): Promise<void> {
    const wanted = new Set(enabledIds);
    for (const [id, registration] of this.#plugins) {
      if (wanted.has(id) && !registration.active) await this.activate(id);
      else if (!wanted.has(id) && registration.active) await this.deactivate(id);
    }
  }

  async deactivateAll(): Promise<void> {
    for (const id of [...this.#plugins.keys()]) await this.deactivate(id);
  }

  /* -------------------------------------------------------------- queries */

  manifests(): PluginManifest[] {
    return [...this.#plugins.values()]
      .map((registration) => {
        const manifest: PluginManifest = {
          id: registration.plugin.id,
          name: registration.plugin.name,
          description: registration.plugin.description,
          version: registration.plugin.version,
          enabled: registration.active,
          builtin: registration.builtin,
        };
        if (registration.error) manifest.error = registration.error;
        return manifest;
      })
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }

  panels(slot: PanelContribution['slot']): PanelContribution[] {
    return [...this.#panels.values()]
      .filter((panel) => panel.slot === slot)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  visualizations(): VisualizationContribution[] {
    return [...this.#visualizations.values()];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /* ------------------------------------------------------------ internals */

  #makeApi(registration: Registration): ArtixPluginApi {
    const { plugin } = registration;
    const track = (dispose: Unsubscribe): Unsubscribe => {
      registration.disposers.push(dispose);
      return () => {
        dispose();
        const index = registration.disposers.indexOf(dispose);
        if (index >= 0) registration.disposers.splice(index, 1);
      };
    };

    const prefix = `plugin:${plugin.id}:`;
    const storage: PluginStorage = {
      listSessions: () => this.#storage.listSessions(),
      getSession: (id) => this.#storage.getSession(id),
      get: async (key) => {
        const result = await this.#storage.kvGet(prefix + key);
        return result.ok ? result.value : null;
      },
      set: async (key, value) => {
        await this.#storage.kvSet(prefix + key, value);
      },
    };

    return {
      version: this.#version,
      pluginId: plugin.id,

      contributeImporter: (importer) => track(importers.register(importer)),
      contributeExporter: (exporter) => track(exporters.register(exporter)),
      contributeCommand: (command) => track(commands.register(command)),

      contributePanel: (panel) => {
        // Namespace ids so two plugins cannot collide.
        const scoped = { ...panel, id: `${plugin.id}/${panel.id}` };
        this.#panels.set(scoped.id, scoped);
        this.#emit();
        return track(() => {
          this.#panels.delete(scoped.id);
          this.#emit();
        });
      },

      contributeVisualization: (visualization) => {
        const scoped = { ...visualization, id: `${plugin.id}/${visualization.id}` };
        this.#visualizations.set(scoped.id, scoped);
        this.#emit();
        return track(() => {
          this.#visualizations.delete(scoped.id);
          this.#emit();
        });
      },

      on: (event, listener) => track(bus.on(event, listener)),

      storage,

      notify: (level, message, detail) => notify(level, message, detail),

      log: {
        info: (message, ...args) => console.info(`[${plugin.id}] ${message}`, ...args),
        warn: (message, ...args) => console.warn(`[${plugin.id}] ${message}`, ...args),
        error: (message, ...args) => console.error(`[${plugin.id}] ${message}`, ...args),
      },
    };
  }

  #disposeAll(registration: Registration): void {
    // Copy first: a disposer may remove itself from the list.
    for (const dispose of [...registration.disposers]) {
      try {
        dispose();
      } catch (e) {
        console.error(`[artix] disposer for ${registration.plugin.id} threw`, e);
      }
    }
    registration.disposers.length = 0;
  }

  /** Minimal semver check — only `>=x.y.z` is supported, which is all we need. */
  #satisfiesRequirement(plugin: ArtixPlugin): boolean {
    if (!plugin.requires) return true;
    const match = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(plugin.requires.trim());
    if (!match) return true;

    const required = [Number(match[1]), Number(match[2]), Number(match[3])];
    const current = this.#version.split('.').map((n) => Number.parseInt(n, 10) || 0);

    for (let i = 0; i < 3; i++) {
      const c = current[i] ?? 0;
      const r = required[i] ?? 0;
      if (c > r) return true;
      if (c < r) return false;
    }
    return true;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
