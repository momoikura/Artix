/**
 * Perplexity thread importer.
 *
 * Perplexity is a website with no local store, and no bulk JSON export — what it
 * gives you is a thread exported/copied as Markdown, with the answer followed by
 * a numbered list of sources.
 *
 * UNVERIFIED FORMAT. Unlike the Claude Code, ChatGPT and Copilot importers,
 * this one was written without a real export to test against, so it is
 * deliberately conservative:
 *
 *  - `detect` requires an explicit Perplexity marker (a perplexity.ai link, or
 *    the word Perplexity in a heading/attribution). Without one it returns 0 and
 *    the generic Markdown importer handles the file, which is the safe outcome.
 *  - Parsing is structural — question headings, answer prose, a trailing
 *    citation list — rather than dependent on exact punctuation.
 *
 * If Perplexity's shape differs from this, nothing breaks: the file still
 * imports as Markdown. Fixing it later means editing this one file.
 */

import { deriveSummary, estimateTokens, extractFromMessages, summarise } from '../core/extract.ts';
import { splitFrontMatter } from './markdown.ts';
import type { Importer, ImportResult, ImportSource } from './types.ts';
import type { Artifact, Message, SessionDraft } from '../core/types.ts';

const IMPORTER_ID = 'core:perplexity';

/** `[1] https://…` or `[1]: https://…` — the citation list Perplexity appends. */
const CITATION = /^\s*\[(\d{1,3})\]:?\s+(\S+)\s*(.*)$/;

/** A heading that introduces the sources block. */
const SOURCES_HEADING = /^#{1,6}\s*(sources|citations|references)\s*:?\s*$/i;

export const perplexityImporter: Importer = {
  id: IMPORTER_ID,
  label: 'Perplexity thread',
  description: 'A Perplexity thread exported or copied as Markdown, with its sources.',
  extensions: ['md', 'markdown', 'txt'],

  detect(source) {
    const text = source.content;
    // Require an unambiguous marker. Perplexity exports are otherwise just
    // Markdown, and stealing every Markdown file would be far worse than
    // missing a Perplexity one.
    const branded =
      /perplexity\.ai/i.test(text) ||
      /^\s*#{1,6}\s*.*perplexity/im.test(text) ||
      /(^|\n)\s*(generated|answered|exported)\s+(by|from)\s+perplexity/i.test(text);
    if (!branded) return 0;

    // Confidence rises when the citation structure is also present.
    const hasCitations = text.split('\n').some((line) => CITATION.test(line));
    return hasCitations ? 0.95 : 0.7;
  },

  parse(source) {
    return parsePerplexityThread(source);
  },
};

export function parsePerplexityThread(source: ImportSource): ImportResult {
  const { frontMatter, body } = splitFrontMatter(source.content);
  const { prose, citations } = splitCitations(body);

  const messages: Omit<Message, 'id' | 'sessionId'>[] = [];
  const exchanges = splitExchanges(prose);

  for (const exchange of exchanges) {
    if (exchange.question) {
      messages.push(message('user', exchange.question, messages.length));
    }
    if (exchange.answer.trim()) {
      messages.push(message('assistant', exchange.answer, messages.length));
    }
  }

  if (messages.length === 0) {
    const whole = prose.trim();
    if (whole.length === 0) {
      return { drafts: [], warnings: [`${source.name} is empty.`] };
    }
    messages.push(message('assistant', whole, 0));
  }

  const extraction = extractFromMessages(messages);

  // Citations are the distinctive thing a Perplexity thread carries; keep them
  // as a note so they stay searchable and visible in the workspace.
  const artifacts: Omit<Artifact, 'id' | 'sessionId'>[] = [...extraction.artifacts];
  if (citations.length > 0) {
    artifacts.push({
      kind: 'note',
      title: `Sources (${citations.length})`,
      language: null,
      content: citations.map((c) => `[${c.index}] ${c.url}${c.note ? ` — ${c.note}` : ''}`).join('\n'),
      path: null,
      messageSeq: null,
      done: false,
    });
  }

  const title =
    frontMatter.title ??
    exchanges[0]?.question ??
    summarise(messages[0]!.content, 72) ??
    'Perplexity thread';

  const draft: SessionDraft = {
    title: summarise(title, 90),
    project: 'Perplexity',
    folder: null,
    summary: deriveSummary(messages),
    language: extraction.language,
    status: 'completed',
    source: IMPORTER_ID,
    sourceRef: source.reference,
    startedAt: source.modifiedAt ?? Date.now(),
    endedAt: null,
    tags: [],
    technologies: extraction.technologies,
    messages,
    artifacts,
    files: extraction.files,
  };

  return { drafts: [draft], warnings: [] };
}

/* ---------------------------------------------------------------- helpers */

function message(
  role: 'user' | 'assistant',
  content: string,
  seq: number,
): Omit<Message, 'id' | 'sessionId'> {
  const trimmed = content.trim();
  return {
    seq,
    role,
    content: trimmed,
    createdAt: null,
    tokenEstimate: estimateTokens(trimmed),
    toolName: null,
  };
}

export interface Citation {
  index: number;
  url: string;
  note: string;
}

/**
 * Peel the trailing citation list off the prose.
 *
 * Only a *contiguous run* of citation lines at the end (optionally under a
 * "Sources" heading) is treated as the bibliography — a stray `[1] …` in the
 * middle of an answer stays part of the answer.
 */
export function splitCitations(body: string): { prose: string; citations: Citation[] } {
  const lines = body.split('\n');
  const citations: Citation[] = [];

  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === '') continue;

    const match = CITATION.exec(line);
    if (match) {
      citations.unshift({
        index: Number(match[1]),
        url: match[2]!,
        note: (match[3] ?? '').trim(),
      });
      cut = i;
      continue;
    }
    // A "Sources" heading directly above the run belongs to it.
    if (citations.length > 0 && SOURCES_HEADING.test(line.trim())) cut = i;
    break;
  }

  return { prose: lines.slice(0, cut).join('\n'), citations };
}

interface Exchange {
  question: string;
  answer: string;
}

/**
 * Split into question/answer pairs.
 *
 * A Perplexity thread reads as headings (the questions asked) followed by the
 * answer prose. When there are no headings the whole document is one answer.
 */
export function splitExchanges(prose: string): Exchange[] {
  const lines = prose.split('\n');
  const exchanges: Exchange[] = [];

  let question: string | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const answer = buffer.join('\n').trim();
    if (question !== null || answer.length > 0) {
      exchanges.push({ question: question ?? '', answer });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const heading = !inFence ? /^#{1,6}\s+(.*\S)\s*$/.exec(line) : null;
    if (heading && !SOURCES_HEADING.test(line.trim())) {
      flush();
      question = heading[1]!.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return exchanges.filter((e) => e.question || e.answer);
}
