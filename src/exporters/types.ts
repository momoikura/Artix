/**
 * Exporter contract.
 *
 * An exporter turns one or more `SessionDetail`s into named text artifacts.
 * Writing them to disk (or a ZIP) is the registry's job, so exporters stay pure
 * and trivially testable.
 */

import type { SessionDetail } from '../core/types.ts';

export interface ExportFile {
  /** Path relative to the export root. Forward slashes, never absolute. */
  path: string;
  content: string;
}

export interface ExportOptions {
  /** Include the full conversation. Off produces a metadata-only export. */
  includeConversation: boolean;
  /** Include extracted code artifacts. */
  includeCode: boolean;
  /** Include file references. */
  includeFiles: boolean;
  /** Include user notes. */
  includeNotes: boolean;
  /** Soft cap on characters per session; transcripts are truncated with a marker. */
  maxChars: number;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeConversation: true,
  includeCode: true,
  includeFiles: true,
  includeNotes: true,
  maxChars: 2_000_000,
};

export interface Exporter {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** File extension produced, without the dot. */
  readonly extension: string;
  /** True when the exporter emits several files (and therefore wants a ZIP). */
  readonly multiFile: boolean;

  render(sessions: readonly SessionDetail[], options: ExportOptions): ExportFile[];
}

/** Filesystem-safe name derived from a session, for per-session export files. */
export function safeFileName(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  // The id suffix guarantees uniqueness even when two sessions share a title.
  return `${base || 'session'}-${id.slice(-6).toLowerCase()}`;
}

/** Truncate with an explicit marker so nobody mistakes a cut for the whole thing. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n… truncated (${text.length - maxChars} more characters)`;
}
