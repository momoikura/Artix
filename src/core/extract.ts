/**
 * Content extraction.
 *
 * Turns raw conversation text into the structured things Artix indexes and
 * displays: code blocks, file references, todos, decisions, shell commands and
 * a technology fingerprint.
 *
 * Everything here is heuristic and purely lexical — no model, no network. The
 * bar is "useful and fast", not "perfect": a missed decision costs the user a
 * scroll, and every extraction is editable afterwards.
 */

import { languageFromPath, canonicalLanguageId, UNKNOWN_LANGUAGE } from './languages.ts';
import type { Artifact, ArtifactKind, FileRef, Message } from './types.ts';

/* ------------------------------------------------------------- code blocks */

export interface CodeBlock {
  language: string | null;
  content: string;
  /** Optional `path=` / filename hint on the fence info string. */
  path: string | null;
  messageSeq: number;
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/**
 * Parse fenced code blocks from Markdown-ish text.
 *
 * Handles variable fence lengths, indented fences, and the common
 * ```ts src/foo.ts / ```ts title="foo.ts" info-string conventions that Claude
 * Code and most tooling emit.
 */
export function extractCodeBlocks(text: string, messageSeq = 0): CodeBlock[] {
  const lines = text.split('\n');
  const blocks: CodeBlock[] = [];

  let open: { fence: string; indent: number; info: string; body: string[] } | null = null;

  for (const raw of lines) {
    if (open === null) {
      const m = FENCE.exec(raw);
      if (m) open = { fence: m[2]!, indent: m[1]!.length, info: (m[3] ?? '').trim(), body: [] };
      continue;
    }

    // A closing fence is the same character, at least as long, and has no info.
    const closing = new RegExp(`^[ \\t]*${open.fence[0]}{${open.fence.length},}[ \\t]*$`);
    if (closing.test(raw)) {
      const info = open.info;
      const [langToken = '', ...rest] = info.split(/\s+/);
      const language = canonicalLanguageId(langToken);
      blocks.push({
        language,
        content: open.body.join('\n').replace(/\s+$/, ''),
        path: findPathHint(rest.join(' ')) ?? (language === null ? findPathHint(info) : null),
        messageSeq,
      });
      open = null;
      continue;
    }

    // Strip the fence's own indentation so nested blocks keep their shape.
    open.body.push(open.indent > 0 ? raw.slice(open.indent) : raw);
  }

  return blocks;
}

function findPathHint(info: string): string | null {
  if (!info) return null;
  const quoted = /(?:path|file|title|src)\s*=\s*["']?([^"'\s]+)["']?/i.exec(info);
  if (quoted?.[1]) return quoted[1];
  const bare = /([\w./\\@-]+\.[a-z0-9]{1,8})/i.exec(info);
  return bare?.[1] ?? null;
}

/* -------------------------------------------------------- file references */

/**
 * Paths look like `src/core/foo.ts`, `./x.py`, `C:\a\b.rs`, or appear inside
 * backticks. We require either a directory separator or a known extension to
 * avoid matching every dotted word in prose.
 */
const PATH_PATTERN =
  /(?:^|[\s`("'[])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`)"'\],:;])/g;

const PATH_NOISE = new Set([
  'e.g', 'i.e', 'etc.', 'v1.0', 'node.js', 'vue.js', 'next.js', 'three.js',
]);

export function extractFilePaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_PATTERN)) {
    const candidate = match[1];
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (PATH_NOISE.has(lower)) continue;
    // Reject version-like tokens ("2.14.3") and bare sentence endings.
    if (/^\d+(\.\d+)+$/.test(candidate)) continue;
    if (languageFromPath(candidate) === UNKNOWN_LANGUAGE && !candidate.includes('/') && !candidate.includes('\\')) {
      continue;
    }
    found.add(candidate.replace(/\\/g, '/'));
  }
  return [...found];
}

/* ------------------------------------------------------------------ todos */

const TODO_PATTERNS: readonly RegExp[] = [
  /^[ \t]*[-*][ \t]+\[( |x|X)\][ \t]+(.+)$/,
  /^[ \t]*(?:TODO|FIXME|NOTE)[:\s]+(.+)$/,
];

export interface ExtractedTodo {
  text: string;
  done: boolean;
}

