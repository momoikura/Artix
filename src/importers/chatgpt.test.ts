import { describe, expect, it } from 'vitest';

import { chatgptImporter, parseChatgptExport } from './chatgpt.ts';
import { importers } from './registry.ts';
import type { ImportSource } from './types.ts';

function source(name: string, content: string): ImportSource {
  return { reference: `test://${name}`, name, content, modifiedAt: Date.UTC(2026, 0, 1) };
}

/** A realistic two-conversation export: tree mapping, hidden system node,
 *  a code block, and a tool message. */
const EXPORT = JSON.stringify([
  {
    title: 'Debugging a race condition',
    create_time: 1_700_000_000,
    update_time: 1_700_000_500,
    conversation_id: 'conv-1',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['sys'] },
      sys: {
        id: 'sys',
        parent: 'root',
        children: ['u1'],
        message: {
          author: { role: 'system' },
          content: { content_type: 'text', parts: [''] },
          metadata: { is_visually_hidden_from_conversation: true },
        },
      },
      u1: {
        id: 'u1',
        parent: 'sys',
        children: ['a1'],
        message: {
          author: { role: 'user' },
          create_time: 1_700_000_010,
          content: { content_type: 'text', parts: ['Why does my worker deadlock?'] },
        },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: ['t1'],
        message: {
          author: { role: 'assistant' },
          create_time: 1_700_000_020,
          content: {
            content_type: 'text',
            parts: ['Two locks taken in opposite orders. Use React and a single mutex.'],
          },
        },
      },
      t1: {
        id: 't1',
        parent: 'a1',
        children: [],
        message: {
          author: { role: 'tool', name: 'python' },
          content: { content_type: 'code', text: 'print("ran")' },
        },
      },
    },
  },
  {
    title: 'Empty one',
    create_time: 1_700_100_000,
    conversation_id: 'conv-2',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: [] },
    },
  },
]);

describe('ChatGPT importer', () => {
  it('detects an export with high confidence', () => {
    expect(chatgptImporter.detect(source('conversations.json', EXPORT))).toBe(1);
    expect(chatgptImporter.detect(source('random.json', '{"foo":1}'))).toBe(0);
  });

  it('wins detection over the generic JSON importer', () => {
    const winner = importers.detect(source('conversations.json', EXPORT));
    expect(winner?.importer.id).toBe('core:chatgpt');
  });

  it('turns each conversation into a session', () => {
    const result = parseChatgptExport(source('conversations.json', EXPORT));
    // The empty conversation is skipped, leaving one real session.
    expect(result.drafts).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('empty'))).toBe(true);

    const draft = result.drafts[0]!;
    expect(draft.title).toBe('Debugging a race condition');
    expect(draft.project).toBe('ChatGPT');
    expect(draft.sourceRef).toBe('chatgpt:conv-1');
    expect(draft.startedAt).toBe(1_700_000_000_000);
  });

  it('linearises the tree in order and drops the hidden system node', () => {
    const draft = parseChatgptExport(source('c.json', EXPORT)).drafts[0]!;
    const roles = draft.messages!.map((m) => m.role);
    // system (hidden) removed; user → assistant → tool preserved in order.
    expect(roles).toEqual(['user', 'assistant', 'tool']);
    expect(draft.messages![0]!.content).toContain('deadlock');
  });

  it('fences code/tool output and keeps the tool name', () => {
    const draft = parseChatgptExport(source('c.json', EXPORT)).drafts[0]!;
    const tool = draft.messages!.find((m) => m.role === 'tool')!;
    expect(tool.content).toContain('```');
    expect(tool.content).toContain('print("ran")');
    expect(tool.toolName).toBe('python');
  });

  it('detects technologies from the conversation', () => {
    const draft = parseChatgptExport(source('c.json', EXPORT)).drafts[0]!;
    expect(draft.technologies).toContain('React');
  });

  it('accepts a single shared conversation object, not just an array', () => {
    const single = JSON.stringify({
      title: 'Solo',
      create_time: 1_700_000_000,
      conversation_id: 'solo-1',
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['u'] },
        u: {
          id: 'u',
          parent: 'root',
          children: [],
          message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } },
        },
      },
    });
    const result = parseChatgptExport(source('shared.json', single));
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.messages).toHaveLength(1);
  });

  it('reports invalid JSON as a warning rather than throwing', () => {
    const result = parseChatgptExport(source('bad.json', '{not json'));
    expect(result.drafts).toHaveLength(0);
    expect(result.warnings[0]).toContain('not valid JSON');
  });

  it('handles multimodal parts by noting non-text content', () => {
    const withImage = JSON.stringify({
      title: 'With image',
      create_time: 1_700_000_000,
      conversation_id: 'img-1',
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['u'] },
        u: {
          id: 'u',
          parent: 'root',
          children: [],
          message: {
            author: { role: 'user' },
            content: {
              content_type: 'multimodal_text',
              parts: [{ content_type: 'image_asset_pointer' }, 'describe this'],
            },
          },
        },
      },
    });
    const draft = parseChatgptExport(source('c.json', withImage)).drafts[0]!;
    expect(draft.messages![0]!.content).toContain('describe this');
    expect(draft.messages![0]!.content).toContain('image_asset_pointer');
  });
});
