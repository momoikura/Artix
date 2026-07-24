/**
 * GitHub Copilot Chat importer (VS Code).
 *
 * Unlike the cloud tools, Copilot Chat keeps its history *locally*, so it can be
 * imported directly with no export step:
 *
 *   <VS Code user dir>/workspaceStorage/<hash>/chatSessions/<uuid>.json
 *
 * Shape (verified against real sessions on disk):
 *
 *   { sessionId, creationDate, lastMessageDate, responderUsername,
 *     requests: [ { message: { text }, response: [...], timestamp,
 *                   contentReferences: [ { reference: { fsPath, path } } ] } ] }
 *
 * Each `request` is one exchange: the user's `message.text` and the assistant's
 * reply, which arrives as an array of parts — strings carrying markdown, plus
 * typed parts such as `codeblockUri` pointing at files. Those URIs and the
 * `contentReferences` are real workspace paths, so the project name is derived
 * from their common ancestor rather than guessed.
 */

import { deriveSummary, deriveTitle, estimateTokens, extractFromMessages } from '../core/extract.ts';
import { parseTimestamp } from '../core/time.ts';
import { languageFromPath, UNKNOWN_LANGUAGE } from '../core/languages.ts';
import type { Importer, ImportResult, ImportSource } from './types.ts';
import type { FileRef, Message, SessionDraft } from '../core/types.ts';

const IMPORTER_ID = 'core:copilot';

type Json = Record<string, unknown>;

export const copilotImporter: Importer = {
  id: IMPORTER_ID,
  label: 'GitHub Copilot Chat',
  description: 'Copilot Chat sessions stored locally by VS Code. No export needed.',
  extensions: ['json'],

  detect(source) {
    const head = source.content.slice(0, 1500);
    if (!head.includes('"requests"')) return 0;
    // `responderUsername` is Copilot-specific and appears in the header.
    if (/"responderUsername"\s*:\s*"[^"]*Copilot/i.test(head)) return 1;
    // Structural fallback: a requests array of message/response pairs.
    if (head.includes('"requesterUsername"') || head.includes('"sessionId"')) return 0.85;
    return 0;
  },

  parse(source) {
    return parseCopilotSession(source);
  },
};

