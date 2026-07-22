/**
 * JSON and plain-text exporters.
 *
 * The JSON exporter writes the versioned `artix-export` envelope that
 * `core:json` reads back, making it the canonical backup format: everything the
 * database holds, in a form no other tool is required to understand.
 */

import { isoDateTime } from '../core/time.ts';
import { clip, safeFileName } from './types.ts';
import type { Exporter, ExportOptions } from './types.ts';
import type { SessionDetail, SessionDraft } from '../core/types.ts';

export const jsonExporter: Exporter = {
  id: 'core:json',
  label: 'JSON',
  description: 'Complete, lossless archive. The format to use for backups.',
  extension: 'json',
  multiFile: false,

  render(sessions, options) {
    const payload = {
      format: 'artix-export' as const,
      version: 1 as const,
      exportedAt: Date.now(),
      sessions: sessions.map((detail) => toDraft(detail, options)),
    };

    return [
      {
        path: sessions.length === 1 && sessions[0]
          ? `${safeFileName(sessions[0].session.title, sessions[0].session.id)}.json`
          : 'artix-export.json',
        content: JSON.stringify(payload, null, 2),
      },
    ];
  },
};

/** Convert a stored aggregate back into the importable draft shape. */
function toDraft(detail: SessionDetail, options: ExportOptions): SessionDraft {
  const { session, messages, artifacts, files } = detail;

  return {
    title: session.title,
    project: session.project,
    folder: session.folder,
    summary: session.summary,
    notes: options.includeNotes ? session.notes : '',
    language: session.language,
    status: session.status,
    kind: session.kind,
    complexity: session.complexity,
    importance: session.importance,
    pinned: session.pinned,
    source: session.source,
    sourceRef: session.sourceRef,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    tags: session.tags,
    technologies: session.technologies,
    messages: options.includeConversation
      ? messages.map(({ id: _id, sessionId: _sessionId, ...rest }) => rest)
      : [],
    artifacts: (options.includeCode ? artifacts : artifacts.filter((a) => a.kind !== 'code')).map(
      ({ id: _id, sessionId: _sessionId, ...rest }) => rest,
    ),
    files: options.includeFiles
      ? files.map(({ id: _id, sessionId: _sessionId, ...rest }) => rest)
      : [],
  };
}

export const textExporter: Exporter = {
  id: 'core:text',
  label: 'Plain text',
  description: 'Unformatted transcript. Maximum portability, no structure.',
  extension: 'txt',
  multiFile: true,

  render(sessions, options) {
    return sessions.map((detail) => ({
      path: `${safeFileName(detail.session.title, detail.session.id)}.txt`,
      content: renderSessionText(detail, options),
    }));
  },
};

export function renderSessionText(detail: SessionDetail, options: ExportOptions): string {
  const { session, messages, artifacts, files } = detail;
  const out: string[] = [];

  out.push(session.title);
  out.push('='.repeat(Math.min(session.title.length, 72)));
  out.push('');
  out.push(`Project:  ${session.project}`);
  if (session.folder) out.push(`Folder:   ${session.folder}`);
  out.push(`Date:     ${isoDateTime(session.startedAt)}`);
  out.push(`Status:   ${session.status}`);
  if (session.language) out.push(`Language: ${session.language}`);
  if (session.tags.length > 0) out.push(`Tags:     ${session.tags.join(', ')}`);
  if (session.technologies.length > 0) out.push(`Stack:    ${session.technologies.join(', ')}`);
  out.push('');

  if (session.summary) {
    out.push('SUMMARY');
    out.push('-------');
    out.push(session.summary);
    out.push('');
  }

  if (options.includeNotes && session.notes.trim()) {
    out.push('NOTES');
    out.push('-----');
    out.push(session.notes);
    out.push('');
  }

  const decisions = artifacts.filter((a) => a.kind === 'decision');
  if (decisions.length > 0) {
    out.push('DECISIONS');
    out.push('---------');
    for (const decision of decisions) out.push(`* ${decision.content}`);
    out.push('');
  }

  const todos = artifacts.filter((a) => a.kind === 'todo');
  if (todos.length > 0) {
    out.push('TODOS');
    out.push('-----');
    for (const todo of todos) out.push(`[${todo.done ? 'x' : ' '}] ${todo.title}`);
    out.push('');
  }

  if (options.includeFiles && files.length > 0) {
    out.push('FILES');
    out.push('-----');
    for (const file of files) out.push(`${file.action.padEnd(11)} ${file.path}`);
    out.push('');
  }

  if (options.includeConversation && messages.length > 0) {
    out.push('CONVERSATION');
    out.push('------------');
    out.push('');
    for (const message of messages) {
      out.push(`${message.role.toUpperCase()}:`);
      out.push(message.content);
      out.push('');
    }
  }

  return clip(out.join('\n'), options.maxChars);
}
