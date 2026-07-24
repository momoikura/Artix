/**
 * Settings.
 *
 * Stored as a single JSON blob in the `kv` table (or localStorage in the
 * browser build). One document keeps reads to a single lookup and makes the
 * whole configuration trivially exportable and diffable.
 *
 * Every field has a default, and unknown fields from a newer version are
 * preserved on write — downgrading Artix never destroys settings.
 */

import type { Result } from '../core/result.ts';
import { ok } from '../core/result.ts';
import type { StorageAdapter } from './adapter.ts';

export const SETTINGS_KEY = 'settings';

export interface GalaxySettings {
  /** Master quality preset. `auto` samples frame time and steps down. */
  quality: 'auto' | 'low' | 'medium' | 'high' | 'ultra';
  bloom: boolean;
  depthOfField: boolean;
  nebula: boolean;
  dust: boolean;
  /** Slow orbital drift. Off gives a completely static scene. */
  motion: boolean;
  /** 0..2 multiplier on orbital speed. */
  motionSpeed: number;
  /** Show titles next to nearby nodes. */
  labels: boolean;
  /** Max simultaneously rendered labels — the main DOM cost in the galaxy. */
  labelBudget: number;
  /** Respect the OS "reduce motion" preference. */
  respectReducedMotion: boolean;
}

export interface ImportSettings {
  /**
   * Keep the library in step with Claude Code automatically: an incremental
   * scan shortly after launch, then on an interval while Artix is open.
   *
   * Only reads `~/.claude/projects`, only imports transcripts whose
   * modification time changed, and never sends anything anywhere. Turn it off
   * to make importing entirely manual.
   */
  autoSync: boolean;
  /** Minutes between background syncs. */
  autoSyncMinutes: number;
  /**
   * Also sync GitHub Copilot Chat from VS Code's local storage. Like Claude
   * Code it needs no export step, so it is on by default when present.
   */
  syncCopilot: boolean;
  /**
   * Extra directories the user has pointed Artix at. Scanned only when a scan
   * is explicitly triggered.
   */
  watchedFolders: string[];
  /** Re-scan watched folders on launch. */
  scanOnLaunch: boolean;
  /** Extensions considered importable when scanning a folder. */
  extensions: string[];
  /** Skip files whose content hash is already in the library. */
  skipDuplicates: boolean;
}

export interface AppSettings {
  version: 1;
  theme: 'deep-space' | 'void' | 'observatory';
  galaxy: GalaxySettings;
  import: ImportSettings;
  /** Enabled plugin ids. */
  plugins: string[];
  /** Per-plugin configuration blobs, keyed by plugin id. */
  pluginConfig: Record<string, unknown>;
  /** Saved search queries, shown in the palette. */
  savedViews: { name: string; query: string }[];
  /** Set once the user has seen the intro. */
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  theme: 'deep-space',
  galaxy: {
    quality: 'auto',
    bloom: true,
    depthOfField: true,
    nebula: true,
    dust: true,
    motion: true,
    motionSpeed: 1,
    labels: true,
    labelBudget: 40,
    respectReducedMotion: true,
  },
  import: {
    autoSync: true,
    autoSyncMinutes: 10,
    syncCopilot: true,
    watchedFolders: [],
    scanOnLaunch: false,
    extensions: ['jsonl', 'json', 'md', 'markdown', 'txt'],
    skipDuplicates: true,
  },
  plugins: [],
  pluginConfig: {},
  savedViews: [],
  onboarded: false,
};

/** Deep-merge stored settings over the defaults, preserving unknown keys. */
export function mergeSettings(stored: unknown): AppSettings {
  if (typeof stored !== 'object' || stored === null) return structuredClone(DEFAULT_SETTINGS);
  const raw = stored as Partial<AppSettings>;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    version: 1,
    galaxy: { ...DEFAULT_SETTINGS.galaxy, ...(raw.galaxy ?? {}) },
    import: { ...DEFAULT_SETTINGS.import, ...(raw.import ?? {}) },
    pluginConfig: { ...DEFAULT_SETTINGS.pluginConfig, ...(raw.pluginConfig ?? {}) },
    plugins: [...(raw.plugins ?? DEFAULT_SETTINGS.plugins)],
    savedViews: [...(raw.savedViews ?? DEFAULT_SETTINGS.savedViews)],
  };
}

export async function loadSettings(storage: StorageAdapter): Promise<AppSettings> {
  const result = await storage.kvGet(SETTINGS_KEY);
  if (!result.ok || result.value === null) return structuredClone(DEFAULT_SETTINGS);
  try {
    return mergeSettings(JSON.parse(result.value));
  } catch {
    // Corrupt settings should never block startup.
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(
  storage: StorageAdapter,
  settings: AppSettings,
): Promise<Result<void>> {
  const written = await storage.kvSet(SETTINGS_KEY, JSON.stringify(settings, null, 2));
  return written.ok ? ok(undefined) : written;
}

/**
 * Effective quality after resolving `auto` and the OS reduced-motion setting.
 * The renderer calls this rather than reading `settings.galaxy.quality` raw.
 */
export function resolveQuality(
  settings: GalaxySettings,
  hints: { deviceMemoryGb?: number; reducedMotion?: boolean; nodeCount: number },
): { tier: 'low' | 'medium' | 'high' | 'ultra'; motion: boolean } {
  const reduced = hints.reducedMotion === true && settings.respectReducedMotion;
  const motion = settings.motion && !reduced;

  if (settings.quality !== 'auto') return { tier: settings.quality, motion };

  const memory = hints.deviceMemoryGb ?? 8;
  if (memory <= 4 || hints.nodeCount > 200_000) return { tier: 'low', motion };
  if (memory <= 8 || hints.nodeCount > 60_000) return { tier: 'medium', motion };
  if (hints.nodeCount > 20_000) return { tier: 'high', motion };
  return { tier: 'ultra', motion };
}
