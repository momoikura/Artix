/**
 * Storage entry point.
 *
 * `createStorage()` picks the right adapter for the environment. Nothing else
 * in the app is allowed to check whether it is running under Tauri.
 */

import { MemoryStorageAdapter } from './memory-adapter.ts';
import { TauriStorageAdapter, isTauri } from './tauri-adapter.ts';
import { generateDemoLibrary } from './demo-library.ts';
import type { StorageAdapter } from './adapter.ts';

export * from './adapter.ts';
export * from './settings.ts';
export { MemoryStorageAdapter } from './memory-adapter.ts';
export { TauriStorageAdapter, isTauri, requireTauri } from './tauri-adapter.ts';
export { generateDemoLibrary } from './demo-library.ts';
export type { DemoOptions } from './demo-library.ts';

export interface CreateStorageOptions {
  /** Force an adapter. Used by tests and by `?storage=memory` in dev. */
  force?: 'tauri' | 'memory';
  /** Seed the in-memory adapter with a demo library when it is empty. */
  demoSessions?: number;
}

export function createStorage(options: CreateStorageOptions = {}): StorageAdapter {
  const useTauri = options.force ? options.force === 'tauri' : isTauri();
  if (useTauri) return new TauriStorageAdapter();

  const demoCount = options.demoSessions ?? 0;
  return new MemoryStorageAdapter({
    persist: true,
    seed: demoCount > 0 ? generateDemoLibrary({ count: demoCount }) : [],
  });
}