export function parseCopilotSession(source: ImportSource): ImportResult {
  let root: unknown;
  try {
    root = JSON.parse(source.content);
  } catch (e) {
    return {
      drafts: [],
      warnings: [`${source.name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (typeof root !== 'object' || root === null) {
    return { drafts: [], warnings: [`${source.name} is not a Copilot session.`] };
  }

  const session = root as Json;
  const requests = Array.isArray(session.requests) ? session.requests : [];

  const messages: Omit<Message, 'id' | 'sessionId'>[] = [];
  const referencedPaths = new Set<string>();

  for (const entry of requests) {
    if (typeof entry !== 'object' || entry === null) continue;
    const request = entry as Json;
    const at = parseTimestamp(request.timestamp);

    const prompt = readPrompt(request.message);
    if (prompt) {
      messages.push({
        seq: messages.length,
        role: 'user',
        content: prompt,
        createdAt: at,
        tokenEstimate: estimateTokens(prompt),
        toolName: null,
      });
    }

    const reply = readResponse(request.response, referencedPaths);
    if (reply) {
      messages.push({
        seq: messages.length,
        role: 'assistant',
        content: reply,
        createdAt: at,
        tokenEstimate: estimateTokens(reply),
        toolName: null,
      });
    }

    collectReferences(request.contentReferences, referencedPaths);
  }

  if (messages.length === 0) {
    // Copilot leaves empty session files behind whenever a panel is opened and
    // never used; those are not worth a star.
    return { drafts: [], warnings: [] };
  }

  const paths = [...referencedPaths];
  const root_ = commonDirectory(paths);
  const extraction = extractFromMessages(messages);

  // File references come from the editor itself, so they beat anything the
  // text-scraping extractor guessed at.
  const files = mergeFiles(extraction.files, paths);

  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : null;
  const startedAt =
    parseTimestamp(session.creationDate) ??
    messages.find((m) => m.createdAt !== null)?.createdAt ??
    source.modifiedAt ??
    Date.now();

  const draft: SessionDraft = {
    title:
      (typeof session.customTitle === 'string' && session.customTitle.trim()) ||
      deriveTitle(messages),
    project: root_ ? basename(root_) : 'Copilot',
    folder: root_,
    summary: deriveSummary(messages),
    language: extraction.language,
    status: 'completed',
    source: IMPORTER_ID,
    sourceRef: sessionId ? `copilot:${sessionId}` : source.reference,
    startedAt,
    endedAt: parseTimestamp(session.lastMessageDate) ?? null,
    tags: [],
    technologies: extraction.technologies,
    messages,
    artifacts: extraction.artifacts,
    files,
  };

  return { drafts: [draft], warnings: [] };
}

/* ------------------------------------------------------------------ parts */

function readPrompt(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const text = (message as Json).text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Flatten a response array into markdown.
 *
 * String `value` parts are the prose. Typed parts (`codeblockUri`, references)
 * carry no readable text but do carry paths worth recording, so they are
 * harvested into `paths` rather than rendered.
 */
function readResponse(response: unknown, paths: Set<string>): string {
  if (!Array.isArray(response)) {
    return typeof response === 'string' ? response.trim() : '';
  }

  const chunks: string[] = [];
  for (const part of response) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (typeof part !== 'object' || part === null) continue;
    const block = part as Json;

    if (typeof block.value === 'string') {
      chunks.push(block.value);
      continue;
    }
    const path = readUriPath(block.uri);
    if (path) paths.add(path);
  }

  return chunks.join('').trim();
}

function collectReferences(references: unknown, paths: Set<string>): void {
  if (!Array.isArray(references)) return;
  for (const entry of references) {
    if (typeof entry !== 'object' || entry === null) continue;
    const reference = (entry as Json).reference ?? entry;
    const path = readUriPath(reference);
    if (path) paths.add(path);
  }
}

/** Pull a filesystem path out of a VS Code URI-ish object. */
function readUriPath(uri: unknown): string | null {
  if (typeof uri !== 'object' || uri === null) return null;
  const value = uri as Json;

  const raw =
    (typeof value.fsPath === 'string' && value.fsPath) ||
    (typeof value.path === 'string' && value.path) ||
    null;
  if (!raw) return null;

  // Only real files on disk; skip untitled buffers and virtual schemes.
  if (typeof value.scheme === 'string' && value.scheme !== 'file' && value.scheme !== '') {
    return null;
  }
  return normalisePath(raw);
}

/** `/c:/Users/x/y.ts` and `c:\Users\x\y.ts` both become `c:/Users/x/y.ts`. */
export function normalisePath(raw: string): string {
  let path = raw.replace(/\\/g, '/');
  try {
    path = decodeURIComponent(path);
  } catch {
    // Leave a malformed escape alone rather than losing the path.
  }
  // A Windows drive letter arrives with a leading slash in URI form.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

/* ------------------------------------------------------------------ paths */

/** Longest directory prefix shared by every path — the workspace root. */
export function commonDirectory(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;

  const split = paths.map((p) => p.split('/').slice(0, -1));
  let prefix = split[0]!;

  for (const segments of split.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < segments.length && prefix[i] === segments[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) return null;
  }

  const joined = prefix.join('/');
  // A bare drive root is not a project.
  return /^[A-Za-z]:?$/.test(joined) || joined === '' ? null : joined;
}

/**
 * Directory names that are part of a project's structure rather than its
 * identity. When every referenced file sits under one of these, the common
 * ancestor is that subdirectory — so walk up to reach the real project name.
 */
const STRUCTURAL_DIRS = new Set([
  'src', 'lib', 'app', 'dist', 'build', 'out', 'test', 'tests', '__tests__',
  'components', 'pages', 'public', 'assets', 'static', 'scripts', 'styles', 'css', 'js',
]);

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);

  for (let i = parts.length - 1; i >= 0; i--) {
    const segment = parts[i]!;
    // Stop at a drive root — there is no project name above it.
    if (/^[A-Za-z]:$/.test(segment)) break;
    if (!STRUCTURAL_DIRS.has(segment.toLowerCase())) return segment;
  }

  return parts[parts.length - 1] ?? path;
}

/** Union the editor's own file references with anything scraped from prose. */
function mergeFiles(
  extracted: Omit<FileRef, 'id' | 'sessionId'>[],
  paths: readonly string[],
): Omit<FileRef, 'id' | 'sessionId'>[] {
  const byPath = new Map(extracted.map((file) => [file.path, file]));

  for (const path of paths) {
    if (byPath.has(path)) continue;
    const spec = languageFromPath(path);
    byPath.set(path, {
      path,
      action: 'referenced',
      language: spec === UNKNOWN_LANGUAGE ? null : spec.id,
      bytes: -1,
      snippet: null,
    });
  }

  return [...byPath.values()];
}
