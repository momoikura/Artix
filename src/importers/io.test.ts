/**
 * Import/export round-trip tests.
 *
 * The most valuable property here is that Artix can read back what it writes:
 * an export that cannot be re-imported is data loss with extra steps.
 */

import { describe, expect, it } from 'vitest';

import { buildSession } from '../core/session.ts';
import { DAY } from '../core/time.ts';
import { ImporterRegistry, importers, runImport } from './registry.ts';
import { claudeJsonlImporter } from './claude-jsonl.ts';
import { jsonImporter } from './json.ts';
import { markdownImporter, splitFrontMatter } from './markdown.ts';
import { textImporter } from './text.ts';
import { markdownExporter } from '../exporters/markdown.ts';
import { jsonExporter, textExporter } from '../exporters/json.ts';
import { renderContextBundle } from '../exporters/context-bundle.ts';
import { DEFAULT_EXPORT_OPTIONS } from '../exporters/types.ts';
import { estimateTokens } from '../core/extract.ts';
import { MemoryStorageAdapter } from '../storage/memory-adapter.ts';
import type { ImportSource } from './types.ts';
import type { SessionDetail } from '../core/types.ts';

const NOW = Date.UTC(2026, 6, 22);

function source(name: string, content: string): ImportSource {
  return { reference: `test://${name}`, name, content, modifiedAt: NOW };
}

/* ------------------------------------------------------------ JSONL */

const JSONL = [
  JSON.stringify({ type: 'summary', summary: 'Fixing the render loop', cwd: '/home/dev/artix' }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-20T10:00:00Z',
    message: { role: 'user', content: 'The galaxy stutters when I zoom. Look at `src/renderer/loop.ts`.' },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-20T10:01:00Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll clamp dt because a backgrounded tab produces a huge delta.\n\n```ts src/renderer/loop.ts\nconst dt = Math.min(raw, 0.05);\n```" },
        { type: 'tool_use', name: 'Edit', input: { path: 'src/renderer/loop.ts' } },
      ],
    },
  }),
  '{ this is not json',
  JSON.stringify({ role: 'user', content: '- [ ] verify on a 144Hz display' }),
].join('\n');

