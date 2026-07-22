/**
 * Command palette (Ctrl/Cmd+K).
 *
 * One input, two result sets: sessions when you type prose, commands when you
 * type `>`. Moving the selection flies the camera to that star immediately, so
 * searching *is* navigating — you see where a result lives before you commit
 * to opening it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { bus } from '../core/events.ts';
import { commands, displayShortcut, filterCommands } from '../commands/registry.ts';
import { formatRelative } from '../core/time.ts';
import { languageColor } from '../core/languages.ts';
import { useLibrary } from '../state/library-store.ts';
import { useUi } from '../state/ui-store.ts';
import { Highlighted } from './components/Highlighted.tsx';
import type { CommandContext } from '../commands/registry.ts';
import type { SearchHit } from '../core/types.ts';
import './CommandPalette.css';

/** Typing this prefix switches the palette into command mode. */
const COMMAND_PREFIX = '>';

export function CommandPalette(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rawQuery = useLibrary((state) => state.rawQuery);
  const setRawQuery = useLibrary((state) => state.setRawQuery);
  const hits = useLibrary((state) => state.hits);
  const sessions = useLibrary((state) => state.sessions);
  const elapsed = useLibrary((state) => state.searchElapsedMs);
  const total = useLibrary((state) => state.searchTotal);

  const [text, setText] = useState(rawQuery);
  const [cursor, setCursor] = useState(0);

  const commandMode = text.startsWith(COMMAND_PREFIX);

  /* -------------------------------------------------------------- results */

  const context = useMemo<CommandContext>(() => {
    const library = useLibrary.getState();
    return {
      selectedIds: library.selectedId ? [library.selectedId] : [],
      inSession: library.openSession !== null,
      inSearch: true,
    };
  }, []);

  const commandResults = useMemo(() => {
    if (!commandMode) return [];
    return filterCommands(commands.list(context), text.slice(1)).slice(0, 20);
  }, [commandMode, text, context]);

  /**
   * With an empty query, show the most recent sessions rather than nothing —
   * "what was I doing?" is the most common reason the palette gets opened.
   */
  const sessionResults: SearchHit[] = useMemo(() => {
    if (commandMode) return [];
    if (text.trim().length === 0) {
      return sessions.slice(0, 12).map((session) => ({
        session,
        score: 0,
        highlights: [],
        via: 'filter' as const,
      }));
    }
    return hits.slice(0, 40);
  }, [commandMode, text, hits, sessions]);

  const resultCount = commandMode ? commandResults.length : sessionResults.length;

  /* ---------------------------------------------------------------- effects */

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Keep the store's query in sync so the galaxy highlights as you type.
  useEffect(() => {
    if (commandMode) return;
    if (text !== rawQuery) setRawQuery(text);
    // `rawQuery` intentionally omitted: this effect pushes, it does not pull.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, commandMode, setRawQuery]);

  useEffect(() => {
    setCursor(0);
  }, [text, commandMode]);

  // Fly to the highlighted star as the selection moves.
  useEffect(() => {
    if (commandMode) return;
    const hit = sessionResults[cursor];
    if (!hit) return;
    useLibrary.getState().select(hit.session.id);
    bus.emit('camera:focus', { id: hit.session.id, immediate: false });
  }, [cursor, sessionResults, commandMode]);

  // Keep the active row in view without yanking the whole list.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  /* ---------------------------------------------------------------- actions */

  const close = () => useUi.getState().setOverlay('none');

  const commit = (index: number) => {
    if (commandMode) {
      const command = commandResults[index];
      if (!command) return;
      close();
      void commands.run(command.id, context);
      return;
    }

    const hit = sessionResults[index];
    if (!hit) return;
    close();
    void useLibrary.getState().open(hit.session.id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setCursor((c) => (resultCount === 0 ? 0 : (c + 1) % resultCount));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setCursor((c) => (resultCount === 0 ? 0 : (c - 1 + resultCount) % resultCount));
        break;
      case 'Enter':
        event.preventDefault();
        commit(cursor);
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'Tab':
        // Tab completes to the highlighted result's title, so refining a search
        // does not mean retyping it.
        if (!commandMode && sessionResults[cursor]) {
          event.preventDefault();
          setText(sessionResults[cursor]!.session.title);
        }
        break;
      default:
        break;
    }
  };

  /* ----------------------------------------------------------------- render */

  return (
    <div className="overlay overlay--top" onMouseDown={close}>
      <div
        className="palette"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
      >
        <div className="palette__input-row">
          <span className="palette__prefix" aria-hidden="true">
            {commandMode ? '>' : '⌕'}
          </span>
          <input
            ref={inputRef}
            className="palette__input"
            value={text}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search sessions, or type > for commands"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search sessions or run a command"
          />
          {!commandMode && text.trim().length > 0 && (
            <span className="palette__stats mono">
              {total.toLocaleString()} in {elapsed.toFixed(1)}ms
            </span>
          )}
        </div>

        <ul className="palette__results" ref={listRef} role="listbox">
          {commandMode
            ? commandResults.map((command, index) => (
                <li
                  key={command.id}
                  role="option"
                  aria-selected={index === cursor}
                  data-active={index === cursor}
                  className="palette__row"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => commit(index)}
                >
                  <div className="palette__row-main">
                    <span className="palette__row-title">{command.title}</span>
                    <span className="palette__row-category">{command.category}</span>
                  </div>
                  {command.shortcut && (
                    <kbd className="palette__shortcut">{displayShortcut(command.shortcut)}</kbd>
                  )}
                </li>
              ))
            : sessionResults.map((hit, index) => (
                <li
                  key={hit.session.id}
                  role="option"
                  aria-selected={index === cursor}
                  data-active={index === cursor}
                  className="palette__row"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => commit(index)}
                >
                  <span
                    className="palette__swatch"
                    style={{ background: languageColor(hit.session.language) }}
                    aria-hidden="true"
                  />
                  <div className="palette__row-main">
                    <span className="palette__row-title">
                      <Highlighted
                        text={hit.session.title}
                        ranges={hit.highlights.filter((h) => h.field === 'title')}
                      />
                    </span>
                    <span className="palette__row-sub truncate">
                      {hit.session.project}
                      {hit.session.summary ? ` — ${hit.session.summary}` : ''}
                    </span>
                  </div>
                  <div className="palette__row-meta">
                    {hit.via === 'fuzzy' && <span className="chip">fuzzy</span>}
                    {hit.session.pinned && <span className="palette__pin" title="Pinned">◆</span>}
                    <span className="palette__date">{formatRelative(hit.session.startedAt)}</span>
                  </div>
                </li>
              ))}

          {resultCount === 0 && (
            <li className="palette__empty">
              {commandMode ? 'No matching commands.' : `Nothing matches “${text.trim()}”.`}
            </li>
          )}
        </ul>

        <footer className="palette__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>Tab</kbd> complete
          </span>
          <span>
            <kbd>&gt;</kbd> commands
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
