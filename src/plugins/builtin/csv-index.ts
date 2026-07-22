/**
 * Built-in example plugin: CSV index exporter.
 *
 * Small on purpose. Its job is to prove — and document by example — that the
 * plugin API is sufficient to add real functionality without touching the core.
 * Every built-in feature could have been written this way; this one actually is.
 */

import type { ArtixPlugin, ArtixPluginApi } from '../api.ts';
import type { ExportFile } from '../../exporters/types.ts';
import type { SessionDetail } from '../../core/types.ts';

/** RFC 4180 quoting: wrap in quotes, double any internal quote. */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const COLUMNS = [
  'id',
  'title',
  'project',
  'folder',
  'language',
  'status',
  'started_at',
  'ended_at',
  'messages',
  'files',
  'artifacts',
  'tokens',
  'tags',
  'technologies',
] as const;

function render(sessions: readonly SessionDetail[]): ExportFile[] {
  const rows: string[] = [COLUMNS.join(',')];

  for (const { session } of sessions) {
    rows.push(
      [
        session.id,
        session.title,
        session.project,
        session.folder,
        session.language,
        session.status,
        new Date(session.startedAt).toISOString(),
        session.endedAt ? new Date(session.endedAt).toISOString() : null,
        session.messageCount,
        session.fileCount,
        session.artifactCount,
        session.tokenEstimate,
        session.tags.join(' '),
        session.technologies.join(' '),
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return [{ path: 'artix-index.csv', content: rows.join('\n') }];
}

export const csvIndexPlugin: ArtixPlugin = {
  id: 'builtin.csv-index',
  name: 'CSV index',
  description: 'Adds a spreadsheet-friendly CSV export of session metadata.',
  version: '1.0.0',
  requires: '>=0.1.0',

  activate(api: ArtixPluginApi) {
    api.contributeExporter({
      id: `${api.pluginId}:csv`,
      label: 'CSV index',
      description: 'One row per session. Metadata only — no transcripts.',
      extension: 'csv',
      multiFile: false,
      render,
    });

    api.log.info('CSV exporter registered');
  },
};
