/**
 * Context bundle exporter — the point of the whole application.
 *
 * A bundle is a compact, self-contained briefing that the user pastes at the
 * start of a fresh Claude Code session so work resumes where it left off,
 * without re-analysing the project. This is Artix's answer to context limits,
 * and it uses no proprietary API: it is text, and it goes on the clipboard.
 *
 * The hard part is the budget. A bundle must fit comfortably inside a context
 * window while carrying the highest-value information, so content is selected
 * in strict priority order and each tier is capped:
 *
 *   1. Identity — what/where/when. Cheap, always included.
 *   2. Summary and user notes. The human's own framing beats any extraction.
 *   3. Decisions. Irreplaceable: the *why* is never recoverable from the code.
 *   4. Open todos. What to do next.
 *   5. Architecture. Orientation without reading the tree.
 *   6. Touched files. Lets Claude Code re-read the right things itself —
 *      pointers are far cheaper than contents.
 *   7. Key code. Only when budget remains.
 *   8. Conversation tail. The most recent exchange, last and first to be cut.
 */

import { estimateTokens, summarise } from '../core/extract.ts';
import { formatDuration, isoDate } from '../core/time.ts';
import { resolveLanguage } from '../core/languages.ts';
import { safeFileName } from './types.ts';
import type { Exporter, ExportFile, ExportOptions } from './types.ts';
import type { SessionDetail } from '../core/types.ts';

export interface BundleOptions {
  /**
   * Target size in tokens. 6000 leaves plenty of room for the actual work in
   * any modern context window while carrying a genuinely useful briefing.
   */
  tokenBudget: number;
  /** Include a trailing instruction telling the assistant what to do with it. */
  includePreamble: boolean;
  /** Number of trailing messages to quote, budget permitting. */
  conversationTail: number;
}

export const DEFAULT_BUNDLE_OPTIONS: BundleOptions = {
  tokenBudget: 6000,
  includePreamble: true,
  conversationTail: 6,
};

/** Tracks the remaining budget as sections are appended. */
class Budget {
  #remaining: number;

  constructor(tokens: number) {
    this.#remaining = tokens;
  }

  get remaining(): number {
    return this.#remaining;
  }

  /** Charge `text` against the budget. Returns false when it does not fit. */
  charge(text: string): boolean {
    const cost = estimateTokens(text);
    if (cost > this.#remaining) return false;
    this.#remaining -= cost;
    return true;
  }

  /** Charge unconditionally — for sections that must always be present. */
  force(text: string): void {
    this.#remaining -= estimateTokens(text);
  }
}

export function renderContextBundle(
  sessions: readonly SessionDetail[],
  options: BundleOptions = DEFAULT_BUNDLE_OPTIONS,
): string {
  const out: string[] = [];
  const budget = new Budget(options.tokenBudget);

  if (options.includePreamble) {
    const preamble = [
      '# Prior session context',
      '',
      'The following is a reconstructed briefing from previous development sessions,',
      'exported from a local archive. Use it to continue the work without re-analysing',
      'the project from scratch. Ask before assuming anything not stated here.',
      '',
    ].join('\n');
    out.push(preamble);
    budget.force(preamble);
  }

  // Split the budget evenly, then let earlier sessions spend leftovers.
  const perSession = Math.floor(budget.remaining / Math.max(1, sessions.length));

  for (const detail of sessions) {
    const section = renderOne(detail, new Budget(Math.min(perSession, budget.remaining)), options);
    if (!budget.charge(section)) break;
    out.push(section);
  }

  return out.join('\n').trimEnd() + '\n';
}

function renderOne(detail: SessionDetail, budget: Budget, options: BundleOptions): string {
  const { session, messages, artifacts, files } = detail;
  const out: string[] = [];

  /* 1. Identity — always included. */
  const header = [
    `## ${session.title}`,
    '',
    `- **Project:** ${session.project}${session.folder ? ` (\`${session.folder}\`)` : ''}`,
    `- **When:** ${isoDate(session.startedAt)} · ${formatDuration(
      session.endedAt ? session.endedAt - session.startedAt : null,
    )}`,
    `- **Stack:** ${
      [
        session.language ? resolveLanguage(session.language).label : null,
        ...session.technologies,
      ]
        .filter(Boolean)
        .join(', ') || '—'
    }`,
    `- **Status:** ${session.status}`,
    '',
  ].join('\n');
  out.push(header);
  budget.force(header);

  /* 2. Summary and notes. */
  if (session.summary) {
    push(out, budget, `**Summary.** ${summarise(session.summary, 600)}\n`);
  }
  if (session.notes.trim()) {
    push(out, budget, `**My notes.**\n${summarise(session.notes, 900)}\n`);
  }

  /* 3. Decisions — the highest-value content in the whole bundle. */
  const decisions = artifacts.filter((a) => a.kind === 'decision');
  if (decisions.length > 0) {
    pushList(
      out,
      budget,
      'Decisions made',
      decisions.map((d) => summarise(d.content, 220)),
      12,
    );
  }

  /* 4. Open todos. Completed ones are noise in a "continue from here" briefing. */
  const todos = artifacts.filter((a) => a.kind === 'todo' && !a.done);
  if (todos.length > 0) {
    pushList(out, budget, 'Open items', todos.map((t) => t.title), 12);
  }

  /* 5. Architecture. */
  const architecture = artifacts.filter((a) => a.kind === 'architecture');
  for (const item of architecture.slice(0, 2)) {
    push(out, budget, `**Architecture — ${item.title}**\n\n\`\`\`\n${summarise(item.content, 700)}\n\`\`\`\n`);
  }