describe('JSONL importer', () => {
  it('detects line-delimited transcripts confidently', () => {
    expect(claudeJsonlImporter.detect(source('a.jsonl', JSONL))).toBeGreaterThan(0.6);
    expect(claudeJsonlImporter.detect(source('a.md', '# not json'))).toBe(0);
  });

  it('parses messages, metadata and tool calls', () => {
    const result = claudeJsonlImporter.parse(source('session.jsonl', JSONL));
    const draft = result.drafts[0]!;

    expect(result.drafts).toHaveLength(1);
    expect(draft.messages).toHaveLength(3);
    expect(draft.folder).toBe('/home/dev/artix');
    expect(draft.project).toBe('artix');
    expect(draft.summary).toBe('Fixing the render loop');
    expect(draft.startedAt).toBe(Date.parse('2026-07-20T10:00:00Z'));
    // The tool call is preserved as readable, searchable text.
    expect(draft.messages![1]!.content).toContain('**Edit**');
  });

  it('reports unparseable lines without losing the session', () => {
    const result = claudeJsonlImporter.parse(source('session.jsonl', JSONL));
    expect(result.warnings.some((w) => w.includes('could not be parsed'))).toBe(true);
    expect(result.drafts).toHaveLength(1);
  });

  it('extracts artifacts from the transcript', () => {
    const draft = claudeJsonlImporter.parse(source('session.jsonl', JSONL)).drafts[0]!;
    expect(draft.language).toBe('typescript');
    expect(draft.artifacts!.some((a) => a.kind === 'code')).toBe(true);
    expect(draft.artifacts!.some((a) => a.kind === 'todo')).toBe(true);
    expect(draft.files!.some((f) => f.path === 'src/renderer/loop.ts')).toBe(true);
  });

  /**
   * Pinned against the real on-disk shape observed in ~/.claude/projects:
   * an `aiTitle` line with no role, `thinking` content blocks, `gitBranch`,
   * `sessionId`, and sidechain sub-agent entries.
   */
  it('reads the real Claude Code record shape', () => {
    const real = [
      JSON.stringify({ type: 'summary', aiTitle: 'Refactor the query planner', sessionId: 'abc-123' }),
      JSON.stringify({
        type: 'user',
        cwd: 'C:\\Users\\dev\\quartz',
        gitBranch: 'feature/planner',
        sessionId: 'abc-123',
        version: '2.0.14',
        isSidechain: false,
        timestamp: '2026-07-20T10:00:00Z',
        message: { role: 'user', content: 'Why is the planner slow?' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'abc-123',
        isSidechain: false,
        timestamp: '2026-07-20T10:01:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'The correlated subquery runs per row.' },
            { type: 'text', text: 'It is the correlated subquery.' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'abc-123',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent chatter' }] },
      }),
    ].join('\n');

    const result = claudeJsonlImporter.parse(source('real.jsonl', real));
    const draft = result.drafts[0]!;

    // The generated title wins over anything inferred from message text.
    expect(draft.title).toBe('Refactor the query planner');
    expect(draft.project).toBe('quartz');
    expect(draft.sourceRef).toBe('abc-123');
    expect(draft.tags).toContain('branch:feature/planner');
    expect(draft.notes).toContain('2.0.14');

    // Thinking is preserved, quoted rather than dropped.
    const assistant = draft.messages!.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toContain('correlated subquery runs per row');
    expect(assistant.content).toContain('It is the correlated subquery.');

    // Sidechains are excluded and reported.
    expect(draft.messages).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('sidechain'))).toBe(true);
    expect(JSON.stringify(draft.messages)).not.toContain('sub-agent chatter');
  });

  it('keeps redacted thinking as a marker rather than a ciphertext blob', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'AAAABBBBCCCC' }] },
    });
    const draft = claudeJsonlImporter.parse(source('r.jsonl', line)).drafts[0]!;
    expect(draft.messages![0]!.content).toContain('redacted');
    expect(draft.messages![0]!.content).not.toContain('AAAABBBB');
  });

  it('handles a transcript with no recognisable messages', () => {
    const result = claudeJsonlImporter.parse(source('empty.jsonl', '{"foo":1}\n{"bar":2}'));
    expect(result.drafts).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------- Markdown */

describe('Markdown importer', () => {
  it('reads front matter', () => {
    const { frontMatter, body } = splitFrontMatter(
      '---\ntitle: "Fix auth"\ntags: [security, backend]\n---\n\n## User\nhello',
    );
    expect(frontMatter.title).toBe('Fix auth');
    expect(frontMatter.tags).toBe('[security, backend]');
    expect(body.startsWith('## User')).toBe(true);
  });

  it('splits on speaker headings', () => {
    const draft = markdownImporter.parse(
      source('t.md', '## User\nWhat broke?\n\n## Assistant\nA stale cache.\n\n## User\nFix it.'),
    ).drafts[0]!;
    expect(draft.messages).toHaveLength(3);
    expect(draft.messages![1]!.role).toBe('assistant');
  });

  it('ignores headings inside code fences', () => {
    const draft = markdownImporter.parse(
      source('t.md', '## User\nSee:\n\n```md\n## Assistant\n```\n\ndone'),
    ).drafts[0]!;
    expect(draft.messages).toHaveLength(1);
    expect(draft.messages![0]!.content).toContain('## Assistant');
  });

  it('falls back to a single note when there is no structure', () => {
    const result = markdownImporter.parse(source('notes.md', 'Just some loose notes about caching.'));
    expect(result.drafts[0]!.messages).toHaveLength(1);
    expect(result.warnings[0]).toContain('single note');
  });
});

/* ------------------------------------------------------------- text */

describe('text importer', () => {
  it('splits on inline speaker prefixes', () => {
    const draft = textImporter.parse(
      source('log.txt', 'User: why is it slow?\nAssistant: the index was missing.'),
    ).drafts[0]!;
    expect(draft.messages).toHaveLength(2);
    expect(draft.messages![1]!.role).toBe('assistant');
  });

  it('always scores lowest so other importers win', () => {
    const s = source('x.jsonl', JSONL);
    expect(textImporter.detect(s)).toBeLessThan(claudeJsonlImporter.detect(s));
  });
});

/* -------------------------------------------------------- detection */

describe('importer registry', () => {
  it('routes each format to the right importer', () => {
    expect(importers.detect(source('a.jsonl', JSONL))?.importer.id).toBe('core:claude-jsonl');
    expect(importers.detect(source('a.md', '---\ntitle: x\n---\n## User\nhi'))?.importer.id).toBe('core:markdown');
    expect(importers.detect(source('a.json', '{"messages":[{"role":"user","content":"hi"}]}'))?.importer.id).toBe('core:json');
    expect(importers.detect(source('a.txt', 'User: hi'))?.importer.id).toBe('core:text');
  });

  it('collects extensions from every registered importer', () => {
    expect(importers.extensions()).toEqual(expect.arrayContaining(['jsonl', 'json', 'md', 'txt']));
  });

  it('survives an importer that throws', () => {
    const registry = new ImporterRegistry();
    registry.register({
      id: 'broken',
      label: 'Broken',
      description: '',
      extensions: ['x'],
      detect: () => {
        throw new Error('boom');
      },
      parse: () => ({ drafts: [], warnings: [] }),
    });
    registry.register(textImporter);
    expect(registry.detect(source('a.txt', 'hello'))?.importer.id).toBe('core:text');
  });

  it('reports a parse failure as a warning rather than throwing', () => {
    const registry = new ImporterRegistry();
    registry.register({
      id: 'explodes',
      label: 'Explodes',
      description: '',
      extensions: ['x'],
      detect: () => 1,
      parse: () => {
        throw new Error('kaboom');
      },
    });
    const result = registry.parse(source('a.x', 'hi'));
    expect(result.drafts).toHaveLength(0);
    expect(result.warnings[0]).toContain('kaboom');
  });
});

/* ---------------------------------------------------------- pipeline */

describe('import pipeline', () => {
  it('imports, then skips the identical file on a second run', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();

    const first = await runImport(storage, { sources: [source('s.jsonl', JSONL)] });
    expect(first.imported).toHaveLength(1);
    expect(first.skipped).toHaveLength(0);

    const second = await runImport(storage, { sources: [source('s.jsonl', JSONL)] });
    expect(second.imported).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
  });

  it('deduplicates within a single batch', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.init();

    const report = await runImport(storage, {
      sources: [source('a.jsonl', JSONL), source('b.jsonl', JSONL)],
    });
    expect(report.imported).toHaveLength(1);
    expect(report.skipped).toHaveLength(1);
  });
});

