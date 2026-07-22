/**
 * Markdown transcript importer.
 *
 * Handles both Artix's own Markdown export (which carries YAML-ish front
 * matter) and the loose "## User / ## Assistant" convention that most manual
 * exports and copy-pastes end up in.
 *
 * When no speaker headings are found at all, the whole document still imports
 * as a single-message session — a note is better than a failed import.
 */

import { deriveSummary, deriveTitle, estimateTokens, extractFromMessages } from '../core/extract.ts';
import { parseTimestamp } from '../core/time.ts';
import { projectFromFolder, titleFromFilename } from './types.ts';
import type { Importer, ImportResult, ImportSource } from './types.ts';
import type { Message, MessageRole, SessionDraft, SessionStatus } from '../core/types.ts';

const IMPORTER_ID = 'core:markdown';

/** `## User`, `### Assistant:`, `**User**`, `> Human:` — all count. */
const SPEAKER_HEADING =
  /^(?:#{1,6}\s*|\*\*|>\s*)?(user|human|you|me|assistant|claude|ai|model|system|tool)\b[:*\s]*$/i;

const ROLE_ALIASES: Record<string, MessageRole> = {
  user: 'user',
  human: 'user',
  you: 'user',
  me: 'user',
  assistant: 'assistant',
  claude: 'assistant',
  ai: 'assistant',
  model: 'assistant',
  system: 'system',
  tool: 'tool',
};

export const markdownImporter: Importer = {
  id: IMPORTER_ID,
  label: 'Markdown transcript',
  description: 'Markdown with front matter and/or "## User" / "## Assistant" headings.',
  extensions: ['md', 'markdown', 'mdx'],

  detect(source) {
    if (!/\.(md|markdown|mdx)$/i.test(source.name)) {
      // Content-only detection: front matter plus speaker headings.
      if (!source.content.startsWith('---')) return 0;
    }

    let score = 0.35;
    if (source.content.startsWith('---')) score += 0.2;
    if (/^#{1,3}\s+\S/m.test(source.content)) score += 0.15;

    const headings = source.content
      .split('\n')
      .filter((line) => SPEAKER_HEADING.test(line.trim())).length;
    if (headings >= 2) score += 0.3;

    return Math.min(1, score);
  },

  parse(source) {
    return parseMarkdownTranscript(source);
  },
};

export function parseMarkdownTranscript(source: ImportSource): ImportResult {
  const warnings: string[] = [];
  const { frontMatter, body } = splitFrontMatter(source.content);

  const messages = parseMessages(body);

  if (messages.length === 0) {
    // No speaker structure: keep the document as one note-shaped session.
    messages.push({
      seq: 0,
      role: 'user',
      content: body.trim(),
      createdAt: null,
      tokenEstimate: estimateTokens(body),
      toolName: null,
    });
    warnings.push('No speaker headings found — imported as a single note.');
  }

  const extraction = extractFromMessages(messages);
  const folder = frontMatter.folder ?? null;
  const startedAt =
    parseTimestamp(frontMatter.date ?? frontMatter.started ?? frontMatter.startedAt) ??
    source.modifiedAt ??
    Date.now();

  const draft: SessionDraft = {
    title: frontMatter.title ?? deriveTitle(messages) ?? titleFromFilename(source.name),
    project:
      frontMatter.project ?? projectFromFolder(folder, titleFromFilename(source.name) || 'Unsorted'),
    folder,
    summary: frontMatter.summary ?? deriveSummary(messages),
    notes: frontMatter.notes ?? '',
    language: frontMatter.language ?? extraction.language,
    status: parseStatus(frontMatter.status),
    source: IMPORTER_ID,
    sourceRef: source.reference,
    startedAt,
    endedAt: parseTimestamp(frontMatter.ended ?? frontMatter.endedAt) ?? null,
    tags: splitList(frontMatter.tags),
    technologies:
      splitList(frontMatter.technologies).length > 0
        ? splitList(frontMatter.technologies)
        : extraction.technologies,
    messages,
    artifacts: extraction.artifacts,
    files: extraction.files,
  };

  return { drafts: [draft], warnings };
}

/* ------------------------------------------------------------ front matter */

interface FrontMatter {
  [key: string]: string | undefined;
}

/**
 * Minimal YAML front matter reader: `key: value` pairs and `[a, b]` lists.
 *
 * A real YAML parser is a large dependency for something Artix only ever
 * writes itself. Anything unrecognised is ignored rather than throwing.
 */
export function splitFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  if (!content.startsWith('---')) return { frontMatter: {}, body: content };

  const end = content.indexOf('\n---', 3);
  if (end < 0) return { frontMatter: {}, body: content };

  const block = content.slice(3, end);
  // Strip *all* blank lines between the closing fence and the body, not just
  // one — writers vary, and a leading blank line becomes a phantom message.
  const body = content.slice(end + 4).replace(/^(?:[ \t]*\r?\n)+/, '');

  const frontMatter: FrontMatter = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) frontMatter[match[1]!.toLowerCase()] = value;
  }

  return { frontMatter, body };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((v) => v.trim().replace(/^["']|["']$/g, ''))
    .filter((v) => v.length > 0);
}

function parseStatus(value: string | undefined): SessionStatus {
  const normalised = value?.toLowerCase();
  if (normalised === 'active' || normalised === 'paused' || normalised === 'archived') {
    return normalised;
  }
  return 'completed';
}

/* --------------------------------------------------------------- messages */

function parseMessages(body: string): Omit<Message, 'id' | 'sessionId'>[] {
  const lines = body.split('\n');
  const messages: Omit<Message, 'id' | 'sessionId'>[] = [];

  let role: MessageRole | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    if (role === null) return;
    const content = buffer.join('\n').trim();
    if (content.length > 0) {
      messages.push({
        seq: messages.length,
        role,
        content,
        createdAt: null,
        tokenEstimate: estimateTokens(content),
        toolName: null,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    // Never treat a line inside a code fence as a heading — transcripts are
    // full of markdown examples.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    if (!inFence) {
      const match = SPEAKER_HEADING.exec(line.trim());
      if (match) {
        flush();
        role = ROLE_ALIASES[match[1]!.toLowerCase()] ?? 'user';
        continue;
      }
    }

    if (role !== null) buffer.push(line);
  }

  flush();
  return messages;
}
