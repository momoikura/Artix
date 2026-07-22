/**
 * Claude Code / JSONL transcript importer.
 *
 * IMPORTANT: this parser is intentionally *tolerant*, not tied to any
 * documented internal schema. Artix must keep working when the on-disk shape
 * changes, so the parser looks for the handful of things every reasonable
 * transcript format has — a role, some content, maybe a timestamp — and
 * ignores everything else.
 *
 * Shapes handled:
 *   { "type": "user",  "message": { "role": "user", "content": "…" } }
 *   { "type": "assistant", "message": { "content": [{"type":"text","text":"…"}] } }
 *   { "role": "assistant", "content": "…" }
 *   { "role": "user", "content": [{"type":"tool_result","content":"…"}] }
 *   { "type": "summary", "summary": "…" }
 * plus arbitrary metadata keys (`cwd`, `sessionId`, `timestamp`, `gitBranch`…).
 *
 * A line that cannot be parsed is counted and skipped — one corrupt line must
 * never lose a 400-message session.
 */

import { deriveSummary, deriveTitle, estimateTokens, extractFromMessages } from '../core/extract.ts';
import { parseTimestamp } from '../core/time.ts';
import { MESSAGE_ROLES } from '../core/types.ts';
import { projectFromFolder, titleFromFilename } from './types.ts';
import type { Importer, ImportResult, ImportSource } from './types.ts';
import type { Message, MessageRole, SessionDraft } from '../core/types.ts';

type Json = Record<string, unknown>;

const IMPORTER_ID = 'core:claude-jsonl';

export const claudeJsonlImporter: Importer = {
  id: IMPORTER_ID,
  label: 'Claude Code transcript (JSONL)',
  description:
    'Line-delimited JSON transcripts. Tolerant of format changes — reads whatever role/content pairs it can find.',
  extensions: ['jsonl', 'ndjson'],

  detect(source) {
    const lines = firstNonEmptyLines(source.content, 6);
    if (lines.length === 0) return 0;

    let objectLines = 0;
    let messageLines = 0;

    for (const line of lines) {
      const parsed = tryParse(line);
      if (parsed === null) continue;
      objectLines++;
      if (extractRole(parsed) !== null) messageLines++;
    }

    if (objectLines === 0) return 0;
    // A file where most lines are JSON objects carrying a role is unambiguous.
    const ratio = messageLines / lines.length;
    const extensionBonus = /\.(jsonl|ndjson)$/i.test(source.name) ? 0.2 : 0;
    return Math.min(1, ratio * 0.85 + extensionBonus);
  },

  parse(source) {
    return parseJsonlTranscript(source);
  },
};

export function parseJsonlTranscript(source: ImportSource): ImportResult {
  const warnings: string[] = [];
  const messages: Omit<Message, 'id' | 'sessionId'>[] = [];
  // Sub-agent turns, kept aside so they stay searchable without scrambling the
  // order of the main conversation.
  const sidechain: { role: MessageRole; content: string }[] = [];

  let folder: string | null = null;
  let explicitSummary: string | null = null;
  let explicitTitle: string | null = null;
  let gitBranch: string | null = null;
  let sessionId: string | null = null;
  let toolVersion: string | null = null;
  let earliest: number | null = null;
  let latest: number | null = null;
  let unparseable = 0;
  let sidechainSkipped = 0;
  let seq = 0;

  const lines = source.content.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const record = tryParse(line);
    if (record === null) {
      unparseable++;
      continue;
    }

    // Metadata can appear on any line; take the first non-empty value we see.
    folder ??= readString(record, 'cwd', 'workingDirectory', 'folder', 'projectPath');
    explicitSummary ??= readString(record, 'summary', 'description');
    // Titles arrive on their own lines carrying no role. A title the user set
    // themselves outranks a generated one, and both beat anything we could
    // infer from the first message.
    explicitTitle = readString(record, 'customTitle') ?? explicitTitle;
    explicitTitle ??= readString(record, 'aiTitle', 'title', 'name');
    gitBranch ??= readString(record, 'gitBranch', 'branch');
    sessionId ??= readString(record, 'sessionId', 'session_id', 'id');
    toolVersion ??= readString(record, 'version');

    // Sidechains are sub-agent transcripts. Interleaving them would scramble
    // the main thread's order, but discarding them loses real work — so they
    // are set aside and attached as artifacts, which keeps them searchable.
    if (record.isSidechain === true) {
      const role = extractRole(record);
      const content = extractContent(record);
      if (role !== null && content.text.trim().length > 0) {
        sidechain.push({ role, content: content.text });
      }
      sidechainSkipped++;
      continue;
    }

    const timestamp = parseTimestamp(
      record.timestamp ?? record.createdAt ?? record.time ?? record.ts ?? null,
    );
    if (timestamp !== null) {
      if (earliest === null || timestamp < earliest) earliest = timestamp;
      if (latest === null || timestamp > latest) latest = timestamp;
    }

    const role = extractRole(record);
    if (role === null) continue;

    const content = extractContent(record);
    if (content.text.trim().length === 0) continue;

    messages.push({
      seq: seq++,
      role,
      content: content.text,
      createdAt: timestamp,
      tokenEstimate: estimateTokens(content.text),
      toolName: content.toolName,
    });
  }

  if (unparseable > 0) {
    warnings.push(`${unparseable} of ${lines.length} lines could not be parsed and were skipped.`);
  }
  if (sidechainSkipped > 0) {
    warnings.push(
      `${sidechainSkipped} sub-agent entries kept as artifacts rather than inline messages.`,
    );
  }

  if (messages.length === 0) {
    return {
      drafts: [],
      warnings: [...warnings, `No messages found in ${source.name}.`],
    };
  }

  const startedAt = earliest ?? source.modifiedAt ?? Date.now();
  const extraction = extractFromMessages(messages);

  // Sub-agent work becomes searchable notes attached to the parent session.
  if (sidechain.length > 0) {
    extraction.artifacts.push({
      kind: 'note',
      title: `Sub-agent transcript (${sidechain.length} turns)`,
      language: null,
      content: sidechain.map((s) => `**${s.role}:** ${s.content}`).join('\n\n'),
      path: null,
      messageSeq: null,
      done: false,
    });
  }

  const draft: SessionDraft = {
    title: explicitTitle ?? deriveTitle(messages) ?? titleFromFilename(source.name),
    project: projectFromFolder(folder, titleFromFilename(source.name) || 'Unsorted'),
    folder,
    summary: explicitSummary ?? deriveSummary(messages),
    language: extraction.language,
    status: 'completed',
    source: IMPORTER_ID,
    // Prefer the tool's own session id — stable across moves and re-exports in
    // a way an absolute file path is not.
    sourceRef: sessionId ?? source.reference,
    startedAt,
    endedAt: latest ?? null,
    technologies: extraction.technologies,
    // The git branch is excellent for locating past work ("what was I doing on
    // that feature branch?") — but only when it names something. A detached
    // HEAD, or the default branch, says nothing and would just clutter the tag
    // facet on every session.
    tags: isMeaningfulBranch(gitBranch) ? [`branch:${gitBranch}`] : [],
    notes: toolVersion ? `Imported from Claude Code ${toolVersion}.` : '',
    messages,
    artifacts: extraction.artifacts,
    files: extraction.files,
  };

  return { drafts: [draft], warnings };
}