  /* 6. File pointers. Cheap, and they let the assistant re-read the real thing. */
  if (files.length > 0) {
    const grouped = files
      .filter((f) => f.action === 'created' || f.action === 'modified')
      .slice(0, 40)
      .map((f) => `\`${f.path}\``);
    if (grouped.length > 0) {
      push(
        out,
        budget,
        `**Files touched.** ${grouped.join(', ')}\n\n_Re-read these rather than trusting any snippet below._\n`,
      );
    }
  }

  /* 7. Key code — only what still fits. */
  const code = artifacts
    .filter((a) => a.kind === 'code' && a.content.length > 40)
    .sort((a, b) => b.content.length - a.content.length)
    .slice(0, 3);
  for (const snippet of code) {
    const block = `**\`${snippet.path ?? snippet.title}\`**\n\n\`\`\`${snippet.language ?? ''}\n${
      snippet.content.length > 1400 ? `${snippet.content.slice(0, 1400)}\n// … truncated` : snippet.content
    }\n\`\`\`\n`;
    if (!push(out, budget, block)) break;
  }

  /* 8. Conversation tail — last in, first cut. */
  const tail = messages.slice(-options.conversationTail);
  if (tail.length > 0 && budget.remaining > 400) {
    const quoted = tail
      .map((m) => `**${m.role}:** ${summarise(m.content, 400)}`)
      .join('\n\n');
    push(out, budget, `**How the session ended**\n\n${quoted}\n`);
  }

  return out.join('\n');
}

/** Append `text` if it fits. Returns whether it was appended. */
function push(out: string[], budget: Budget, text: string): boolean {
  if (!budget.charge(text)) return false;
  out.push(text);
  return true;
}

/** Append as many list items as fit, newest/most important first. */
function pushList(
  out: string[],
  budget: Budget,
  heading: string,
  items: readonly string[],
  max: number,
): void {
  const lines: string[] = [`**${heading}**`, ''];
  let added = 0;

  for (const item of items.slice(0, max)) {
    const line = `- ${item}`;
    if (!budget.charge(line)) break;
    lines.push(line);
    added++;
  }

  if (added === 0) return;
  if (items.length > added) lines.push(`- _…and ${items.length - added} more_`);
  lines.push('');
  out.push(lines.join('\n'));
}

export const contextBundleExporter: Exporter = {
  id: 'core:context-bundle',
  label: 'Context bundle',
  description:
    'A compact briefing sized for a context window. Paste into a new Claude Code session to resume work.',
  extension: 'md',
  multiFile: false,

  render(sessions: readonly SessionDetail[], _options: ExportOptions): ExportFile[] {
    const name =
      sessions.length === 1 && sessions[0]
        ? `${safeFileName(sessions[0].session.title, sessions[0].session.id)}-context.md`
        : 'artix-context-bundle.md';

    return [{ path: name, content: renderContextBundle(sessions) }];
  },
};
