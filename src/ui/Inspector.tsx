/**
 * Inspector.
 *
 * Shows whatever is selected without leaving the galaxy — the intermediate
 * step between "I see a star" and "I have opened the session". Editing here is
 * inline and immediate; there is no save button, because nothing here is
 * destructive and a save button would just be a step to forget.
 */

import { useEffect, useState } from 'react';

import { formatDuration, formatRelative, isoDateTime } from '../core/time.ts';
import { languageColor, resolveLanguage } from '../core/languages.ts';
import { useLibrary } from '../state/library-store.ts';
import { useUi } from '../state/ui-store.ts';
import type { Session } from '../core/types.ts';
import './Inspector.css';

export function Inspector(): JSX.Element {
  const selectedId = useLibrary((state) => state.selectedId);
  const sessions = useLibrary((state) => state.sessions);
  const stats = useLibrary((state) => state.stats);

  const session = selectedId ? sessions.find((s) => s.id === selectedId) : undefined;

  return (
    <aside className="inspector">
      {session ? <SessionCard session={session} /> : <LibrarySummary stats={stats} />}
    </aside>
  );
}

/* ------------------------------------------------------------ session card */

function SessionCard({ session }: { session: Session }): JSX.Element {
  const patch = useLibrary((state) => state.patch);
  const open = useLibrary((state) => state.open);

  const [notes, setNotes] = useState(session.notes);

  // Reset local edit state when the selection moves to another star.
  useEffect(() => {
    setNotes(session.notes);
  }, [session.id, session.notes]);

  const duration = session.endedAt ? session.endedAt - session.startedAt : null;
  const language = resolveLanguage(session.language);

  return (
    <div className="inspector__body">
      <header className="inspector__header">
        <div className="inspector__kind">
          <span className={`inspector__glyph inspector__glyph--${session.kind}`} aria-hidden="true" />
          <span className="label">{session.kind}</span>
          <span className={`inspector__status inspector__status--${session.status}`}>
            {session.status}
          </span>
        </div>

        <h2 className="inspector__title selectable">{session.title}</h2>

        <div className="inspector__project">
          <span
            className="inspector__swatch"
            style={{ background: languageColor(session.language) }}
            aria-hidden="true"
          />
          {session.project}
        </div>
      </header>

      <div className="inspector__actions">
        <button className="btn btn--primary" onClick={() => void open(session.id)}>
          Open session
        </button>
        <button
          className={`btn btn--icon${session.pinned ? ' is-pinned' : ''}`}
          title={session.pinned ? 'Unpin' : 'Pin'}
          aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
          onClick={() => void patch(session.id, { pinned: !session.pinned })}
        >
          ◆
        </button>
      </div>

      {session.summary && <p className="inspector__summary selectable">{session.summary}</p>}

      <dl className="inspector__facts">
        <Fact label="Started" value={isoDateTime(session.startedAt)} hint={formatRelative(session.startedAt)} />
        <Fact label="Duration" value={formatDuration(duration)} />
        <Fact label="Language" value={language.label} />
        <Fact label="Messages" value={session.messageCount.toLocaleString()} />
        <Fact label="Files" value={session.fileCount.toLocaleString()} />
        <Fact label="Artifacts" value={session.artifactCount.toLocaleString()} />
        <Fact label="Tokens" value={`≈ ${session.tokenEstimate.toLocaleString()}`} />
        {session.folder && <Fact label="Folder" value={session.folder} mono />}
      </dl>

      {session.technologies.length > 0 && (
        <section className="inspector__section">
          <div className="label">Stack</div>
          <div className="inspector__chips">
            {session.technologies.map((tech) => (
              <button
                key={tech}
                className="chip chip--interactive"
                onClick={() => useLibrary.getState().setRawQuery(`tech:"${tech}"`)}
                title={`Find sessions using ${tech}`}
              >
                {tech}
              </button>
            ))}
          </div>
        </section>
      )}

      {session.tags.length > 0 && (
        <section className="inspector__section">
          <div className="label">Tags</div>
          <div className="inspector__chips">
            {session.tags.map((tag) => (
              <button
                key={tag}
                className="chip chip--accent chip--interactive"
                onClick={() => useLibrary.getState().setRawQuery(`tag:${tag}`)}
                title={`Find sessions tagged ${tag}`}
              >
                #{tag}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="inspector__section">
        <div className="label">Notes</div>
        <textarea
          className="input inspector__notes"
          value={notes}
          placeholder="Anything you want to remember about this session…"
          onChange={(event) => setNotes(event.target.value)}
          // Commit on blur rather than per keystroke: notes are free-form and
          // a write per character would thrash the index.
          onBlur={() => {
            if (notes !== session.notes) void patch(session.id, { notes });
          }}
        />
      </section>

      <section className="inspector__section">
        <div className="label">Derived</div>
        <Meter label="Complexity" value={session.complexity} />
        <Meter label="Importance" value={session.importance} />
      </section>
    </div>
  );
}

function Fact({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="inspector__fact">
      <dt>{label}</dt>
      <dd className={mono ? 'mono selectable' : 'selectable'} title={hint ?? value}>
        {value}
      </dd>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="inspector__meter">
      <span className="inspector__meter-label">{label}</span>
      <div className="inspector__meter-track">
        <div className="inspector__meter-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="inspector__meter-value mono">{value.toFixed(2)}</span>
    </div>
  );
}

/* ------------------------------------------------------- library summary */

function LibrarySummary({ stats }: { stats: ReturnType<typeof useLibrary.getState>['stats'] }): JSX.Element {
  const facets = useLibrary((state) => state.facets);
  const projects = facets?.projects.slice(0, 8) ?? [];

  return (
    <div className="inspector__body">
      <header className="inspector__header">
        <span className="label">Library</span>
        <h2 className="inspector__title">
          {stats ? stats.sessionCount.toLocaleString() : '—'} sessions
        </h2>
        <p className="inspector__project">
          {stats?.earliest
            ? `${new Date(stats.earliest).getFullYear()} – ${new Date(stats.latest ?? Date.now()).getFullYear()}`
            : 'Nothing archived yet'}
        </p>
      </header>

      {stats && (
        <dl className="inspector__facts">
          <Fact label="Projects" value={stats.projectCount.toLocaleString()} />
          <Fact label="Messages" value={stats.messageCount.toLocaleString()} />
          <Fact label="Artifacts" value={stats.artifactCount.toLocaleString()} />
          <Fact label="Files" value={stats.fileCount.toLocaleString()} />
          <Fact label="Tokens" value={`≈ ${stats.tokenEstimate.toLocaleString()}`} />
          {stats.databaseBytes > 0 && (
            <Fact label="On disk" value={formatBytes(stats.databaseBytes)} />
          )}
        </dl>
      )}

      {projects.length > 0 && (
        <section className="inspector__section">
          <div className="label">Projects</div>
          <ul className="inspector__projects">
            {projects.map((project) => (
              <li key={project.value}>
                <button
                  className="inspector__project-row"
                  onClick={() => useLibrary.getState().setRawQuery(`project:"${project.value}"`)}
                >
                  <span className="truncate">{project.value}</span>
                  <span className="mono">{project.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="inspector__hint">
        Click a star to inspect it. Double-click to open the full session.
      </p>

      <button className="btn" onClick={() => useUi.getState().setOverlay('palette')}>
        Search the archive
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
