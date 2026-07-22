/**
 * Markdown exporter.
 *
 * Round-trips through `core:markdown` — the front matter it writes is exactly
 * what the importer reads, so exporting and re-importing a session is lossless
 * for everything except ids.
 */

import { formatDuration, isoDateTime } from '../core/time.ts';
import { resolveLanguage } from '../core/languages.ts';
import { clip, safeFileName } from './types.ts';
import type { Exporter, ExportOptions } from './types.ts';
import type { Artifact, SessionDetail } from '../core/types.ts';

export const markdownExporter: Exporter = {
  id: 'core:markdown',
  label: 'Markdown',
  description: 'Readable Markdown with front matter. Re-imports losslessly.',
  extension: 'md',
  multiFile: true,

  render(sessions, options) {
    return sessions.map((detail) => ({
      path: `${safeFileName(detail.session.title, detail.session.id)}.md`,
      content: renderSessionMarkdown(detail, options),
    }));
  },
};

export function renderSessionMarkdown(detail: SessionDetail, options: ExportOptions): string {
  const { session, messages, artifacts, files } = detail;
  const out: string[] = [];

  /* -- front matter -------------------------------------------------------- */
  out.push('---');
  out.push(`title: ${quote(session.title)}`);
  out.push(`project: ${quote(session.project)}`);
  if (session.folder) out.push(`folder: ${quote(session.folder)}`);
  out.push(`date: ${new Date(session.startedAt).toISOString()}`);
  if (session.endedAt) out.push(`ended: ${new Date(session.endedAt).toISOString()}`);
  out.push(`status: ${session.status}`);
  if (session.language) out.push(`language: ${session.language}`);
  if (session.tags.length > 0) out.push(`tags: [${session.tags.join(', ')}]`);
  if (session.technologies.length > 0) {
    out.push(`technologies: [${session.technologies.join(', ')}]`);
  }
  if (session.summary) out.push(`summary: ${quote(session.summary)}`);
  out.push('---');
  out.push('');

  /* -- header -------------------------------------------------------------- */
  out.push(`# ${session.title}`);
  out.push('');
  out.push(
    [
      `**Project:** ${session.project}`,
      `**Date:** ${isoDateTime(session.startedAt)}`,
      `**Duration:** ${formatDuration(session.endedAt ? session.endedAt - session.startedAt : null)}`,
      `**Language:** ${session.language ? resolveLanguage(session.language).label : '—'}`,
    ].join('  \n'),
  );
  out.push('');

  if (session.summary) {
    out.push('## Summary');
    out.push('');
    out.push(session.summary);
    out.push('');
  }

  if (options.includeNotes && session.notes.trim()) {
    out.push('## Notes');
    out.push('');
    out.push(session.notes);
    out.push('');
  }

  /* -- structured sections ------------------------------------------------- */
  const decisions = artifacts.filter((a) => a.kind === 'decision');
  if (decisions.length > 0) {
    out.push('## Decisions');
    out.push('');
    for (const decision of decisions) out.push(`- ${decision.content}`);
    out.push('');
  }

  const architecture = artifacts.filter((a) => a.kind === 'architecture');
  if (architecture.length > 0) {
    out.push('## Architecture');
    out.push('');
    for (const item of architecture) {
      out.push(`### ${item.title}`);
      out.push('');
      out.push('```');
      out.push(item.content);
      out.push('```');
      out.push('');
    }
  }

  const todos = artifacts.filter((a) => a.kind === 'todo');
  if (todos.length > 0) {
    out.push('## Todos');
    out.push('');
    for (const todo of todos) out.push(`- [${todo.done ? 'x' : ' '}] ${todo.title}`);
    out.push('');
  }

  if (options.includeFiles && files.length > 0) {
    out.push('## Files');
    out.push('');
    for (const file of files) out.push(`- \`${file.path}\` — ${file.action}`);
    out.push('');
  }

  if (options.includeCode) {
    const code = artifacts.filter((a) => a.kind === 'code');
    if (code.length > 0) {
      out.push('## Code');
      out.push('');
      for (const snippet of code) out.push(renderCodeArtifact(snippet));
      out.push('');
    }
  }

  const commands = artifacts.filter((a) => a.kind === 'command');
  if (commands.length > 0) {
    out.push('## Commands');
    out.push('');
    out.push('```sh');
    for (const command of commands) out.push(command.content);
    out.push('```');
    out.push('');
  }

  /* -- conversation -------------------------------------------------------- */
  if (options.includeConversation && messages.length > 0) {
    out.push('## Conversation');
    out.push('');
    for (const message of messages) {
      out.push(`### ${titleCase(message.role)}`);
      out.push('');
      out.push(message.content);
      out.push('');
    }
  }

  return clip(out.join('\n'), options.maxChars);
}

function renderCodeArtifact(artifact: Artifact): string {
  const heading = artifact.path ? `**\`${artifact.path}\`**` : `**${artifact.title}**`;
  // Use a fence long enough to survive nested fences in the content.
  const longest = /(`{3,})/g;
  let maxFence = 3;
  for (const match of artifact.content.matchAll(longest)) {
    maxFence = Math.max(maxFence, match[1]!.length + 1);
  }
  const fence = '`'.repeat(maxFence);

  return `${heading}\n\n${fence}${artifact.language ?? ''}\n${artifact.content}\n${fence}\n`;
}

function quote(value: string): string {
  const cleaned = value.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  return `"${cleaned}"`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