/* --------------------------------------------------------- exporters */

function sample(): SessionDetail {
  return buildSession(
    {
      title: 'Fix the render loop',
      project: 'artix',
      folder: '/home/dev/artix',
      summary: 'Clamped dt so a backgrounded tab cannot fast-forward the galaxy.',
      notes: 'Remember to check this on a 144Hz display.',
      language: 'typescript',
      source: 'test',
      startedAt: NOW - DAY,
      endedAt: NOW - DAY + 3600_000,
      tags: ['graphics', 'perf'],
      technologies: ['Three.js', 'React'],
      messages: [
        { seq: 0, role: 'user', content: 'The galaxy stutters.', createdAt: NOW - DAY, tokenEstimate: 0, toolName: null },
        { seq: 1, role: 'assistant', content: 'Clamping dt fixes it.\n\n```ts\nconst dt = 0.05;\n```', createdAt: NOW - DAY + 1000, tokenEstimate: 0, toolName: null },
      ],
      artifacts: [
        { kind: 'decision', title: 'Clamp dt', content: 'Clamp dt because a stalled tab yields a huge delta.', language: null, path: null, messageSeq: 1, done: false },
        { kind: 'todo', title: 'Verify on 144Hz', content: 'Verify on 144Hz', language: null, path: null, messageSeq: null, done: false },
        { kind: 'code', title: 'loop.ts', content: 'const dt = Math.min(raw, 0.05);', language: 'typescript', path: 'src/loop.ts', messageSeq: 1, done: false },
      ],
      files: [{ path: 'src/loop.ts', action: 'modified', language: 'typescript', bytes: 120, snippet: null }],
    },
    NOW,
  );
}

