/**
 * The preservation guarantee is the part that must never regress: getting it
 * wrong silently destroys the user's own CLAUDE.md.
 */

import { describe, expect, it } from 'vitest';

import { spliceManagedBlock } from './resume.ts';

const BEGIN = '<!-- artix:begin -->';
const END = '<!-- artix:end -->';
const BLOCK = `${BEGIN}\nfresh context\n${END}`;

describe('managed CLAUDE.md block', () => {
  it('creates the file content when nothing exists', () => {
    const result = spliceManagedBlock('', BLOCK);
    expect(result.content.trim()).toBe(BLOCK);
    expect(result.replaced).toBe(false);
    expect(result.preservedExisting).toBe(false);
  });

  it('appends below hand-written content without touching it', () => {
    const mine = '# My project\n\nAlways run the linter before committing.';
    const result = spliceManagedBlock(mine, BLOCK);

    expect(result.content).toContain(mine);
    expect(result.content.indexOf(mine)).toBeLessThan(result.content.indexOf(BEGIN));
    expect(result.replaced).toBe(false);
    expect(result.preservedExisting).toBe(true);
  });

  it('replaces a previous block rather than appending a second one', () => {
    const existing = `# Mine\n\n${BEGIN}\nSTALE CONTEXT\n${END}\n\n## Notes below\nkeep me`;
    const result = spliceManagedBlock(existing, BLOCK);

    expect(result.content).not.toContain('STALE CONTEXT');
    expect(result.content).toContain('fresh context');
    expect(result.content).toContain('# Mine');
    expect(result.content).toContain('keep me');
    expect(result.replaced).toBe(true);
    expect(result.preservedExisting).toBe(true);

    // Exactly one managed block, no matter how many times it runs.
    expect(result.content.split(BEGIN)).toHaveLength(2);
    expect(result.content.split(END)).toHaveLength(2);
  });

  it('is idempotent across repeated runs', () => {
    const once = spliceManagedBlock('# Mine\n\nrule one', BLOCK);
    const twice = spliceManagedBlock(once.content, BLOCK);
    const thrice = spliceManagedBlock(twice.content, BLOCK);

    expect(thrice.content).toBe(twice.content);
    expect(thrice.content.split(BEGIN)).toHaveLength(2);
    expect(thrice.content).toContain('rule one');
  });

  it('preserves content written after the block', () => {
    const existing = `${BEGIN}\nold\n${END}\n\n## Appendix\nimportant tail`;
    const result = spliceManagedBlock(existing, BLOCK);
    expect(result.content).toContain('important tail');
    expect(result.content).toContain('## Appendix');
  });

  it('does not let the file grow without bound', () => {
    let content = '# Mine\n';
    for (let i = 0; i < 20; i++) {
      content = spliceManagedBlock(content, BLOCK).content;
    }
    expect(content.split(BEGIN)).toHaveLength(2);
    expect(content.length).toBeLessThan(BLOCK.length + 200);
  });

  it('leaves a stray unterminated marker alone rather than corrupting the file', () => {
    // An END with no BEGIN must not be treated as a block boundary.
    const damaged = `# Mine\n\n${END}\n\ntail`;
    const result = spliceManagedBlock(damaged, BLOCK);
    expect(result.content).toContain('tail');
    expect(result.content).toContain('# Mine');
    expect(result.replaced).toBe(false);
  });
});