/* ------------------------------------------------------------------ helpers */

function tryParse(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : null;
  } catch {
    return null;
  }
}

function firstNonEmptyLines(content: string, count: number): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Branch names that carry no information. `HEAD` means a detached checkout,
 * and the default branch is where most work happens anyway — tagging every
 * session `branch:main` would make the tag useless as a filter.
 */
const UNINFORMATIVE_BRANCHES = new Set(['head', 'main', 'master', 'trunk', 'default']);

function isMeaningfulBranch(branch: string | null): branch is string {
  return branch !== null && !UNINFORMATIVE_BRANCHES.has(branch.trim().toLowerCase());
}

function readString(record: Json, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/** Find the role, wherever this format chose to put it. */
function extractRole(record: Json): MessageRole | null {
  const candidates = [
    record.role,
    (record.message as Json | undefined)?.role,
    record.type,
    record.sender,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalised = candidate.toLowerCase();
    if (MESSAGE_ROLES.includes(normalised as MessageRole)) return normalised as MessageRole;
    // Common aliases.
    if (normalised === 'human') return 'user';
    if (normalised === 'ai' || normalised === 'model' || normalised === 'bot') return 'assistant';
    if (normalised === 'tool_result' || normalised === 'function') return 'tool';
  }
  return null;
}

interface ExtractedContent {
  text: string;
  toolName: string | null;
}

/**
 * Flatten a content field into plain text.
 *
 * Content may be a string, an array of typed blocks, or a nested `message`
 * object. Tool calls are rendered as fenced JSON so they stay searchable and
 * readable rather than being discarded.
 */
function extractContent(record: Json): ExtractedContent {
  const raw =
    record.content ??
    (record.message as Json | undefined)?.content ??
    record.text ??
    record.summary ??
    null;

  return flatten(raw);
}

function flatten(value: unknown): ExtractedContent {
  if (typeof value === 'string') return { text: value, toolName: null };
  if (value === null || value === undefined) return { text: '', toolName: null };

  if (Array.isArray(value)) {
    const parts: string[] = [];
    let toolName: string | null = null;
    for (const item of value) {
      const flattened = flatten(item);
      if (flattened.text.trim().length > 0) parts.push(flattened.text);
      toolName ??= flattened.toolName;
    }
    return { text: parts.join('\n\n'), toolName };
  }

  if (typeof value === 'object') {
    const block = value as Json;
    const type = typeof block.type === 'string' ? block.type : '';

    if (typeof block.text === 'string') return { text: block.text, toolName: null };

    // Extended-thinking blocks keep their prose in `thinking`, not `text`.
    // Without this they vanish — and they are often where the reasoning behind
    // a decision actually lives, which is exactly what Artix exists to keep.
    if (type === 'thinking' || typeof block.thinking === 'string') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      return thinking.trim().length > 0
        ? { text: `> _Thinking_\n>\n${thinking.split('\n').map((l) => `> ${l}`).join('\n')}`, toolName: null }
        : { text: '', toolName: null };
    }

    // Redacted thinking is opaque ciphertext; record that it happened, not the blob.
    if (type === 'redacted_thinking') {
      return { text: '_(redacted thinking)_', toolName: null };
    }

    if (type === 'tool_use' || typeof block.input === 'object') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const input = block.input ?? block.parameters ?? {};
      return {
        text: `**${name}**\n\n\`\`\`json\n${safeStringify(input)}\n\`\`\``,
        toolName: name,
      };
    }

    if (type === 'tool_result' || 'output' in block) {
      const inner = flatten(block.content ?? block.output ?? '');
      return {
        text: inner.text.length > 0 ? `\`\`\`\n${inner.text}\n\`\`\`` : '',
        toolName: typeof block.name === 'string' ? block.name : null,
      };
    }

    if ('content' in block) return flatten(block.content);
    return { text: '', toolName: null };
  }

  return { text: String(value), toolName: null };
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? '';
    // Tool inputs can contain whole files; keep the transcript readable.
    return json.length > 4000 ? `${json.slice(0, 4000)}\n… truncated` : json;
  } catch {
    return String(value);
  }
}
