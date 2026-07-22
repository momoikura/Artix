/**
 * Language registry.
 *
 * One place decides: the canonical id for a language, the colour its stars
 * burn in the galaxy, and which file extensions map to it. The renderer reads
 * `colorRGB` directly into a Float32 attribute, so colours live here as linear
 * floats *and* as CSS hex for the DOM.
 *
 * Colours are chosen to read as real stellar classes rather than a rainbow:
 * blue-white through amber, with saturation kept low enough that a dense
 * cluster still looks like a galaxy and not a bag of Skittles.
 */

export interface LanguageSpec {
  /** Canonical lowercase id. Stored in `sessions.language`. */
  id: string;
  label: string;
  /** CSS hex, sRGB. */
  hex: string;
  /** Linear-ish RGB triplet in 0..1, uploaded to the GPU. */
  rgb: readonly [number, number, number];
  extensions: readonly string[];
  /** Alternate spellings importers may emit. */
  aliases: readonly string[];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function lang(
  id: string,
  label: string,
  hex: string,
  extensions: readonly string[],
  aliases: readonly string[] = [],
): LanguageSpec {
  return { id, label, hex, rgb: hexToRgb(hex), extensions, aliases };
}

export const LANGUAGES: readonly LanguageSpec[] = [
  lang('typescript', 'TypeScript', '#5AA9FF', ['.ts', '.tsx', '.mts', '.cts'], ['ts', 'tsx']),
  lang('javascript', 'JavaScript', '#F2C55C', ['.js', '.jsx', '.mjs', '.cjs'], ['js', 'node']),
  lang('python', 'Python', '#5FD68A', ['.py', '.pyi', '.ipynb'], ['py', 'python3']),
  lang('rust', 'Rust', '#B98BFF', ['.rs'], ['rs']),
  lang('go', 'Go', '#FF9E57', ['.go'], ['golang']),
  lang('java', 'Java', '#E0705A', ['.java'], []),
  lang('kotlin', 'Kotlin', '#C78BFF', ['.kt', '.kts'], []),
  lang('swift', 'Swift', '#FF8A6B', ['.swift'], []),
  lang('csharp', 'C#', '#8FD3B0', ['.cs'], ['c#', 'dotnet', 'net']),
  lang('cpp', 'C++', '#7FB4FF', ['.cpp', '.cc', '.cxx', '.hpp', '.hh'], ['c++', 'cplusplus']),
  lang('c', 'C', '#9FB8D8', ['.c', '.h'], []),
  lang('ruby', 'Ruby', '#FF7A8A', ['.rb', '.erb'], ['rb']),
  lang('php', 'PHP', '#A99BFF', ['.php'], []),
  lang('sql', 'SQL', '#6FD0D6', ['.sql'], ['postgres', 'postgresql', 'mysql', 'sqlite']),
  lang('shell', 'Shell', '#B7C4CF', ['.sh', '.bash', '.zsh', '.ps1'], ['bash', 'zsh', 'powershell']),
  lang('html', 'HTML', '#FFA07A', ['.html', '.htm'], []),
  lang('css', 'CSS', '#79C0FF', ['.css', '.scss', '.sass', '.less'], ['scss', 'sass', 'tailwind']),
  lang('markdown', 'Markdown', '#A8B2C0', ['.md', '.mdx'], ['md']),
  lang('json', 'JSON', '#C9D4E0', ['.json', '.jsonc'], []),
  lang('yaml', 'YAML', '#9AC7B8', ['.yml', '.yaml'], ['yml']),
  lang('toml', 'TOML', '#C4B49A', ['.toml'], []),
  lang('dart', 'Dart', '#66C9E0', ['.dart'], ['flutter']),
  lang('elixir', 'Elixir', '#B39DDB', ['.ex', '.exs'], []),
  lang('haskell', 'Haskell', '#9E86D6', ['.hs'], []),
  lang('lua', 'Lua', '#7F9CFF', ['.lua'], []),
  lang('zig', 'Zig', '#FFB067', ['.zig'], []),
  lang('scala', 'Scala', '#E0736B', ['.scala'], []),
  lang('r', 'R', '#8FB8E8', ['.r'], []),
  lang('docker', 'Docker', '#74B9E8', ['dockerfile', '.dockerfile'], ['dockerfile']),
  lang('terraform', 'Terraform', '#B4A0FF', ['.tf', '.tfvars'], ['hcl']),
];

/** Fallback for anything unrecognised — a dim, neutral white dwarf. */
export const UNKNOWN_LANGUAGE: LanguageSpec = {
  id: 'unknown',
  label: 'Unknown',
  hex: '#8B96A8',
  rgb: hexToRgb('#8B96A8'),
  extensions: [],
  aliases: [],
};

const BY_ID = new Map<string, LanguageSpec>();
const BY_EXT = new Map<string, LanguageSpec>();

for (const spec of LANGUAGES) {
  BY_ID.set(spec.id, spec);
  for (const alias of spec.aliases) BY_ID.set(alias, spec);
  BY_ID.set(spec.label.toLowerCase(), spec);
  for (const ext of spec.extensions) BY_EXT.set(ext.toLowerCase(), spec);
}

/** Resolve any user/importer-supplied language string to a known spec. */
export function resolveLanguage(name: string | null | undefined): LanguageSpec {
  if (!name) return UNKNOWN_LANGUAGE;
  return BY_ID.get(name.trim().toLowerCase()) ?? UNKNOWN_LANGUAGE;
}

/** Canonical id, or null when unrecognised (so we never persist "unknown"). */
export function canonicalLanguageId(name: string | null | undefined): string | null {
  const spec = resolveLanguage(name);
  return spec === UNKNOWN_LANGUAGE ? null : spec.id;
}

/** Infer a language from a file path. Handles extensionless Dockerfiles. */
export function languageFromPath(path: string): LanguageSpec {
  const file = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const lower = file.toLowerCase();

  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return BY_ID.get('docker')!;
  if (lower === 'makefile') return BY_ID.get('shell')!;

  const dot = lower.lastIndexOf('.');
  if (dot < 0) return UNKNOWN_LANGUAGE;
  return BY_EXT.get(lower.slice(dot)) ?? UNKNOWN_LANGUAGE;
}

export function languageColor(name: string | null | undefined): string {
  return resolveLanguage(name).hex;
}

export function languageRgb(name: string | null | undefined): readonly [number, number, number] {
  return resolveLanguage(name).rgb;
}

/**
 * Pick the dominant language for a set of files by weighted count. Ties break
 * on registry order so the result is deterministic.
 */
export function dominantLanguage(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const counts = new Map<string, number>();
  for (const p of paths) {
    const spec = languageFromPath(p);
    if (spec === UNKNOWN_LANGUAGE) continue;
    counts.set(spec.id, (counts.get(spec.id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const spec of LANGUAGES) {
    const c = counts.get(spec.id) ?? 0;
    if (c > bestCount) {
      best = spec.id;
      bestCount = c;
    }
  }
  return best;
}