describe('exporters', () => {
  const detail = sample();

  it('round-trips Markdown back through the importer', () => {
    const [file] = markdownExporter.render([detail], DEFAULT_EXPORT_OPTIONS);
    const reimported = markdownImporter.parse(source('x.md', file!.content)).drafts[0]!;

    expect(reimported.title).toBe(detail.session.title);
    expect(reimported.project).toBe(detail.session.project);
    expect(reimported.folder).toBe(detail.session.folder);
    expect(reimported.tags).toEqual(detail.session.tags);
    expect(reimported.startedAt).toBe(detail.session.startedAt);
  });

  it('round-trips JSON losslessly', () => {
    const [file] = jsonExporter.render([detail], DEFAULT_EXPORT_OPTIONS);
    const reimported = jsonImporter.parse(source('x.json', file!.content)).drafts[0]!;

    expect(reimported.title).toBe(detail.session.title);
    expect(reimported.notes).toBe(detail.session.notes);
    expect(reimported.messages).toHaveLength(detail.messages.length);
    expect(reimported.artifacts).toHaveLength(detail.artifacts.length);
    expect(reimported.technologies).toEqual(detail.session.technologies);
  });

  it('uses a long-enough fence to survive nested code fences', () => {
    const nested = buildSession(
      {
        title: 'Nested',
        project: 'p',
        source: 'test',
        startedAt: NOW,
        artifacts: [
          { kind: 'code', title: 'doc.md', content: 'Example:\n```ts\nconst a = 1;\n```', language: 'markdown', path: 'doc.md', messageSeq: null, done: false },
        ],
      },
      NOW,
    );
    const [file] = markdownExporter.render([nested], DEFAULT_EXPORT_OPTIONS);
    expect(file!.content).toContain('````');
  });

  it('honours content toggles', () => {
    const [file] = textExporter.render([detail], {
      ...DEFAULT_EXPORT_OPTIONS,
      includeConversation: false,
      includeNotes: false,
    });
    expect(file!.content).not.toContain('CONVERSATION');
    expect(file!.content).not.toContain('144Hz display');
    expect(file!.content).toContain('DECISIONS');
  });

  it('produces safe, unique filenames', () => {
    const files = markdownExporter.render([detail, detail], DEFAULT_EXPORT_OPTIONS);
    expect(files[0]!.path).toMatch(/^[a-z0-9-]+\.md$/);
  });
});

/* ----------------------------------------------------- context bundle */

describe('context bundle', () => {
  const detail = sample();

  it('leads with identity, decisions and open work', () => {
    const bundle = renderContextBundle([detail]);
    expect(bundle).toContain('Fix the render loop');
    expect(bundle).toContain('artix');
    expect(bundle).toContain('Decisions made');
    expect(bundle).toContain('Open items');
    expect(bundle).toContain('src/loop.ts');
  });

  it('tells the reader to re-read files rather than trust snippets', () => {
    expect(renderContextBundle([detail])).toContain('Re-read these');
  });

  it('respects the token budget', () => {
    const many = Array.from({ length: 40 }, () => sample());
    const bundle = renderContextBundle(many, {
      tokenBudget: 1500,
      includePreamble: true,
      conversationTail: 4,
    });
    // Allow one section's overshoot for the always-included identity header.
    expect(estimateTokens(bundle)).toBeLessThan(2200);
  });

  it('still produces something useful at a tiny budget', () => {
    const bundle = renderContextBundle([detail], {
      tokenBudget: 200,
      includePreamble: false,
      conversationTail: 0,
    });
    expect(bundle).toContain('Fix the render loop');
  });

  it('omits completed todos — a briefing is about what is left', () => {
    const done = sample();
    done.artifacts = done.artifacts.map((a) => (a.kind === 'todo' ? { ...a, done: true } : a));
    expect(renderContextBundle([done])).not.toContain('Open items');
  });
});
