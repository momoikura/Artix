/**
 * The merge logic edits the user's global Claude Code config. Corrupting it
 * would break all of Claude Code, so every guarantee is pinned here.
 */

import { describe, expect, it } from 'vitest';

import {
  artixHookEntry,
  hasArtixHook,
  isArtixSyncHook,
  withArtixHook,
  withoutArtixHook,
} from './session-hook.ts';

const EXE = 'C:\\Users\\me\\AppData\\Local\\Artix\\artix.exe';

describe('hook identification', () => {
  it('recognises Artix hooks across path styles and .exe', () => {
    expect(isArtixSyncHook(artixHookEntry('/Applications/Artix.app/Contents/MacOS/artix'))).toBe(true);
    expect(isArtixSyncHook(artixHookEntry(EXE))).toBe(true);
    expect(isArtixSyncHook(artixHookEntry('/usr/local/bin/artix'))).toBe(true);
  });

  it('does not match other tools’ hooks', () => {
    expect(isArtixSyncHook({ type: 'command', command: 'prettier', args: ['--write'] })).toBe(false);
    // Same flag, different tool.
    expect(isArtixSyncHook({ type: 'command', command: 'rsync', args: ['--sync'] })).toBe(false);
    // Right binary, but not our invocation.
    expect(isArtixSyncHook({ type: 'command', command: 'artix', args: ['--help'] })).toBe(false);
    expect(isArtixSyncHook('a string')).toBe(false);
    expect(isArtixSyncHook(null)).toBe(false);
  });
});

describe('installing the hook', () => {
  it('creates the whole structure from empty settings', () => {
    const result = withArtixHook({}, EXE);
    expect(hasArtixHook(result)).toBe(true);

    const hooks = result.hooks as Record<string, unknown>;
    const groups = hooks.SessionEnd as { hooks: unknown[] }[];
    expect(groups).toHaveLength(1);
    expect(isArtixSyncHook(groups[0]!.hooks[0])).toBe(true);
  });

  it('preserves every other setting', () => {
    const existing = {
      theme: 'dark',
      model: 'opus',
      enabledPlugins: { 'foo@bar': true },
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }],
      },
    };
    const result = withArtixHook(existing, EXE) as typeof existing & { hooks: Record<string, unknown> };

    expect(result.theme).toBe('dark');
    expect(result.model).toBe('opus');
    expect(result.enabledPlugins).toEqual({ 'foo@bar': true });
    // The user's unrelated hook survives untouched.
    expect(result.hooks.PostToolUse).toEqual(existing.hooks.PostToolUse);
    expect(hasArtixHook(result)).toBe(true);
  });

  it('keeps a pre-existing non-Artix SessionEnd hook alongside ours', () => {
    const existing = {
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'my-logger' }] }],
      },
    };
    const result = withArtixHook(existing, EXE);
    const groups = (result.hooks as Record<string, unknown>).SessionEnd as { hooks: unknown[] }[];

    // The logger is still there, and ours was added.
    const commands = groups.flatMap((g) => g.hooks).map((h) => (h as { command: string }).command);
    expect(commands).toContain('my-logger');
    expect(commands).toContain(EXE);
  });

  it('is idempotent — installing twice yields one hook, not two', () => {
    const once = withArtixHook({}, EXE);
    const twice = withArtixHook(once, EXE);

    const groups = (twice.hooks as Record<string, unknown>).SessionEnd as { hooks: unknown[] }[];
    const ours = groups.flatMap((g) => g.hooks).filter(isArtixSyncHook);
    expect(ours).toHaveLength(1);
  });

  it('refreshes a stale executable path on reinstall', () => {
    const old = withArtixHook({}, 'C:\\old\\artix.exe');
    const updated = withArtixHook(old, 'C:\\new\\artix.exe');

    const groups = (updated.hooks as Record<string, unknown>).SessionEnd as { hooks: unknown[] }[];
    const ours = groups.flatMap((g) => g.hooks).filter(isArtixSyncHook) as { command: string }[];
    expect(ours).toHaveLength(1);
    expect(ours[0]!.command).toBe('C:\\new\\artix.exe');
  });
});

describe('removing the hook', () => {
  it('removes ours and nothing else', () => {
    const withBoth = {
      theme: 'dark',
      hooks: {
        SessionEnd: [
          { hooks: [{ type: 'command', command: 'my-logger' }] },
          { hooks: [artixHookEntry(EXE)] },
        ],
      },
    };
    const result = withoutArtixHook(withBoth) as typeof withBoth;

    expect(hasArtixHook(result)).toBe(false);
    expect(result.theme).toBe('dark');
    const commands = result.hooks.SessionEnd.flatMap((g) => g.hooks).map(
      (h) => (h as { command: string }).command,
    );
    expect(commands).toEqual(['my-logger']);
  });

  it('cleans up empty containers so the file does not bloat', () => {
    const onlyOurs = { hooks: { SessionEnd: [{ hooks: [artixHookEntry(EXE)] }] } };
    const result = withoutArtixHook(onlyOurs);
    // No empty SessionEnd array, no empty hooks object left behind.
    expect(result).toEqual({});
  });

  it('leaves other hook events intact when clearing SessionEnd', () => {
    const mixed = {
      hooks: {
        SessionEnd: [{ hooks: [artixHookEntry(EXE)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'log' }] }],
      },
    };
    const result = withoutArtixHook(mixed) as { hooks: Record<string, unknown> };
    expect(result.hooks.SessionEnd).toBeUndefined();
    expect(result.hooks.PreToolUse).toBeDefined();
  });

  it('is a no-op when no Artix hook is present', () => {
    const other = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
    expect(withoutArtixHook(other)).toEqual(other);
  });

  it('round-trips: install then remove returns to the original', () => {
    const original = { theme: 'dark', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'p' }] }] } };
    const roundTripped = withoutArtixHook(withArtixHook(original, EXE));
    expect(roundTripped).toEqual(original);
  });
});
