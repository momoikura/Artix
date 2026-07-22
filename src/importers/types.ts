/**
 * Importer contract.
 *
 * Artix deliberately knows nothing about any tool's internals. An importer is
 * given raw text (or a set of files) and returns `SessionDraft`s. That is the
 * whole interface — which is why a plugin can add support for a new tool
 * without touching the core, and why a future change to Claude Code's on-disk
 * format only ever breaks one file.
 */

import type { SessionDraft } from '../core/types.ts';

export interface ImportSource {
  /** Absolute path, URL, or a synthetic reference for pasted content. */
  reference: string;
  /** Display name — usually the file name. */
  name: string;
  /** Raw file contents. */
  content: string;
  /** File modification time, used as a fallback session timestamp. */
  modifiedAt?: number;
}

export interface ImportResult {
  drafts: SessionDraft[];
  /** Non-fatal problems worth surfacing (e.g. "12 of 400 lines unparseable"). */
  warnings: string[];
}

export interface Importer {
  /** Stable id, `namespace:name`. Recorded on every session it produces. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** File extensions this importer handles, without the dot. */
  readonly extensions: readonly string[];

  /**
   * Confidence that this importer can parse `source`, 0..1.
   *
   * The registry picks the highest scorer, so importers must be honest: return
   * 0 rather than a hopeful 0.3 when the content is clearly something else.
   */
  detect(source: ImportSource): number;

  parse(source: ImportSource): ImportResult;
}

/** Convenience for importers that produce exactly one session. */
export function single(draft: SessionDraft, warnings: string[] = []): ImportResult {
  return { drafts: [draft], warnings };
}

export const EMPTY_RESULT: ImportResult = { drafts: [], warnings: [] };

/**
 * Derive a project name from a working directory.
 *
 * The last path segment is right far more often than not, and it is what the
 * user would call the project themselves.
 */
export function projectFromFolder(folder: string | null | undefined, fallback = 'Unsorted'): string {
  if (!folder) return fallback;
  const parts = folder.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  const last = parts[parts.length - 1];
  return last && last.length > 0 && last !== '~' ? last : fallback;
}

/** Strip a file extension for use as a title. */
export function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}
