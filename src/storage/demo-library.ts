/**
 * Deterministic demo library.
 *
 * Artix is useless-looking when empty, and an empty galaxy is a terrible first
 * impression. This generator produces a plausible archive so the app can be
 * explored, benchmarked and screenshotted before importing anything real.
 *
 * Every value derives from a seeded hash, so the same seed always yields the
 * same galaxy — which also makes it usable as a rendering benchmark fixture.
 */

import { rand01, randRange } from '../core/hash.ts';
import { buildSession } from '../core/session.ts';
import { DAY } from '../core/time.ts';
import type { SessionDetail, SessionDraft, SessionStatus } from '../core/types.ts';

interface ProjectSpec {
  name: string;
  folder: string;
  language: string;
  technologies: string[];
  tags: string[];
  /** Relative likelihood of a session belonging to this project. */
  weight: number;
}

const PROJECTS: readonly ProjectSpec[] = [
  { name: 'artix', folder: '~/dev/artix', language: 'typescript', technologies: ['React', 'Tauri', 'SQLite', 'Three.js', 'Vite'], tags: ['desktop', 'search', 'graphics'], weight: 10 },
  { name: 'orbital-api', folder: '~/dev/orbital-api', language: 'rust', technologies: ['REST', 'PostgreSQL', 'Docker'], tags: ['backend', 'api'], weight: 8 },
  { name: 'atlas-web', folder: '~/dev/atlas-web', language: 'typescript', technologies: ['Next.js', 'React', 'Tailwind', 'tRPC'], tags: ['frontend', 'web'], weight: 9 },
  { name: 'ledger-core', folder: '~/dev/ledger-core', language: 'go', technologies: ['REST', 'Redis', 'Kubernetes'], tags: ['backend', 'fintech'], weight: 6 },
  { name: 'signal-ml', folder: '~/dev/signal-ml', language: 'python', technologies: ['PyTorch', 'FastAPI', 'Docker'], tags: ['ml', 'research'], weight: 7 },
  { name: 'pipeline-ops', folder: '~/dev/pipeline-ops', language: 'shell', technologies: ['CI/CD', 'Docker', 'Terraform', 'AWS'], tags: ['infra', 'devops'], weight: 5 },
  { name: 'lumen-mobile', folder: '~/dev/lumen-mobile', language: 'swift', technologies: ['GraphQL', 'REST'], tags: ['mobile', 'ios'], weight: 4 },
  { name: 'quartz-db', folder: '~/dev/quartz-db', language: 'cpp', technologies: ['SQLite'], tags: ['database', 'performance'], weight: 3 },
  { name: 'harbor-cli', folder: '~/dev/harbor-cli', language: 'rust', technologies: ['Docker'], tags: ['cli', 'tooling'], weight: 5 },
  { name: 'meridian-docs', folder: '~/dev/meridian-docs', language: 'markdown', technologies: ['Vite'], tags: ['docs', 'writing'], weight: 3 },
  { name: 'scratch', folder: '~/dev/scratch', language: 'javascript', technologies: [], tags: ['experiment'], weight: 6 },
];

const TASK_VERBS = [
  'Refactor', 'Debug', 'Implement', 'Optimise', 'Migrate', 'Design', 'Fix',
  'Add tests for', 'Document', 'Profile', 'Harden', 'Rewrite', 'Investigate',
];

const TASK_SUBJECTS = [
  'the authentication flow', 'the search index', 'the render loop', 'connection pooling',
  'the migration runner', 'the settings panel', 'error handling', 'the retry logic',
  'the CI pipeline', 'the caching layer', 'the plugin loader', 'websocket reconnection',
  'the import pipeline', 'pagination', 'the query planner', 'startup time',
  'the export format', 'memory usage in the worker', 'the keyboard shortcuts',
  'rate limiting', 'the diff algorithm', 'schema validation',
];

const FILE_STEMS = [
  'index', 'server', 'client', 'router', 'store', 'engine', 'parser', 'renderer',
  'worker', 'config', 'utils', 'schema', 'migrations', 'handlers', 'models', 'cache',
];

const EXT_BY_LANGUAGE: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  rust: 'rs',
  go: 'go',
  swift: 'swift',
  cpp: 'cpp',
  shell: 'sh',
  markdown: 'md',
};

const STATUSES: readonly SessionStatus[] = ['completed', 'completed', 'completed', 'active', 'paused', 'archived'];

function pick<T>(items: readonly T[], key: string, channel: number): T {
  return items[Math.floor(rand01(key, channel) * items.length) % items.length]!;
}

/** Weighted project choice, so the galaxy has genuinely dense and sparse arms. */
function pickProject(key: string): ProjectSpec {
  const total = PROJECTS.reduce((sum, p) => sum + p.weight, 0);
  let target = rand01(key, 1) * total;
  for (const project of PROJECTS) {
    target -= project.weight;
    if (target <= 0) return project;
  }
  return PROJECTS[0]!;
}

export interface DemoOptions {
  count?: number;
  seed?: string;
  /** End of the generated time range. Defaults to now. */
  now?: number;
  /** How far back sessions extend, in days. */
  spanDays?: number;
  /** Generate message bodies. Off for large benchmark libraries. */
  withMessages?: boolean;
}

/**
 * Generate `count` sessions. At 100k with `withMessages: false` this runs in
 * well under a second and produces the galaxy the performance target refers to.
 */
