/**
 * ChatGPT export importer.
 *
 * ChatGPT is a website, so there is no local transcript to watch — but it
 * offers an official data export (Settings → Data controls → Export). That
 * produces a `conversations.json`, and this importer reads it. Combined with
 * the watched-folder auto-import, dropping that file (or letting it land in
 * Downloads) brings your ChatGPT history into Artix, still fully offline.
 *
 * The format is a tree, not a list: each conversation has a `mapping` of
 * message nodes linked by `parent`/`children`, so a linear reading requires a
 * traversal from the root rather than trusting array order. Regenerated exports
 * reuse the same `conversation_id`, so re-importing updates in place rather than
 * duplicating.
 */

import { deriveSummary, estimateTokens, extractFromMessages } from '../core/extract.ts';
import { parseTimestamp } from '../core/time.ts';
import type { Importer, ImportResult, ImportSource } from './types.ts';
import type { Message, MessageRole, SessionDraft } from '../core/types.ts';

const IMPORTER_ID = 'core:chatgpt';

type Json = Record<string, unknown>;

interface MappingNode {
  id?: string;
  message?: Json | null;
  parent?: string | null;
  children?: string[];
}

export const chatgptImporter: Importer = {
  id: IMPORTER_ID,
  label: 'ChatGPT export',
  description: 'The conversations.json from a ChatGPT data export (Settings → Data controls).',
  extensions: ['json'],

  detect(source) {
    const head = source.content.slice(0, 2000);
    // The two structural fingerprints of a ChatGPT export: the message-node
    // `mapping` and an `author.role`. Both present is unambiguous.
    const hasMapping = head.includes('"mapping"');
    const hasAuthor = /"author"\s*:\s*\{[^}]*"role"/.test(head) || source.content.includes('"content_type"');
    if (hasMapping && hasAuthor) return 1;
    // A file literally named like an export, that at least parses as JSON.
    if (/conversations?\.json$/i.test(source.name) && head.trimStart().startsWith('[')) return 0.6;
    return 0;
  },

  parse(source) {
    return parseChatgptExport(source);
  },
};

