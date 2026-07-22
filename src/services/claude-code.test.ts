import { describe, expect, it } from 'vitest';

import { decodeProjectDir, describeScan, projectHintFromDir } from './claude-code.ts';
import type { DiscoveredSession } from './claude-code.ts';

describe('Claude Code project directory decoding', () => {
  it('reverses the Windows encoding', () => {
    expect(decodeProjectDir('C--Users-dev-Projects-Artix')).toBe(
      'C:\\Users\\dev\\Projects\\Artix',
    );
  });

  it('reverses a POSIX encoding', () => {
    expect(decodeProjectDir('-home-dev-projects-artix')).toBe('/home/dev/projects/artix');
  });

  it('extracts a readable project label', () => {
    expect(projectHintFromDir('C--Users-dev-Projects-Artix')).toBe('Artix');
    expect(projectHintFromDir('-home-dev-artix')).toBe('artix');
  });

  /**
   * The encoding is lossy: `:` and the separator both become `-`, so a folder
   * whose real name contains a hyphen cannot be recovered. This documents the
   * limitation rather than pretending it round-trips — the importer relies on
   * the `cwd` field inside the transcript instead.
   */
  it('is ambiguous for hyphenated folder names, hence cwd is authoritative', () => {
    const decoded = decodeProjectDir('C--Users-me-Desktop-game-ni-mark');
    expect(decoded).toBe('C:\\Users\\me\\Desktop\\game\\ni\\mark');
    // The true folder was `game-ni-mark`; the hint is wrong, which is exactly
    // why it is only ever a fallback.
    expect(projectHintFromDir('C--Users-me-Desktop-game-ni-mark')).toBe('mark');
  });
});

describe('scan description', () => {
  const session = (project: string, bytes: number): DiscoveredSession => ({
    path: `/x/${project}/a.jsonl`,
    id: 'a',
    projectHint: project,
    bytes,
    modifiedAt: 0,
  });

  it('summarises count, projects and size', () => {
    const text = describeScan([
      session('artix', 1_048_576),
      session('artix', 1_048_576),
      session('orbital', 2_097_152),
    ]);
    expect(text).toContain('3 transcripts');
    expect(text).toContain('2 projects');
    expect(text).toContain('4.0 MB');
  });

  it('uses singular forms for one of each', () => {
    expect(describeScan([session('artix', 1024)])).toContain('1 transcript across 1 project');
  });

  it('handles an empty scan', () => {
    expect(describeScan([])).toBe('No Claude Code transcripts found.');
  });
});
