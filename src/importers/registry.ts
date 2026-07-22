/**
 * Importer registry and the import pipeline.
 *
 * The registry is what makes "no hardcoded providers" real: built-in importers
 * register through exactly the same call a plugin uses, and detection is a
 * pure ranking over whatever is registered.
 */

import { bus } from '../core/events.ts';
import { buildSession, computeSessionHash } from '../core/session.ts';
import { newId } from '../core/id.ts';
import { claudeJsonlImporter } from './claude-jsonl.ts';
import { jsonImporter } from './json.ts';
import { markdownImporter } from './markdown.ts';
import { textImporter } from './text.ts';
import type { Importer, ImportSource } from './types.ts';
import type { SessionDetail, SessionDraft } from '../core/types.ts';
import type { StorageAdapter } from '../storage/adapter.ts';
import type { ImportOutcome } from '../storage/adapter.ts';

export class ImporterRegistry {
  readonly #importers = new Map<string, Importer>();

  register(importer: Importer): () => void {
    this.#importers.set(importer.id, importer);
    return () => this.#importers.delete(importer.id);
  }

  get(id: string): Importer | undefined {
    return this.#importers.get(id);
  }

  list(): Importer[] {
    return [...this.#importers.values()];
  }

  /** Every extension any registered importer claims — drives the file dialog. */
  extensions(): string[] {
    const out = new Set<string>();
    for (const importer of this.#importers.values()) {
      for (const extension of importer.extensions) out.add(extension);
    }
    return [...out].sort();
  }

  /** Highest-confidence importer for a source, or null when nothing scores. */
  detect(source: ImportSource): { importer: Importer; score: number } | null {
    let best: { importer: Importer; score: number } | null = null;

    for (const importer of this.#importers.values()) {
      let score = 0;
      try {
        score = importer.detect(source);
      } catch (e) {
        // A broken third-party importer must not break detection for the rest.
        console.warn(`[artix] importer ${importer.id} threw during detect`, e);
        continue;
      }
      if (score <= 0) continue;
      if (best === null || score > best.score) best = { importer, score };
    }

    return best;
  }

  /** Parse one source with the best-matching importer. */
  parse(source: ImportSource, forceImporterId?: string): {
    drafts: SessionDraft[];
    warnings: string[];
    importerId: string | null;
  } {
    const importer = forceImporterId
      ? this.#importers.get(forceImporterId)
      : this.detect(source)?.importer;

    if (!importer) {
      return { drafts: [], warnings: [`No importer recognised ${source.name}.`], importerId: null };
    }

    try {
      const result = importer.parse(source);
      return { ...result, importerId: importer.id };
    } catch (e) {
      return {
        drafts: [],
        warnings: [
          `${importer.label} failed on ${source.name}: ${e instanceof Error ? e.message : String(e)}`,
        ],
        importerId: importer.id,
      };
    }
  }
}

/** The default registry, pre-loaded with the built-in importers. */
export const importers = new ImporterRegistry();
importers.register(claudeJsonlImporter);
importers.register(jsonImporter);
importers.register(markdownImporter);
importers.register(textImporter);

/* ------------------------------------------------------------- the pipeline */

export interface ImportRequest {
  sources: ImportSource[];
  /** Force one importer instead of auto-detecting. */
  importerId?: string;
  /** Skip sources whose content hash is already stored. Default true. */
  skipDuplicates?: boolean;
}

export interface ImportReport extends ImportOutcome {
  /** Sources whose hash matched something already in the library. */
  skipped: string[];
  warnings: string[];
  elapsedMs: number;
}

/**
 * Parse, deduplicate and store a batch of sources.
 *
 * Deduplication happens *before* the write so a re-import of 5000 files costs
 * one hash lookup each rather than 5000 failed inserts. Progress is emitted on
 * the event bus so any part of the UI can show it.
 */
export async function runImport(
  storage: StorageAdapter,
  request: ImportRequest,
  registry: ImporterRegistry = importers,
): Promise<ImportReport> {
  const started = performance.now();
  const jobId = newId();
  const skipDuplicates = request.skipDuplicates ?? true;

  const warnings: string[] = [];
  const skipped: string[] = [];
  const details: SessionDetail[] = [];

  const knownResult = skipDuplicates ? await storage.knownHashes() : null;
  const known = knownResult?.ok ? knownResult.value : new Set<string>();
  // Sources within one batch can duplicate each other too.
  const seenInBatch = new Set<string>();

  const total = request.sources.length;
  let processed = 0;

  for (const source of request.sources) {
    processed++;
    bus.emit('job:progress', {
      jobId,
      label: `Importing ${source.name}`,
      done: processed,
      total,
    });

    const parsed = registry.parse(source, request.importerId);
    warnings.push(...parsed.warnings);

    for (const draft of parsed.drafts) {
      const hash = computeSessionHash(draft, draft.messages ?? []);
      if (known.has(hash) || seenInBatch.has(hash)) {
        skipped.push(source.reference);
        continue;
      }
      seenInBatch.add(hash);
      details.push(buildSession(draft));
    }

    // Yield to the event loop periodically so a big import cannot freeze the UI.
    if (processed % 25 === 0) await Promise.resolve();
  }

  let outcome: ImportOutcome = { imported: [], duplicates: [], failed: [] };
  if (details.length > 0) {
    const saved = await storage.saveSessions(details);
    if (saved.ok) {
      outcome = saved.value;
    } else {
      warnings.push(saved.error.message);
      outcome.failed.push({ reference: 'storage', message: saved.error.message });
    }
  }

  const report: ImportReport = {
    ...outcome,
    skipped,
    warnings,
    elapsedMs: performance.now() - started,
  };

  bus.emit('job:finished', {
    jobId,
    ok: report.failed.length === 0,
    message: describeReport(report),
  });

  if (report.imported.length > 0) {
    bus.emit('library:changed', { reason: 'import', ids: report.imported });
  }

  return report;
}

export function describeReport(report: ImportReport): string {
  const parts: string[] = [];
  parts.push(`${report.imported.length} imported`);
  const duplicates = report.duplicates.length + report.skipped.length;
  if (duplicates > 0) parts.push(`${duplicates} already in library`);
  if (report.failed.length > 0) parts.push(`${report.failed.length} failed`);
  return parts.join(' · ');
}