export function extractTodos(text: string): ExtractedTodo[] {
  const out: ExtractedTodo[] = [];
  for (const line of text.split('\n')) {
    const checkbox = TODO_PATTERNS[0]!.exec(line);
    if (checkbox) {
      out.push({ text: checkbox[2]!.trim(), done: checkbox[1]!.toLowerCase() === 'x' });
      continue;
    }
    const marker = TODO_PATTERNS[1]!.exec(line);
    if (marker) out.push({ text: marker[1]!.trim(), done: false });
  }
  return out.filter((t) => t.text.length > 2 && t.text.length < 400);
}

/* -------------------------------------------------------------- decisions */

/**
 * Sentences that read like a recorded choice. Deliberately conservative: a few
 * strong lead-ins beat a fuzzy classifier that fills the panel with noise.
 */
const DECISION_LEADS = [
  "i'll use", 'i will use', "we'll use", 'we will use',
  'decided to', "let's go with", 'going with', 'chose to', 'opted for',
  'the approach is', 'instead of', 'rather than', 'switched to', 'migrated to',
  'because', 'the tradeoff', 'trade-off',
];

export function extractDecisions(text: string): string[] {
  const out: string[] = [];
  // Split on sentence enders that are not inside a code span.
  const stripped = text.replace(/`{1,3}[^`]*`{1,3}/g, ' ');
  for (const sentence of stripped.split(/(?<=[.!?])\s+|\n{2,}/)) {
    const s = sentence.trim();
    if (s.length < 20 || s.length > 320) continue;
    const lower = s.toLowerCase();
    if (DECISION_LEADS.some((lead) => lower.includes(lead))) out.push(s);
  }
  return dedupe(out).slice(0, 40);
}

/* --------------------------------------------------------------- commands */

const COMMAND_LEADS =
  /^(npm|npx|pnpm|yarn|bun|cargo|rustup|go|python3?|pip3?|poetry|uv|git|docker|kubectl|make|gradle|mvn|dotnet|composer|bundle|rails|deno|tauri|vite|tsc|eslint|prettier|pytest|jest|vitest|psql|sqlite3|curl|ssh|terraform)\b/;

export function extractCommands(blocks: readonly CodeBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.language !== null && block.language !== 'shell') continue;
    for (const line of block.content.split('\n')) {
      const cleaned = line.replace(/^[$>#]\s*/, '').trim();
      if (cleaned.length > 2 && cleaned.length < 300 && COMMAND_LEADS.test(cleaned)) {
        out.push(cleaned);
      }
    }
  }
  return dedupe(out).slice(0, 60);
}

/* ------------------------------------------------------------ technologies */

/**
 * Technology fingerprint. Each entry is `[canonical name, matchers]`; matchers
 * are matched case-insensitively on word boundaries so "react" hits but
 * "reactive" does not.
 */
const TECH_SIGNATURES: readonly (readonly [string, readonly string[]])[] = [
  ['React', ['react', 'jsx', 'usestate', 'useeffect']],
  ['Next.js', ['next.js', 'nextjs', 'app router', 'getserversideprops']],
  ['Vue', ['vue', 'vuejs', 'nuxt']],
  ['Svelte', ['svelte', 'sveltekit']],
  ['Angular', ['angular', 'ngmodule', 'rxjs']],
  ['Node.js', ['node.js', 'nodejs', 'express', 'fastify', 'nestjs']],
  ['Deno', ['deno']],
  ['Bun', ['bun.sh', 'bunjs']],
  ['Vite', ['vite', 'vitejs']],
  ['Webpack', ['webpack']],
  ['Tailwind', ['tailwind', 'tailwindcss']],
  ['Three.js', ['three.js', 'threejs', 'webgl', 'webgpu']],
  ['Tauri', ['tauri']],
  ['Electron', ['electron']],
  ['SQLite', ['sqlite', 'fts5', 'better-sqlite3', 'rusqlite']],
  ['PostgreSQL', ['postgres', 'postgresql', 'pgvector']],
  ['MySQL', ['mysql', 'mariadb']],
  ['MongoDB', ['mongodb', 'mongoose']],
  ['Redis', ['redis']],
  ['Prisma', ['prisma']],
  ['Drizzle', ['drizzle-orm', 'drizzle']],
  ['Docker', ['docker', 'dockerfile', 'docker-compose']],
  ['Kubernetes', ['kubernetes', 'kubectl', 'helm']],
  ['Terraform', ['terraform', 'hcl']],
  ['AWS', ['aws', 's3', 'lambda', 'dynamodb', 'cloudformation']],
  ['GCP', ['gcp', 'bigquery', 'cloud run']],
  ['Azure', ['azure']],
  ['Django', ['django']],
  ['Flask', ['flask']],
  ['FastAPI', ['fastapi']],
  ['Rails', ['rails', 'activerecord']],
  ['Laravel', ['laravel', 'eloquent']],
  ['Spring', ['spring boot', 'springboot']],
  ['PyTorch', ['pytorch', 'torch.nn']],
  ['TensorFlow', ['tensorflow', 'keras']],
  ['GraphQL', ['graphql', 'apollo']],
  ['tRPC', ['trpc']],
  ['REST', ['rest api', 'restful']],
  ['WebSocket', ['websocket', 'socket.io']],
  ['Jest', ['jest']],
  ['Vitest', ['vitest']],
  ['Playwright', ['playwright']],
  ['Cypress', ['cypress']],
  ['pytest', ['pytest']],
  ['Git', ['git rebase', 'git merge', 'pull request']],
  ['CI/CD', ['github actions', 'gitlab ci', 'circleci', 'jenkins']],
];

const TECH_MATCHERS = TECH_SIGNATURES.map(([name, needles]) => ({
  name,
  // Escape regex metacharacters in needles (".", "/", "+" all appear).
  pattern: new RegExp(
    `(?<![\\w-])(?:${needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`,
    'i',
  ),
}));

export function detectTechnologies(text: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of TECH_MATCHERS) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

/* ---------------------------------------------------------------- summary */

/**
 * First meaningful prose paragraph, trimmed to a readable length.
 * Prefers the first user message — that is almost always the intent.
 */
export function deriveSummary(messages: readonly Pick<Message, 'role' | 'content'>[]): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  const source = first?.content ?? messages[0]?.content ?? '';
  return summarise(source, 280);
}

export function summarise(text: string, maxLength: number): string {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (prose.length <= maxLength) return prose;

  // Cut at the last sentence boundary that fits, else the last word.
  const window = prose.slice(0, maxLength);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (sentenceEnd > maxLength * 0.5) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(' ');
  return `${window.slice(0, wordEnd > 0 ? wordEnd : maxLength).trimEnd()}…`;
}

/**
 * Title from the first user message: the first line, stripped of markdown and
 * clipped to something that fits on a star label.
 */
export function deriveTitle(messages: readonly Pick<Message, 'role' | 'content'>[]): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!first) return 'Untitled session';
  const line = first.content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('```'));
  if (!line) return 'Untitled session';
  const cleaned = line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  return summarise(cleaned, 72) || 'Untitled session';
}

/* -------------------------------------------------------- token estimation */

/**
 * Rough token count. ~3.7 characters per token is a good average for mixed
 * English + code and is stable enough for context budgeting. Never claimed to
 * be exact — the UI labels it "≈".
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.round(text.length / 3.7));
}

/* --------------------------------------------------------------- assembly */

export interface ExtractionResult {
  artifacts: Omit<Artifact, 'id' | 'sessionId'>[];
  files: Omit<FileRef, 'id' | 'sessionId'>[];
  technologies: string[];
  language: string | null;
}

/**
 * Run every extractor over a session's messages and assemble the structured
 * side of the record. This is what makes an imported transcript *navigable*
 * rather than just searchable.
 */
export function extractFromMessages(
  messages: readonly Pick<Message, 'role' | 'content' | 'seq'>[],
): ExtractionResult {
  const artifacts: Omit<Artifact, 'id' | 'sessionId'>[] = [];
  const filePaths = new Map<string, Omit<FileRef, 'id' | 'sessionId'>>();
  const allBlocks: CodeBlock[] = [];
  const techSet = new Set<string>();

  for (const message of messages) {
    const blocks = extractCodeBlocks(message.content, message.seq);
    allBlocks.push(...blocks);

    for (const block of blocks) {
      if (block.content.trim().length < 12) continue;
      artifacts.push({
        kind: 'code',
        title: block.path ?? `${block.language ?? 'snippet'} block`,
        language: block.language,
        content: block.content,
        path: block.path,
        messageSeq: block.messageSeq,
        done: false,
      });
      if (block.path) {
        upsertFile(filePaths, block.path, 'created', block.content);
      }
    }

    for (const path of extractFilePaths(message.content)) {
      upsertFile(filePaths, path, 'referenced', null);
    }

    for (const todo of extractTodos(message.content)) {
      artifacts.push({
        kind: 'todo',
        title: todo.text,
        language: null,
        content: todo.text,
        path: null,
        messageSeq: message.seq,
        done: todo.done,
      });
    }

    // Only the assistant articulates decisions worth recording.
    if (message.role === 'assistant') {
      for (const decision of extractDecisions(message.content)) {
        artifacts.push({
          kind: 'decision',
          title: summarise(decision, 90),
          language: null,
          content: decision,
          path: null,
          messageSeq: message.seq,
          done: false,
        });
      }
    }

    for (const tech of detectTechnologies(message.content)) techSet.add(tech);
  }

  for (const command of extractCommands(allBlocks)) {
    artifacts.push({
      kind: 'command',
      title: summarise(command, 90),
      language: 'shell',
      content: command,
      path: null,
      messageSeq: null,
      done: false,
    });
  }

  const language = pickPrimaryLanguage(allBlocks, [...filePaths.keys()]);

  return {
    artifacts: capByKind(artifacts),
    files: [...filePaths.values()],
    technologies: [...techSet].sort(),
    language,
  };
}

function upsertFile(
  map: Map<string, Omit<FileRef, 'id' | 'sessionId'>>,
  path: string,
  action: FileRef['action'],
  content: string | null,
): void {
  const existing = map.get(path);
  const spec = languageFromPath(path);
  const language = spec === UNKNOWN_LANGUAGE ? null : spec.id;

  if (!existing) {
    map.set(path, {
      path,
      action,
      language,
      bytes: content ? content.length : -1,
      snippet: content ? content.slice(0, 2048) : null,
    });
    return;
  }

  // "created" is strictly more informative than "referenced".
  if (action === 'created') existing.action = 'created';
  if (content && (existing.snippet === null || content.length > existing.snippet.length)) {
    existing.snippet = content.slice(0, 2048);
    existing.bytes = content.length;
  }
}

/**
 * Data and markup formats. A session that *mentions* JSON is not a JSON
 * session — and agent transcripts are full of tool calls serialised as JSON,
 * which would otherwise outweigh every line of real code by an order of
 * magnitude. These still count, just far less.
 */
const INCIDENTAL_LANGUAGES = new Set(['json', 'yaml', 'toml', 'markdown', 'shell']);
const INCIDENTAL_WEIGHT = 0.08;

/**
 * Primary language.
 *
 * Files touched are the strongest signal — editing twenty `.ts` files makes it
 * a TypeScript session no matter what got pasted into the chat — so each path
 * carries real weight, and incidental data formats are damped hard.
 */
function pickPrimaryLanguage(blocks: readonly CodeBlock[], paths: readonly string[]): string | null {
  const weight = new Map<string, number>();

  const add = (id: string, amount: number) => {
    const scaled = INCIDENTAL_LANGUAGES.has(id) ? amount * INCIDENTAL_WEIGHT : amount;
    weight.set(id, (weight.get(id) ?? 0) + scaled);
  };

  for (const block of blocks) {
    if (!block.language) continue;
    add(block.language, block.content.length);
  }
  for (const path of paths) {
    const spec = languageFromPath(path);
    if (spec === UNKNOWN_LANGUAGE) continue;
    // A touched file is worth roughly a substantial code block.
    add(spec.id, 1200);
  }

  let best: string | null = null;
  let bestWeight = 0;
  // Sort keys for determinism when weights tie.
  for (const key of [...weight.keys()].sort()) {
    const w = weight.get(key)!;
    if (w > bestWeight) {
      best = key;
      bestWeight = w;
    }
  }
  return best;
}

/** Guard against a pathological transcript producing 10k artifacts. */
const KIND_CAPS: Record<ArtifactKind, number> = {
  code: 200,
  architecture: 40,
  decision: 60,
  todo: 150,
  command: 60,
  note: 100,
};

function capByKind(
  artifacts: readonly Omit<Artifact, 'id' | 'sessionId'>[],
): Omit<Artifact, 'id' | 'sessionId'>[] {
  const counts = new Map<ArtifactKind, number>();
  const out: Omit<Artifact, 'id' | 'sessionId'>[] = [];
  for (const a of artifacts) {
    const n = counts.get(a.kind) ?? 0;
    if (n >= KIND_CAPS[a.kind]) continue;
    counts.set(a.kind, n + 1);
    out.push(a);
  }
  return out;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()))].filter((v) => v.length > 0);
}
