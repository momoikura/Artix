/**
 * Session workspace.
 *
 * The reconstruction view: everything Artix knows about one session, organised
 * so the question "what was I doing and where was I?" is answerable in seconds.
 *
 * Long transcripts are windowed rather than fully rendered — a 4000-message
 * session must open as fast as a 4-message one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { copyContextBundle } from '../exporters/registry.ts';
import { formatDuration, formatRelative, isoDateTime } from '../core/time.ts';
import { languageColor, resolveLanguage } from '../core/languages.ts';
import { notify } from '../core/events.ts';
import { getApp } from '../state/app.ts';
import { useLibrary } from '../state/library-store.ts';
import { useUi } from '../state/ui-store.ts';
import type { Artifact, Message, SessionDetail } from '../core/types.ts';
import './SessionWorkspace.css';

const TABS = [
  'Overview',
  'Conversation',
  'Files',
  'Code',
  'Architecture',
  'Decisions',
  'Notes',
] as const;
type Tab = (typeof TABS)[number];

/** Messages rendered per page. Keeps the DOM bounded on huge transcripts. */
const MESSAGE_PAGE = 40;

export function SessionWorkspace({ detail }: { detail: SessionDetail }): JSX.Element {
  const [tab, setTab] = useState<Tab>('Overview');
  const close = useLibrary((state) => state.closeSession);

  // Escape closes the workspace unless an overlay has taken priority.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (useUi.getState().overlay !== 'none') return;
      close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [close]);

  const { session } = detail;

  const counts = useMemo(
    () => ({
      Conversation: detail.messages.length,
      Files: detail.files.length,
      Code: detail.artifacts.filter((a) => a.kind === 'code').length,
      Architecture: detail.artifacts.filter((a) => a.kind === 'architecture').length,
      Decisions: detail.artifacts.filter((a) => a.kind === 'decision').length,
    }),
    [detail],
  );

  return (
    <div className="workspace" role="dialog" aria-modal="true" aria-label={session.title}>
      <header className="workspace__header">
        <button className="btn btn--ghost workspace__back" onClick={close} aria-label="Back to galaxy">
          ← Galaxy
        </button>

        <div className="workspace__identity">
          <span
            className="workspace__swatch"
            style={{ background: languageColor(session.language) }}
            aria-hidden="true"
          />
          <div className="workspace__identity-text">
            <h1 className="workspace__title selectable">{session.title}</h1>
            <div className="workspace__meta">
              <span>{session.project}</span>
              <span className="workspace__dot">·</span>
              <span title={isoDateTime(session.startedAt)}>{formatRelative(session.startedAt)}</span>
              <span className="workspace__dot">·</span>
              <span>
                {formatDuration(session.endedAt ? session.endedAt - session.startedAt : null)}
              </span>
              <span className="workspace__dot">·</span>
              <span>{resolveLanguage(session.language).label}</span>
            </div>
          </div>
        </div>

        <div className="workspace__actions">
          <button
            className="btn btn--primary"
            onClick={async () => {
              const app = getApp();
              if (!app) return;
              const result = await copyContextBundle(app.storage, [session.id]);
              if (!result.ok) notify('warn', result.error.message, result.error.hint);
            }}
            title="Copy a briefing sized for a context window"
          >
            Copy context bundle
          </button>
          <button className="btn" onClick={() => useUi.getState().setOverlay('export')}>
            Export…
          </button>
        </div>
      </header>

      <nav className="workspace__tabs" role="tablist">
        {TABS.map((name) => {
          const count = counts[name as keyof typeof counts];
          return (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              className={`workspace__tab${tab === name ? ' is-active' : ''}`}
              onClick={() => setTab(name)}
            >
              {name}
              {count !== undefined && count > 0 && (
                <span className="workspace__tab-count mono">{count}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="workspace__content" key={tab}>
        {tab === 'Overview' && <OverviewTab detail={detail} />}
        {tab === 'Conversation' && <ConversationTab messages={detail.messages} />}
        {tab === 'Files' && <FilesTab detail={detail} />}
        {tab === 'Code' && <ArtifactsTab artifacts={detail.artifacts} kind="code" />}
        {tab === 'Architecture' && <ArtifactsTab artifacts={detail.artifacts} kind="architecture" />}
        {tab === 'Decisions' && <DecisionsTab detail={detail} />}
        {tab === 'Notes' && <NotesTab detail={detail} />}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- overview */

function OverviewTab({ detail }: { detail: SessionDetail }): JSX.Element {
  const { session, artifacts, files } = detail;

  const todos = artifacts.filter((a) => a.kind === 'todo');
  const openTodos = todos.filter((t) => !t.done);
  const decisions = artifacts.filter((a) => a.kind === 'decision');
  const commands = artifacts.filter((a) => a.kind === 'command');

  return (
    <div className="overview">
      {session.summary && (
        <section className="card">
          <h2 className="card__title">Summary</h2>
          <p className="card__prose selectable">{session.summary}</p>
        </section>
      )}

      <section className="stat-grid">
        <Stat label="Messages" value={session.messageCount} />
        <Stat label="Files" value={session.fileCount} />
        <Stat label="Artifacts" value={session.artifactCount} />
        <Stat label="Tokens" value={session.tokenEstimate} prefix="≈" />
      </section>

      {openTodos.length > 0 && (
        <section className="card">
          <h2 className="card__title">
            Open items <span className="card__badge">{openTodos.length}</span>
          </h2>
          <ul className="todo-list">
            {todos.map((todo) => (
              <li key={todo.id} className={todo.done ? 'is-done' : ''}>
                <span className="todo-list__box" aria-hidden="true">
                  {todo.done ? '✓' : ''}
                </span>
                <span className="selectable">{todo.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {decisions.length > 0 && (
        <section className="card">
          <h2 className="card__title">Key decisions</h2>
          <ul className="decision-list">
            {decisions.slice(0, 6).map((decision) => (
              <li key={decision.id} className="selectable">
                {decision.content}
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section className="card">
          <h2 className="card__title">Most-touched files</h2>
          <ul className="file-list file-list--compact">
            {files.slice(0, 8).map((file) => (
              <li key={file.id}>
                <span className={`file-list__action file-list__action--${file.action}`}>
                  {file.action}
                </span>
                <code className="selectable">{file.path}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {commands.length > 0 && (
        <section className="card">
          <h2 className="card__title">Commands run</h2>
          <pre className="code-block selectable">
            {commands.map((command) => command.content).join('\n')}
          </pre>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  prefix,
}: {
  label: string;
  value: number;
  prefix?: string;
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat__value mono">
        {prefix}
        {value.toLocaleString()}
      </div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

/* ----------------------------------------------------------- conversation */

function ConversationTab({ messages }: { messages: Message[] }): JSX.Element {
  const [visible, setVisible] = useState(MESSAGE_PAGE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Load more as the sentinel scrolls into view — infinite scroll without a
  // virtualiser, which is enough because messages are appended, never reordered.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visible >= messages.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible((current) => Math.min(current + MESSAGE_PAGE, messages.length));
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visible, messages.length]);

  if (messages.length === 0) {
    return <EmptyTab message="This session has no stored conversation." />;
  }

  return (
    <div className="conversation">
      {messages.slice(0, visible).map((message) => (
        <article key={message.id} className={`message message--${message.role}`}>
          <header className="message__header">
            <span className="message__role">{message.role}</span>
            {message.toolName && <span className="chip">{message.toolName}</span>}
            {message.createdAt && (
              <time className="message__time mono">{isoDateTime(message.createdAt)}</time>
            )}
          </header>
          <div className="message__body selectable">
            <MessageContent content={message.content} />
          </div>
        </article>
      ))}

      {visible < messages.length && (
        <div ref={sentinelRef} className="conversation__more">
          Loading {messages.length - visible} more message
          {messages.length - visible === 1 ? '' : 's'}…
        </div>
      )}
    </div>
  );
}

/**
 * Minimal markdown rendering: fenced code blocks become `<pre>`, everything
 * else stays as plain text.
 *
 * A full markdown renderer would be a large dependency and an XSS surface for
 * imported third-party content. Code fences are the only formatting that
 * genuinely changes comprehension.
 */
function MessageContent({ content }: { content: string }): JSX.Element {
  const parts = useMemo(() => splitFences(content), [content]);

  return (
    <>
      {parts.map((part, index) =>
        part.type === 'code' ? (
          <pre key={index} className="code-block">
            {part.language && <span className="code-block__lang">{part.language}</span>}
            <code>{part.content}</code>
          </pre>
        ) : (
          <p key={index} className="message__text">
            {part.content}
          </p>
        ),
      )}
    </>
  );
}

interface ContentPart {
  type: 'text' | 'code';
  content: string;
  language?: string;
}

function splitFences(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const lines = content.split('\n');

  let buffer: string[] = [];
  let inFence = false;
  let language = '';

  const flush = (type: ContentPart['type']) => {
    const text = buffer.join('\n');
    if (text.trim().length > 0) {
      parts.push(type === 'code' ? { type, content: text, language } : { type, content: text });
    }
    buffer = [];
  };

  for (const line of lines) {
    const fence = /^\s*(?:```|~~~)\s*(\S*)/.exec(line);
    if (fence) {
      if (inFence) {
        flush('code');
        inFence = false;
        language = '';
      } else {
        flush('text');
        inFence = true;
        language = fence[1] ?? '';
      }
      continue;
    }
    buffer.push(line);
  }
  flush(inFence ? 'code' : 'text');

  return parts;
}

/* --------------------------------------------------------------- files */

function FilesTab({ detail }: { detail: SessionDetail }): JSX.Element {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const filtered = detail.files.filter((file) =>
      query.trim() === '' ? true : file.path.toLowerCase().includes(query.toLowerCase()),
    );
    const map = new Map<string, typeof filtered>();
    for (const file of filtered) {
      const directory = file.path.split('/').slice(0, -1).join('/') || '.';
      const bucket = map.get(directory);
      if (bucket) bucket.push(file);
      else map.set(directory, [file]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [detail.files, query]);

  if (detail.files.length === 0) {
    return <EmptyTab message="No files were referenced in this session." />;
  }

  return (
    <div className="files">
      <input
        className="input files__filter"
        value={query}
        placeholder="Filter files…"
        onChange={(event) => setQuery(event.target.value)}
      />

      {grouped.map(([directory, files]) => (
        <section key={directory} className="files__group">
          <h3 className="files__dir mono">{directory}</h3>
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.id}>
                <span className={`file-list__action file-list__action--${file.action}`}>
                  {file.action}
                </span>
                <code className="selectable">{file.path.split('/').pop()}</code>
                {file.bytes > 0 && (
                  <span className="file-list__size mono">{file.bytes.toLocaleString()} B</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {grouped.length === 0 && <EmptyTab message={`No files match “${query}”.`} />}
    </div>
  );
}

/* ------------------------------------------------------------- artifacts */

function ArtifactsTab({
  artifacts,
  kind,
}: {
  artifacts: Artifact[];
  kind: Artifact['kind'];
}): JSX.Element {
  const filtered = artifacts.filter((artifact) => artifact.kind === kind);

  if (filtered.length === 0) {
    return <EmptyTab message={`Nothing was captured under ${kind} for this session.`} />;
  }

  return (
    <div className="artifacts">
      {filtered.map((artifact) => (
        <section key={artifact.id} className="card">
          <h2 className="card__title mono">{artifact.path ?? artifact.title}</h2>
          <pre className="code-block selectable">
            {artifact.language && <span className="code-block__lang">{artifact.language}</span>}
            <code>{artifact.content}</code>
          </pre>
        </section>
      ))}
    </div>
  );
}

function DecisionsTab({ detail }: { detail: SessionDetail }): JSX.Element {
  const decisions = detail.artifacts.filter((a) => a.kind === 'decision');

  if (decisions.length === 0) {
    return <EmptyTab message="No decisions were extracted from this session." />;
  }

  return (
    <div className="decisions">
      {decisions.map((decision) => (
        <article key={decision.id} className="decision">
          <p className="selectable">{decision.content}</p>
          {decision.messageSeq !== null && (
            <span className="decision__origin mono">message #{decision.messageSeq}</span>
          )}
        </article>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- notes */

function NotesTab({ detail }: { detail: SessionDetail }): JSX.Element {
  const patch = useLibrary((state) => state.patch);
  const [notes, setNotes] = useState(detail.session.notes);
  const [saved, setSaved] = useState(true);

  return (
    <div className="notes">
      <div className="notes__header">
        <span className="label">Your notes</span>
        <span className={`notes__status${saved ? ' is-saved' : ''}`}>
          {saved ? 'Saved' : 'Unsaved changes'}
        </span>
      </div>

      <textarea
        className="input notes__editor"
        value={notes}
        placeholder={
          'What mattered about this session?\n\n' +
          'Notes are never overwritten by re-imports, and they are weighted heavily in search.'
        }
        onChange={(event) => {
          setNotes(event.target.value);
          setSaved(false);
        }}
        onBlur={() => {
          if (notes === detail.session.notes) {
            setSaved(true);
            return;
          }
          void patch(detail.session.id, { notes }).then(() => setSaved(true));
        }}
      />
    </div>
  );
}

function EmptyTab({ message }: { message: string }): JSX.Element {
  return <div className="workspace__empty">{message}</div>;
}