export function generateDemoLibrary(options: DemoOptions = {}): SessionDetail[] {
  const count = options.count ?? 240;
  const seed = options.seed ?? 'artix-demo';
  const now = options.now ?? Date.now();
  const spanDays = options.spanDays ?? 730;
  const withMessages = options.withMessages ?? true;

  const out: SessionDetail[] = [];

  for (let i = 0; i < count; i++) {
    const key = `${seed}:${i}`;
    const project = pickProject(key);

    // Age is skewed towards recent work: real archives are front-loaded.
    const skew = Math.pow(rand01(key, 2), 2.1);
    const startedAt = Math.round(now - skew * spanDays * DAY);
    const durationMs = Math.round(randRange(key, 3, 4, 190) * 60_000);

    const verb = pick(TASK_VERBS, key, 4);
    const subject = pick(TASK_SUBJECTS, key, 5);
    const title = `${verb} ${subject}`;

    const status = pick(STATUSES, key, 6);
    const messageCount = withMessages ? Math.round(randRange(key, 7, 4, 60)) : 0;
    const fileCount = Math.round(randRange(key, 8, 1, 14));

    const ext = EXT_BY_LANGUAGE[project.language] ?? 'txt';
    const files = Array.from({ length: fileCount }, (_, f) => {
      const stem = pick(FILE_STEMS, `${key}:${f}`, 9);
      const dir = rand01(`${key}:${f}`, 10) > 0.5 ? 'src' : 'src/lib';
      return {
        path: `${dir}/${stem}.${ext}`,
        action: rand01(`${key}:${f}`, 11) > 0.4 ? ('modified' as const) : ('created' as const),
        language: project.language,
        bytes: Math.round(randRange(`${key}:${f}`, 12, 400, 24_000)),
        snippet: null,
      };
    });

    const draft: SessionDraft = {
      title,
      project: project.name,
      folder: project.folder,
      summary: `${verb} ${subject} in ${project.name}. ${describeOutcome(key)}`,
      notes: '',
      language: project.language,
      status,
      source: 'demo:generator',
      sourceRef: `demo://${seed}/${i}`,
      startedAt,
      endedAt: startedAt + durationMs,
      tags: [...project.tags, ...(rand01(key, 13) > 0.7 ? ['needs-followup'] : [])],
      technologies: project.technologies,
      pinned: rand01(key, 14) > 0.965,
      messages: withMessages ? buildMessages(key, title, project, messageCount, startedAt) : [],
      files: dedupeByPath(files),
      artifacts: buildArtifacts(key, project, subject),
    };

    out.push(buildSession(draft, startedAt));
  }

  return out;
}

function describeOutcome(key: string): string {
  const outcomes = [
    'Root cause was a stale cache entry; added an invalidation hook and a regression test.',
    'Split the module in two and moved the hot path behind a typed interface.',
    'Reduced p95 latency by about 40% by batching the writes.',
    'Turned out to be a config drift between environments. Documented the fix.',
    'Left a TODO for the streaming case — not needed yet.',
    'Replaced the hand-rolled parser with a small state machine.',
    'Added indexes and rewrote the query to avoid the correlated subquery.',
  ];
  return pick(outcomes, key, 20);
}

function buildMessages(
  key: string,
  title: string,
  project: ProjectSpec,
  count: number,
  startedAt: number,
) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? ('user' as const) : ('assistant' as const);
    const content =
      i === 0
        ? `${title} in ${project.name}. The current implementation is hard to follow and I want to understand the tradeoffs before changing it.`
        : role === 'user'
          ? pick(
              [
                'Can you show me where that is handled?',
                'What happens if the input is empty?',
                'Let’s go with that approach.',
                'That broke the tests — can you check the fixture?',
                'Add a comment explaining why.',
              ],
              `${key}:${i}`,
              21,
            )
          : `Here is what I found. ${describeOutcome(`${key}:${i}`)}\n\n\`\`\`${project.language}\n// ${project.name}\nexport function handle(input) {\n  return input;\n}\n\`\`\``;

    messages.push({
      seq: i,
      role,
      content,
      createdAt: startedAt + i * 45_000,
      tokenEstimate: 0,
      toolName: null,
    });
  }
  return messages;
}

function buildArtifacts(key: string, project: ProjectSpec, subject: string) {
  const artifacts = [];

  artifacts.push({
    kind: 'decision' as const,
    title: `Chose the simpler path for ${subject}`,
    language: null,
    content: describeOutcome(`${key}:decision`),
    path: null,
    messageSeq: 1,
    done: false,
  });

  if (rand01(key, 22) > 0.4) {
    artifacts.push({
      kind: 'todo' as const,
      title: `Follow up on ${subject}`,
      language: null,
      content: `Follow up on ${subject} once the migration lands.`,
      path: null,
      messageSeq: null,
      done: rand01(key, 23) > 0.6,
    });
  }

  if (rand01(key, 24) > 0.55) {
    artifacts.push({
      kind: 'architecture' as const,
      title: `${project.name} module layout`,
      language: null,
      content: `${project.name}\n  src/\n    engine/   core logic\n    store/    persistence\n    ui/       presentation`,
      path: null,
      messageSeq: null,
      done: false,
    });
  }

  return artifacts;
}

function dedupeByPath<T extends { path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}
