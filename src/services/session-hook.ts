/**
 * Claude Code SessionEnd hook management.
 *
 * Installs a hook into `~/.claude/settings.json` that runs `artix --sync` when
 * a Claude Code session ends, so a finished session appears in Artix within a
 * second or two instead of at the next timer tick.
 *
 * This edits the user's *global* Claude Code config, which affects every
 * project, so the caller must confirm before installing. The mutation is
 * surgical: only Artix's own hook entry is added or removed, and every other
 * key in the file is preserved byte-for-byte through parse/serialise.
 *
 * The pure `withArtixHook` / `withoutArtixHook` functions are exported and
 * tested directly — corrupting a user's settings.json would break all of
 * Claude Code, so the merge logic must not regress.
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauri } from '../storage/tauri-adapter.ts';
import { artixError, err, ok } from '../core/result.ts';
import type { Result } from '../core/result.ts';
import type { StorageAdapter } from '../storage/adapter.ts';

type Json = Record<string, unknown>;

interface CommandHook {
  type: 'command';
  command: string;
  args?: string[];
  async?: boolean;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  hooks: unknown[];
  matcher?: string;
}

/** True for the hook entry Artix installs — identified structurally. */
export function isArtixSyncHook(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const hook = entry as CommandHook;
  if (hook.type !== 'command' || typeof hook.command !== 'string') return false;

  const base = hook.command
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '');

  return base === 'artix' && Array.isArray(hook.args) && hook.args.includes('--sync');
}

/** Build Artix's hook entry pointing at a specific executable. */
export function artixHookEntry(exePath: string): CommandHook {
  return {
    type: 'command',
    command: exePath,
    // Exec form (args array) means no shell, so a path with spaces, quotes or
    // `$` is passed verbatim — no quoting to get wrong across platforms.
    args: ['--sync'],
    async: true,
    timeout: 15,
    statusMessage: 'Syncing to Artix',
  };
}

/** Whether the settings already contain Artix's hook. */
export function hasArtixHook(settings: Json): boolean {
  const groups = readSessionEnd(settings);
  return groups.some((group) => group.hooks.some(isArtixSyncHook));
}

/**
 * Return settings with exactly one Artix hook installed.
 *
 * Idempotent: any prior Artix entries are stripped first, so re-running never
 * accumulates duplicates or leaves a stale path behind after an app update.
 */
export function withArtixHook(settings: Json, exePath: string): Json {
  const cleaned = withoutArtixHook(settings);
  const next = structuredClone(cleaned);

  const hooks = (next.hooks ??= {}) as Json;
  const sessionEnd = (hooks.SessionEnd ??= []) as HookGroup[];
  sessionEnd.push({ hooks: [artixHookEntry(exePath)] });

  return next;
}

/**
 * Return settings with every Artix hook removed, and any now-empty containers
 * cleaned up so the file does not accrete empty objects over time.
 */
export function withoutArtixHook(settings: Json): Json {
  const next = structuredClone(settings);
  const hooks = next.hooks as Json | undefined;
  if (!hooks || typeof hooks !== 'object') return next;

  const groups = hooks.SessionEnd;
  if (Array.isArray(groups)) {
    const kept = (groups as HookGroup[])
      .map((group) => ({
        ...group,
        hooks: Array.isArray(group.hooks) ? group.hooks.filter((h) => !isArtixSyncHook(h)) : [],
      }))
      // Drop groups that Artix emptied, but keep groups that still hold the
      // user's own hooks.
      .filter((group) => group.hooks.length > 0);

    if (kept.length > 0) hooks.SessionEnd = kept;
    else delete hooks.SessionEnd;
  }

  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/* ------------------------------------------------------------------ IO */

async function settingsPath(): Promise<string> {
  const { homeDir, join } = await import('@tauri-apps/api/path');
  return join(await homeDir(), '.claude', 'settings.json');
}

async function readSettings(storage: StorageAdapter, path: string): Promise<Json> {
  const raw = await storage.readTextFile(path);
  if (!raw.ok) return {}; // absent file is the normal first-run case
  try {
    const parsed: unknown = JSON.parse(raw.value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : {};
  } catch {
    throw new Error('settings.json is not valid JSON');
  }
}

export interface HookStatus {
  installed: boolean;
  /** Present when Claude Code is not installed (no settings dir). */
  unavailable?: boolean;
}

/** Whether the hook is currently installed, read from the real file. */
export async function sessionHookStatus(storage: StorageAdapter): Promise<HookStatus> {
  if (!isTauri() || !storage.capabilities.filesystem) return { installed: false, unavailable: true };
  try {
    const settings = await readSettings(storage, await settingsPath());
    return { installed: hasArtixHook(settings) };
  } catch {
    return { installed: false };
  }
}

export async function installSessionHook(storage: StorageAdapter): Promise<Result<void>> {
  if (!isTauri()) {
    return err(artixError('unsupported', 'The instant-sync hook needs the Artix desktop app.'));
  }
  try {
    const exePath = await invoke<string>('current_exe_path');
    const path = await settingsPath();
    const settings = await readSettings(storage, path);
    const written = await storage.writeTextFile(
      path,
      `${JSON.stringify(withArtixHook(settings, exePath), null, 2)}\n`,
    );
    return written.ok ? ok(undefined) : written;
  } catch (e) {
    return err(artixError('io', e instanceof Error ? e.message : String(e)));
  }
}

export async function removeSessionHook(storage: StorageAdapter): Promise<Result<void>> {
  if (!isTauri()) return ok(undefined);
  try {
    const path = await settingsPath();
    const settings = await readSettings(storage, path);
    if (!hasArtixHook(settings)) return ok(undefined);
    const written = await storage.writeTextFile(
      path,
      `${JSON.stringify(withoutArtixHook(settings), null, 2)}\n`,
    );
    return written.ok ? ok(undefined) : written;
  } catch (e) {
    return err(artixError('io', e instanceof Error ? e.message : String(e)));
  }
}

function readSessionEnd(settings: Json): HookGroup[] {
  const hooks = settings.hooks as Json | undefined;
  const groups = hooks?.SessionEnd;
  if (!Array.isArray(groups)) return [];
  return groups.filter(
    (g): g is HookGroup => typeof g === 'object' && g !== null && Array.isArray((g as HookGroup).hooks),
  );
}
