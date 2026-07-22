/**
 * First-run state.
 *
 * An empty galaxy is indistinguishable from a broken one, so the empty state
 * has to explain what Artix expects and give one obvious next action. It also
 * states the offline guarantee plainly — that is the product's premise, and
 * first launch is when it matters most.
 */

import { commands } from '../commands/registry.ts';
import { generateDemoLibrary } from '../storage/demo-library.ts';
import { getApp } from '../state/app.ts';
import { bus, notify } from '../core/events.ts';
import { useUi } from '../state/ui-store.ts';
import './EmptyLibrary.css';

export function EmptyLibrary(): JSX.Element {
  const context = { selectedIds: [], inSession: false, inSearch: false };

  return (
    <div className="empty">
      <div className="empty__panel panel">
        <div className="empty__mark" aria-hidden="true" />

        <h1 className="empty__title">Your galaxy is empty</h1>
        <p className="empty__lede">
          Artix turns past development sessions into a searchable archive you can navigate
          spatially. Import a transcript to place your first star.
        </p>

        <div className="empty__actions">
          <button
            className="btn btn--primary"
            onClick={() => void commands.run('artix.importClaudeCode', context)}
          >
            Import from Claude Code
          </button>
          <button className="btn" onClick={() => void commands.run('artix.import', context)}>
            Import files…
          </button>
          <button className="btn" onClick={() => void commands.run('artix.importFolder', context)}>
            Scan a folder…
          </button>
          <button className="btn btn--ghost" onClick={loadDemo}>
            Load a demo galaxy
          </button>
        </div>

        <dl className="empty__formats">
          <div>
            <dt>Supported</dt>
            <dd>JSONL transcripts · JSON exports · Markdown · plain text · ZIP archives</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>
              A single local SQLite file. No account, no cloud, no telemetry. Artix works with the
              network turned off.
            </dd>
          </div>
        </dl>

        <button
          className="empty__link"
          onClick={() => useUi.getState().setOverlay('shortcuts')}
        >
          See keyboard shortcuts
        </button>
      </div>
    </div>
  );
}

/**
 * Seed a generated library so the visualisation can be evaluated before
 * committing real data. Clearly labelled: every demo session's source is
 * `demo:generator`, so it can be found and deleted with one query.
 */
async function loadDemo(): Promise<void> {
  const app = getApp();
  if (!app) return;

  const sessions = generateDemoLibrary({ count: 280 });
  const result = await app.storage.saveSessions(sessions);

  if (!result.ok) {
    notify('error', result.error.message);
    return;
  }

  bus.emit('library:changed', { reason: 'import', ids: result.value.imported });
  notify(
    'success',
    `Loaded ${result.value.imported.length} demo sessions.`,
    'Search source:demo to find them later, or delete them from Settings.',
  );
}
