/**
 * JSON importer.
 *
 * Two jobs:
 *  - round-trip Artix's own JSON export losslessly (including ids and notes);
 *  - accept generic conversation JSON from other tools on a best-effort basis.
 *
 * The Artix envelope is versioned so a future format change can migrate rather
 * than reject.
 */

import { deriveSummary, deriveTitle, estimateTokens, extractFromMessages } from '../core/extract.ts';
import { parseTimestamp } from '../core/time.ts';
import { MESSAGE_ROLES } from '../core/types.ts';
import { projectFromFolder, titleFromFilename } from './types.ts';
import type { Importer, ImportResult, ImportSource } from './types.ts';
import type { Message, MessageRole, SessionDraft } from '../core/types.ts';

const IMPORTER_ID = 'core:json';

/** Envelope written by the JSON exporter. */
export interface ArtixExport {
  format: 'artix-export';
  version: 1;
  exportedAt: number;
  sessions: SessionDraft[];
}

export const jsonImporter: Importer = {
  id: IMPORTER_ID,
  label: 'JSON export',
  description: 'Artix JSON exports, and generic conversation JSON from other tools.',
  extensions: ['json'],

  detect(source) {
    const trimmed = source.content.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 0;

    // Cheap probe on the head of the file rather than parsing megabytes twice.
    const head = trimmed.slice(0, 400);
    if (head.includes('"artix-export"')) return 1;
    if (/"(messages|conversation|chat|turns)"\s*:/.test(head)) return 0.75;
    if (/\.json$/i.test(source.name)) return 0.45;
    return 0.2;
  },

  parse(source) {
    return parseJson(source);
  },
};

export function parseJson(source: ImportSource): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch (e) {
    return {
      drafts: [],
      warnings: [`${source.name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // 1. Artix's own envelope.
  if (isArtixExport(parsed)) {
    return {
      drafts: parsed.sessions.map((draft) => ({
        ...draft,
        source: draft.source || IMPORTER_ID,
        sourceRef: draft.sourceRef ?? source.reference,
      })),
      warnings: [],
    };
  }

  // 2. A bare array — either of sessions or of messages.
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && looksLikeMessage(parsed[0])) {
      return fromMessages(parsed, source);
    }
    const drafts: SessionDraft[] = [];
    const warnings: string[] = [];
    for (const [index, item] of parsed.entries()) {
      const result = fromObject(item, source);
      if (result) drafts.push(result);
      else warnings.push(`Entry ${index} was not recognised as a session.`);
    }
    return { drafts, warnings };
  }

  // 3. A single object.
  const draft = fromObject(parsed, source);
  return draft
    ? { drafts: [draft], warnings: [] }
    : { drafts: [], warnings: [`${source.name} did not contain a recognisable conversation.`] };
}

/* ------------------------------------------------------------------ shapes */

function isArtixExport(value: unknown): value is ArtixExport {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ArtixExport).format === 'artix-export' &&
    Array.isArray((value as ArtixExport).sessions)
  );
}

function looksLikeMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.role === 'string' &&
    (typeof record.content === 'string' || Array.isArray(record.content))
  );
}

function fromObject(value: unknown, source: ImportSource): SessionDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const rawMessages =
    (record.messages as unknown) ??
    (record.conversation as unknown) ??
    (record.chat as unknown) ??
    (record.turns as unknown);

  if (!Array.isArray(rawMessages)) return null;

  const messages = normaliseMessages(rawMessages);
  if (messages.length === 0) return null;

  const folder = readString(record, 'folder', 'cwd', 'path', 'workingDirectory');
  const extraction = extractFromMessages(messages);

  return {
    title:
      readString(record, 'title', 'name', 'subject') ??
      deriveTitle(messages) ??
      titleFromFilename(source.name),
    project:
      readString(record, 'project') ??
      projectFromFolder(folder, titleFromFilename(source.name) || 'Unsorted'),
    folder,
    summary: readString(record, 'summary', 'description') ?? deriveSummary(messages),
    language: readString(record, 'language') ?? extraction.language,
    source: IMPORTER_ID,
    sourceRef: source.reference,
    startedAt:
      parseTimestamp(record.startedAt ?? record.createdAt ?? record.date ?? record.timestamp) ??
      source.modifiedAt ??
      Date.now(),
    endedAt: parseTimestamp(record.endedAt ?? record.updatedAt) ?? null,
    tags: readStringArray(record.tags),
    technologies:
      readStringArray(record.technologies).length > 0
        ? readStringArray(record.technologies)
        : extraction.technologies,
    messages,
    artifacts: extraction.artifacts,
    files: extraction.files,
  };
}

function fromMessages(items: unknown[], source: ImportSource): ImportResult {
  const messages = normaliseMessages(items);
  if (messages.length === 0) {
    return { drafts: [], warnings: [`No usable messages in ${source.name}.`] };
  }

  const extraction = extractFromMessages(messages);
  return {
    drafts: [
      {
        title: deriveTitle(messages) || titleFromFilename(source.name),
        project: titleFromFilename(source.name) || 'Unsorted',
        folder: null,
        summary: deriveSummary(messages),
        language: extraction.language,
        source: IMPORTER_ID,
        sourceRef: source.reference,
        startedAt: source.modifiedAt ?? Date.now(),
        technologies: extraction.technologies,
        messages,
        artifacts: extraction.artifacts,
        files: extraction.files,
      },
    ],
    warnings: [],
  };
}

function normaliseMessages(items: readonly unknown[]): Omit<Message, 'id' | 'sessionId'>[] {
  const out: Omit<Message, 'id' | 'sessionId'>[] = [];

  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;

    const role = normaliseRole(record.role ?? record.type ?? record.sender);
    if (role === null) continue;

    const content = flattenContent(record.content ?? record.text ?? record.message);
    if (content.trim().length === 0) continue;

    out.push({
      seq: out.length,
      role,
      content,
      createdAt: parseTimestamp(record.createdAt ?? record.timestamp ?? record.time),
      tokenEstimate: estimateTokens(content),
      toolName: readString(record, 'toolName', 'tool', 'name'),
    });
  }

  return out;
}

function normaliseRole(value: unknown): MessageRole | null {
  if (typeof value !== 'string') return null;
  const normalised = value.toLowerCase();
  if (MESSAGE_ROLES.includes(normalised as MessageRole)) return normalised as MessageRole;
  if (normalised === 'human') return 'user';
  if (normalised === 'ai' || normalised === 'model' || normalised === 'bot') return 'assistant';
  return null;
}

function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenContent).filter(Boolean).join('\n\n');
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if ('content' in record) return flattenContent(record.content);
  }
  return '';
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}
