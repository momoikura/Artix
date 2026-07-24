import { describe, expect, it } from 'vitest';

import { commonDirectory, copilotImporter, normalisePath, parseCopilotSession } from './copilot.ts';
import { importers } from './registry.ts';
import type { ImportSource } from './types.ts';

function source(name: string, content: string): ImportSource {
  return { reference: `C:/ws/${name}`, name, content, modifiedAt: Date.UTC(2026, 0, 1) };
}

/** Mirrors the real on-disk shape verified against VS Code's chatSessions. */
const SESSION = JSON.stringify({
  version: 3,
  requesterUsername: 'dev',
  responderUsername: 'GitHub Copilot',
  sessionId: 'sess-1',
  creationDate: 1_700_000_000_000,
  lastMessageDate: 1_700_000_900_000,
  initialLocation: 'panel',
  requests: [
    {
      requestId: 'r1',
      timestamp: 1_700_000_010_000,
      message: { text: 'Why does the login page flicker?', parts: [] },
      response: [
        { value: 'Because the transition runs on mount. Use CSS ', supportThemeIcons: true },
        { kind: 'codeblockUri', uri: { path: '/c:/Users/dev/proj/src/styles.css', scheme: 'file' } },
        { value: 'transitions instead of React state.' },
      ],
      contentReferences: [
        { kind: 'reference', reference: { fsPath: 'c:\\Users\\dev\\proj\\src\\index.html', path: '/c:/Users/dev/proj/src/index.html', scheme: 'file' } },
      ],
    },
    {
      requestId: 'r2',
      timestamp: 1_700_000_900_000,
      message: { text: 'Thanks, that worked.' },
      response: [{ value: 'Glad it helped.' }],
    },
  ],
});

describe('Copilot importer', () => {
  it('detects a Copilot session by its responder', () => {
    expect(copilotImporter.detect(source('a.json', SESSION))).toBe(1);
    expect(copilotImporter.detect(source('a.json', '{"foo":1}'))).toBe(0);
  });

  it('wins detection over the generic JSON importer', () => {
    expect(importers.detect(source('a.json', SESSION))?.importer.id).toBe('core:copilot');
  });

  it('pairs each request into user and assistant messages', () => {
    const draft = parseCopilotSession(source('a.json', SESSION)).drafts[0]!;
    expect(draft.messages!.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(draft.messages![0]!.content).toContain('flicker');
  });

  it('concatenates the response parts into one reply, skipping typed parts', () => {
    const draft = parseCopilotSession(source('a.json', SESSION)).drafts[0]!;
    const reply = draft.messages![1]!.content;
    expect(reply).toBe('Because the transition runs on mount. Use CSS transitions instead of React state.');
    // The codeblockUri part contributes a file reference, not prose.
    expect(reply).not.toContain('styles.css');
  });

  it('records the editor’s own file references', () => {
    const draft = parseCopilotSession(source('a.json', SESSION)).drafts[0]!;
    const paths = draft.files!.map((f) => f.path);
    expect(paths).toContain('c:/Users/dev/proj/src/styles.css');
    expect(paths).toContain('c:/Users/dev/proj/src/index.html');
  });

  it('derives the project from referenced paths, skipping structural dirs', () => {
    const draft = parseCopilotSession(source('a.json', SESSION)).drafts[0]!;
    // Common ancestor is …/proj/src, but `src` is structure, not identity.
    expect(draft.project).toBe('proj');
    expect(draft.folder).toBe('c:/Users/dev/proj/src');
  });

  it('uses the session id so re-imports update in place', () => {
    const draft = parseCopilotSession(source('a.json', SESSION)).drafts[0]!;
    expect(draft.sourceRef).toBe('copilot:sess-1');
    expect(draft.startedAt).toBe(1_700_000_000_000);
  });

  it('skips the empty sessions VS Code leaves behind', () => {
    const empty = JSON.stringify({ sessionId: 's0', responderUsername: 'GitHub Copilot', requests: [] });
    const result = parseCopilotSession(source('empty.json', empty));
    expect(result.drafts).toHaveLength(0);
  });

  it('reports invalid JSON as a warning rather than throwing', () => {
    const result = parseCopilotSession(source('bad.json', '{nope'));
    expect(result.drafts).toHaveLength(0);
    expect(result.warnings[0]).toContain('not valid JSON');
  });
});

describe('path helpers', () => {
  it('normalises VS Code URI paths to a comparable form', () => {
    expect(normalisePath('/c:/Users/dev/a.ts')).toBe('c:/Users/dev/a.ts');
    expect(normalisePath('c:\\Users\\dev\\a.ts')).toBe('c:/Users/dev/a.ts');
    expect(normalisePath('/home/dev/a.ts')).toBe('/home/dev/a.ts');
    expect(normalisePath('/c%3A/Users/dev/a.ts')).toBe('c:/Users/dev/a.ts');
  });

  it('finds the common directory', () => {
    expect(commonDirectory(['c:/p/src/a.ts', 'c:/p/src/b.ts'])).toBe('c:/p/src');
    expect(commonDirectory(['c:/p/a.ts', 'c:/p/sub/b.ts'])).toBe('c:/p');
    expect(commonDirectory([])).toBeNull();
  });

  it('refuses a bare drive root as a project', () => {
    expect(commonDirectory(['c:/a.ts', 'c:/b.ts'])).toBeNull();
  });
});
