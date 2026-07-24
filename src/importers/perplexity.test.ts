import { describe, expect, it } from 'vitest';

import { parsePerplexityThread, perplexityImporter, splitCitations, splitExchanges } from './perplexity.ts';
import { importers } from './registry.ts';
import type { ImportSource } from './types.ts';

function source(name: string, content: string): ImportSource {
  return { reference: `test://${name}`, name, content, modifiedAt: Date.UTC(2026, 0, 1) };
}

const THREAD = `# How does SQLite WAL mode work?

WAL lets readers continue while a writer appends, using React-free plain SQL[1].
Checkpointing folds the log back into the database[2].

## What are the tradeoffs?

The WAL file grows until a checkpoint runs.

## Sources
[1] https://sqlite.org/wal.html Official docs
[2] https://perplexity.ai/thread/abc
`;

describe('Perplexity importer', () => {
  it('only claims files carrying a Perplexity marker', () => {
    expect(perplexityImporter.detect(source('t.md', THREAD))).toBeGreaterThan(0.9);
    // Ordinary Markdown must be left to the Markdown importer.
    const plain = '# Notes\n\nSome writing.\n\n## More\n\ntext';
    expect(perplexityImporter.detect(source('n.md', plain))).toBe(0);
  });

  it('does not hijack a generic Markdown transcript', () => {
    const md = '---\ntitle: Session\n---\n\n## User\nhi\n\n## Assistant\nhello';
    expect(importers.detect(source('s.md', md))?.importer.id).toBe('core:markdown');
  });

  it('turns headings into questions and prose into answers', () => {
    const draft = parsePerplexityThread(source('t.md', THREAD)).drafts[0]!;
    const roles = draft.messages!.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(draft.messages![0]!.content).toContain('WAL mode');
    expect(draft.messages![1]!.content).toContain('readers continue');
  });

  it('keeps the citation list as a searchable note', () => {
    const draft = parsePerplexityThread(source('t.md', THREAD)).drafts[0]!;
    const note = draft.artifacts!.find((a) => a.kind === 'note' && a.title.startsWith('Sources'));
    expect(note).toBeDefined();
    expect(note!.content).toContain('https://sqlite.org/wal.html');
    expect(note!.title).toBe('Sources (2)');
  });

  it('keeps citations out of the answer text', () => {
    const draft = parsePerplexityThread(source('t.md', THREAD)).drafts[0]!;
    const lastAnswer = draft.messages![draft.messages!.length - 1]!.content;
    expect(lastAnswer).not.toContain('https://sqlite.org');
  });

  it('files the thread under a Perplexity project', () => {
    const draft = parsePerplexityThread(source('t.md', THREAD)).drafts[0]!;
    expect(draft.project).toBe('Perplexity');
    expect(draft.title).toContain('SQLite WAL');
  });
});

describe('citation splitting', () => {
  it('peels only a trailing contiguous run', () => {
    const { prose, citations } = splitCitations('Answer [1] inline stays.\n\n[1] https://a\n[2] https://b');
    expect(citations.map((c) => c.url)).toEqual(['https://a', 'https://b']);
    expect(prose).toContain('inline stays');
  });

  it('leaves prose alone when there are no citations', () => {
    const { prose, citations } = splitCitations('Just an answer.');
    expect(citations).toHaveLength(0);
    expect(prose.trim()).toBe('Just an answer.');
  });
});

describe('exchange splitting', () => {
  it('ignores headings inside code fences', () => {
    const exchanges = splitExchanges('# Q\n\n```md\n# not a question\n```\n\nanswer');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.question).toBe('Q');
    expect(exchanges[0]!.answer).toContain('not a question');
  });

  it('treats a document with no headings as one answer', () => {
    const exchanges = splitExchanges('just prose here');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.question).toBe('');
  });
});
