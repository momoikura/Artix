/**
 * Plain-text importer — the deliberate fallback.
 *
 * Its `detect` score is low on purpose: it should only win when nothing else
 * recognises the file. But it must never fail, because "I pasted my notes and
 * Artix rejected them" is a far worse outcome than a roughly-parsed session.
 */

import { deriveSummary, deriveTitle, estimateTokens, extractFromMessages } from '../core/extract.ts';
import { titleFromFilename } from './types.ts';
import type { Importer, ImportResult, ImportSource } from './types.ts';
import type { Message } from '../core/types.ts';

const IMPORTER_ID = 'core:text';

/** `User:` / `Assistant:` at the start of a line, the near-universal convention. */
const INLINE_SPEAKER = /^(user|human|you|assistant|claude|ai|system)\s*:\s*(.*)$/i;

export const textImporter: Importer = {
  id: IMPORTER_ID,
  label: 'Plain text',
  description: 'Any text file. Splits on "User:" / "Assistant:" prefixes when present.',
  extensions: ['txt', 'log', 'text'],

  // Always plausible, never confident — every other importer outranks it.
  detect(source) {
    return source.content.trim().length > 0 ? 0.1 : 0;
  },

  parse(source) {
    return parseText(source);
  },
};

export function parseText(source: ImportSource): ImportResult {
  const messages: Omit<Message, 'id' | 'sessionId'>[] = [];
  const warnings: string[] = [];

  let role: Message['role'] = 'user';
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content.length === 0) return;
    messages.push({
      seq: messages.length,
      role,
      content,
      createdAt: null,
      tokenEstimate: estimateTokens(content),
      toolName: null,
    });
    buffer = [];
  };

  for (const line of source.content.split('\n')) {
    const match = INLINE_SPEAKER.exec(line);
    if (match) {
      flush();
      const speaker = match[1]!.toLowerCase();
      role =
        speaker === 'assistant' || speaker === 'claude' || speaker === 'ai'
          ? 'assistant'
          : speaker === 'system'
            ? 'system'
            : 'user';
      buffer.push(match[2] ?? '');
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (messages.length === 0) {
    return { drafts: [], warnings: [`${source.name} is empty.`] };
  }
  if (messages.length === 1) {
    warnings.push('No speaker markers found — imported as a single note.');
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
    warnings,
  };
}
