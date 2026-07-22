/**
 * Command registry.
 *
 * Every user-triggerable action in Artix is a command. The palette, keyboard
 * shortcuts, context menus and plugins all go through this one list, so an
 * action added anywhere is automatically available everywhere.
 */

import { hash32 } from '../core/hash.ts';

export interface CommandContext {
  /** Currently selected sessions, if any. */
  selectedIds: readonly string[];
  /** True when a session workspace is open. */
  inSession: boolean;
  /** True when the search palette has focus. */
  inSearch: boolean;
}

export interface Command {
  id: string;
  title: string;
  /** Grouping label in the palette. */
  category: string;
  /** Extra words that should match this command in search. */
  keywords?: string[];
  /** Default binding, e.g. `Mod+K`, `Shift+/`. `Mod` is Cmd on macOS. */
  shortcut?: string;
  /** Hidden from the palette when this returns false. */
  when?: (context: CommandContext) => boolean;
  run: (context: CommandContext) => void | Promise<void>;
  /** Icon hint for the UI; purely presentational. */
  icon?: string;
  /** Lower sorts first within a category. */
  order?: number;
}

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #listeners = new Set<() => void>();

  register(command: Command): () => void {
    this.#commands.set(command.id, command);
    this.#emit();
    return () => {
      this.#commands.delete(command.id);
      this.#emit();
    };
  }

  registerAll(commands: readonly Command[]): () => void {
    const disposers = commands.map((command) => this.register(command));
    return () => disposers.forEach((dispose) => dispose());
  }

  get(id: string): Command | undefined {
    return this.#commands.get(id);
  }

  list(context?: CommandContext): Command[] {
    const all = [...this.#commands.values()];
    const visible = context ? all.filter((c) => c.when?.(context) ?? true) : all;

    return visible.sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        (a.order ?? 100) - (b.order ?? 100) ||
        a.title.localeCompare(b.title),
    );
  }

  async run(id: string, context: CommandContext): Promise<boolean> {
    const command = this.#commands.get(id);
    if (!command) return false;
    if (command.when && !command.when(context)) return false;
    await command.run(context);
    return true;
  }

  /** Subscribe to registry changes — the palette re-renders on these. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const commands = new CommandRegistry();

/* ------------------------------------------------------------- shortcuts */

/** Canonical form of a keyboard event, comparable with a `shortcut` string. */
export function eventToChord(event: KeyboardEvent): string {
  const parts: string[] = [];
  // `Mod` collapses Cmd/Ctrl so bindings are written once for every platform.
  if (event.metaKey || event.ctrlKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const key = event.key;
  // Normalise so `Mod+k` and `Mod+K` are the same binding.
  const normalised =
    key.length === 1 ? key.toUpperCase() : key === ' ' ? 'Space' : capitalise(key);
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) parts.push(normalised);

  return parts.join('+');
}

export function normalizeShortcut(shortcut: string): string {
  return shortcut
    .split('+')
    .map((part) => {
      const trimmed = part.trim();
      const lower = trimmed.toLowerCase();
      if (lower === 'cmd' || lower === 'ctrl' || lower === 'mod' || lower === 'control') return 'Mod';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'shift') return 'Shift';
      return trimmed.length === 1 ? trimmed.toUpperCase() : capitalise(trimmed);
    })
    .join('+');
}

/** Human-readable form for the current platform. */
export function displayShortcut(shortcut: string): string {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  return normalizeShortcut(shortcut)
    .split('+')
    .map((part) => {
      if (part === 'Mod') return isMac ? '⌘' : 'Ctrl';
      if (part === 'Alt') return isMac ? '⌥' : 'Alt';
      if (part === 'Shift') return isMac ? '⇧' : 'Shift';
      if (part === 'Escape') return 'Esc';
      if (part === 'Arrowup') return '↑';
      if (part === 'Arrowdown') return '↓';
      return part;
    })
    .join(isMac ? '' : '+');
}

/**
 * Bind the registry to a DOM target.
 *
 * Typing in an input must not fire shortcuts, with one exception: the palette
 * hotkey itself has to work from anywhere, or it is not a global hotkey.
 */
export function attachShortcuts(
  registry: CommandRegistry,
  getContext: () => CommandContext,
  target: HTMLElement | Document = document,
): () => void {
  const handler = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    const chord = eventToChord(keyboardEvent);

    const active = document.activeElement;
    const isTyping =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);

    for (const command of registry.list()) {
      if (!command.shortcut) continue;
      if (normalizeShortcut(command.shortcut) !== chord) continue;

      // Escape and Mod-chords stay live while typing; bare keys do not.
      const isModified = chord.includes('Mod') || chord.includes('Alt');
      if (isTyping && !isModified && chord !== 'Escape') continue;

      const context = getContext();
      if (command.when && !command.when(context)) continue;

      keyboardEvent.preventDefault();
      void registry.run(command.id, context);
      return;
    }
  };

  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Fuzzy-rank commands for the palette. Deliberately simple — the command list
 * is small enough that the full search engine would be overkill.
 */
export function filterCommands(list: readonly Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...list];

  const scored: { command: Command; score: number }[] = [];

  for (const command of list) {
    const haystacks = [
      command.title.toLowerCase(),
      command.category.toLowerCase(),
      ...(command.keywords ?? []).map((k) => k.toLowerCase()),
    ];

    let best = -1;
    for (const [index, haystack] of haystacks.entries()) {
      const at = haystack.indexOf(needle);
      if (at < 0) continue;
      // Prefer title matches, and prefer matches near the start.
      const score = 100 - index * 20 - at - (haystack.length - needle.length) * 0.1;
      if (score > best) best = score;
    }

    if (best >= 0) scored.push({ command, score: best });
  }

  return scored
    .sort((a, b) => b.score - a.score || hash32(a.command.id) - hash32(b.command.id))
    .map((s) => s.command);
}
