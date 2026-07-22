/**
 * Exporter registry and the export pipeline.
 *
 * Mirrors the importer registry: built-ins register through the same call a
 * plugin uses. The pipeline handles the two destinations — a single file, or a
 * ZIP when the exporter is multi-file or several sessions are selected.
 */

import { bus, notify } from '../core/events.ts';
import { newId } from '../core/id.ts';
import { contextBundleExporter, renderContextBundle } from './context-bundle.ts';
import { jsonExporter, textExporter } from './json.ts';
import { markdownExporter } from './markdown.ts';
import { DEFAULT_EXPORT_OPTIONS } from './types.ts';
import type { Exporter, ExportFile, ExportOptions } from './types.ts';
import type { Result } from '../core/result.ts';
import { artixError, err, ok } from '../core/result.ts';
import type { SessionDetail, SessionId } from '../core/types.ts';
import type { StorageAdapter } from '../storage/adapter.ts';

export class ExporterRegistry {
  readonly #exporters = new Map<string, Exporter>();

  register(exporter: Exporter): () => void {
    this.#exporters.set(exporter.id, exporter);
    return () => this.#exporters.delete(exporter.id);
  }

  get(id: string): Exporter | undefined {
    return this.#exporters.get(id);
  }

  list(): Exporter[] {
    return [...this.#exporters.values()];
  }
}

export const exporters = new ExporterRegistry();
exporters.register(markdownExporter);
exporters.register(jsonExporter);
exporters.register(textExporter);
exporters.register(contextBundleExporter);

/* -------------------------------------------------------------- pipeline */

export interface ExportRequest {
  exporterId: string;
  sessionIds: SessionId[];
  /** Destination path. A `.zip` suffix forces archive mode. */
  destination: string;
  options?: Partial<ExportOptions>;
}

export interface ExportReport {
  files: number;
  bytes: number;
  destination: string;
}

/**
 * Load the selected sessions, render them, and write the result.
 *
 * Sessions are fetched one at a time rather than all at once: exporting 50k
 * sessions must not require holding 50k full transcripts in memory.
 */
export async function runExport(
  storage: StorageAdapter,
  request: ExportRequest,
  registry: ExporterRegistry = exporters,
): Promise<Result<ExportReport>> {
  const exporter = registry.get(request.exporterId);
  if (!exporter) {
    return err(artixError('invalid-input', `Unknown exporter: ${request.exporterId}`));
  }
  if (request.sessionIds.length === 0) {
    return err(artixError('invalid-input', 'Select at least one session to export.'));
  }

  const jobId = newId();
  const options: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...request.options };

  const details: SessionDetail[] = [];
  for (const [index, id] of request.sessionIds.entries()) {
    bus.emit('job:progress', {
      jobId,
      label: 'Preparing export',
      done: index + 1,
      total: request.sessionIds.length,
    });
    const detail = await storage.getSession(id);
    if (detail.ok) details.push(detail.value);
  }

  if (details.length === 0) {
    return err(artixError('not-found', 'None of the selected sessions could be loaded.'));
  }

  let files: ExportFile[];
  try {
    files = exporter.render(details, options);
  } catch (e) {
    return err(
      artixError('unknown', `${exporter.label} failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  const asZip = request.destination.toLowerCase().endsWith('.zip') || files.length > 1;
  const bytes = files.reduce((sum, file) => sum + file.content.length, 0);

  const written = asZip
    ? await storage.writeZip(
        request.destination,
        files.map((file) => [file.path, file.content] as [string, string]),
      )
    : await storage.writeTextFile(request.destination, files[0]!.content);

  if (!written.ok) return err(written.error);

  const report: ExportReport = {
    files: files.length,
    bytes,
    destination: request.destination,
  };

  bus.emit('job:finished', {
    jobId,
    ok: true,
    message: `Exported ${files.length} file${files.length === 1 ? '' : 's'}`,
  });

  return ok(report);
}

/**
 * Render a context bundle and put it on the clipboard.
 *
 * The single most-used action in Artix: pick a session, copy, paste into a new
 * Claude Code session, keep working.
 */
export async function copyContextBundle(
  storage: StorageAdapter,
  sessionIds: readonly SessionId[],
): Promise<Result<string>> {
  const details: SessionDetail[] = [];
  for (const id of sessionIds) {
    const detail = await storage.getSession(id);
    if (detail.ok) details.push(detail.value);
  }

  if (details.length === 0) {
    return err(artixError('not-found', 'Nothing to copy.'));
  }

  const bundle = renderContextBundle(details);

  try {
    await navigator.clipboard.writeText(bundle);
    notify('success', 'Context bundle copied — paste it into a new Claude Code session.');
    return ok(bundle);
  } catch (e) {
    // Clipboard permission can be denied; the caller can still show the text.
    return err(
      artixError('unsupported', 'Could not access the clipboard.', {
        hint: 'The bundle is still available to save as a file.',
        detail: e,
      }),
    );
  }
}