export function parseChatgptExport(source: ImportSource): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch (e) {
    return {
      drafts: [],
      warnings: [`${source.name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // An export is an array of conversations; a single shared conversation is one
  // object. Accept either.
  const conversations = Array.isArray(parsed) ? parsed : [parsed];
  const drafts: SessionDraft[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (const raw of conversations) {
    if (typeof raw !== 'object' || raw === null) continue;
    const draft = conversationToDraft(raw as Json, source);
    if (draft) drafts.push(draft);
    else skipped++;
  }

  if (drafts.length === 0) {
    return { drafts: [], warnings: [...warnings, `No conversations found in ${source.name}.`] };
  }
  if (skipped > 0) warnings.push(`${skipped} empty conversation${skipped === 1 ? '' : 's'} skipped.`);

  return { drafts, warnings };
}

function conversationToDraft(conversation: Json, source: ImportSource): SessionDraft | null {
  const mapping = conversation.mapping;
  if (typeof mapping !== 'object' || mapping === null) return null;

  const messages = linearize(mapping as Record<string, MappingNode>);
  if (messages.length === 0) return null;

  const title =
    (typeof conversation.title === 'string' && conversation.title.trim()) || 'ChatGPT conversation';
  const startedAt =
    parseTimestamp(conversation.create_time) ??
    messages.find((m) => m.createdAt !== null)?.createdAt ??
    source.modifiedAt ??
    Date.now();
  const endedAt = parseTimestamp(conversation.update_time) ?? lastTimestamp(messages);

  // conversation_id is stable across re-exports, so it is the upsert identity.
  const id =
    (typeof conversation.conversation_id === 'string' && conversation.conversation_id) ||
    (typeof conversation.id === 'string' && conversation.id) ||
    `${title}:${startedAt}`;

  const extraction = extractFromMessages(messages);

  return {
    title,
    project: 'ChatGPT',
    folder: null,
    summary: deriveSummary(messages),
    language: extraction.language,
    status: 'completed',
    source: IMPORTER_ID,
    sourceRef: `chatgpt:${id}`,
    startedAt,
    endedAt,
    tags: [],
    technologies: extraction.technologies,
    messages,
    artifacts: extraction.artifacts,
    files: extraction.files,
  };
}

/**
 * Walk the message tree from its root into a linear transcript.
 *
 * The root is the node with no (resolvable) parent. Children are visited in
 * order; hidden system scaffolding and empty nodes are dropped. This yields the
 * correct order for the linear conversations that make up almost every export,
 * and a sensible one for the rare branched conversation.
 */
function linearize(mapping: Record<string, MappingNode>): Omit<Message, 'id' | 'sessionId'>[] {
  const roots = Object.values(mapping).filter(
    (node) => !node.parent || !mapping[node.parent],
  );

  const out: Omit<Message, 'id' | 'sessionId'>[] = [];
  const seen = new Set<string>();

  const visit = (nodeId: string | undefined): void => {
    if (!nodeId || seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!node) return;

    const message = toMessage(node.message, out.length);
    if (message) out.push(message);

    for (const child of node.children ?? []) visit(child);
  };

  for (const root of roots) visit(root.id ?? findKey(mapping, root));
  return out;
}

function toMessage(
  message: Json | null | undefined,
  seq: number,
): Omit<Message, 'id' | 'sessionId'> | null {
  if (!message || typeof message !== 'object') return null;

  const author = message.author as Json | undefined;
  const role = normaliseRole(typeof author?.role === 'string' ? author.role : undefined);
  if (role === null) return null;

  // ChatGPT hides the system prompt and some tool scaffolding; skip those.
  const metadata = message.metadata as Json | undefined;
  if (metadata?.is_visually_hidden_from_conversation === true) return null;

  const content = extractContent(message.content);
  if (content.trim().length === 0) return null;

  return {
    seq,
    role,
    content,
    createdAt: parseTimestamp(message.create_time),
    tokenEstimate: estimateTokens(content),
    toolName: role === 'tool' ? readToolName(author, message) : null,
  };
}

function extractContent(content: unknown): string {
  if (typeof content !== 'object' || content === null) {
    return typeof content === 'string' ? content : '';
  }
  const block = content as Json;
  const type = typeof block.content_type === 'string' ? block.content_type : 'text';

  // Plain text and multimodal text both expose `parts`.
  if (Array.isArray(block.parts)) {
    return block.parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null) {
          const p = part as Json;
          // Image/audio/file parts have no text; note them rather than drop them.
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content_type === 'string') return `_(${p.content_type})_`;
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }

  // Tool/code output carries `text` directly; fence it so it reads as output.
  if (typeof block.text === 'string') {
    return type === 'code' || type === 'execution_output'
      ? `\`\`\`\n${block.text}\n\`\`\``
      : block.text;
  }

  return '';
}

function normaliseRole(role: string | undefined): MessageRole | null {
  if (!role) return null;
  const lower = role.toLowerCase();
  if (lower === 'user' || lower === 'assistant' || lower === 'system' || lower === 'tool') {
    return lower;
  }
  return null;
}

function readToolName(author: Json | undefined, message: Json): string | null {
  if (typeof author?.name === 'string') return author.name;
  if (typeof message.recipient === 'string' && message.recipient !== 'all') return message.recipient;
  return null;
}

function lastTimestamp(messages: readonly Omit<Message, 'id' | 'sessionId'>[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i]!.createdAt;
    if (ts !== null) return ts;
  }
  return null;
}

/** Recover a node's key when its own `id` field is absent. */
function findKey(mapping: Record<string, MappingNode>, node: MappingNode): string | undefined {
  for (const [key, value] of Object.entries(mapping)) if (value === node) return key;
  return undefined;
}
