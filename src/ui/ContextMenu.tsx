/**
 * Right-click context menu.
 *
 * Items are built from the command registry, so the menu can never offer an
 * action the palette does not have, and a plugin's command shows up here for
 * free.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { commands, displayShortcut } from '../commands/registry.ts';
import { useLibrary } from '../state/library-store.ts';
import { useUi } from '../state/ui-store.ts';
import type { CommandContext } from '../commands/registry.ts';
import './ContextMenu.css';

/** Commands offered on a star, in order. */
const SESSION_COMMANDS = [
  'artix.openSelected',
  'artix.copyContext',
  'artix.pin',
  'artix.archive',
  'artix.export',
  'artix.delete',
];

/** Commands offered on empty space. */
const CANVAS_COMMANDS = ['artix.overview', 'artix.search', 'artix.import', 'artix.toggleLegend'];

export function ContextMenu(): JSX.Element | null {
  const menu = useUi((state) => state.contextMenu);
  const close = useUi((state) => state.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Clamp inside the viewport after the menu has been measured.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPosition({
      x: Math.min(menu.x, window.innerWidth - rect.width - 8),
      y: Math.min(menu.y, window.innerHeight - rect.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => close();
    // `pointerdown` rather than `click`, so the menu closes before the
    // underlying canvas processes the press.
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [menu, close]);

  if (!menu) return null;

  const context: CommandContext = {
    selectedIds: menu.sessionId ? [menu.sessionId] : [],
    inSession: useLibrary.getState().openSession !== null,
    inSearch: false,
  };

  const ids = menu.sessionId ? SESSION_COMMANDS : CANVAS_COMMANDS;
  const items = ids
    .map((id) => commands.get(id))
    .filter((command): command is NonNullable<typeof command> => {
      if (!command) return false;
      return command.when?.(context) ?? true;
    });

  const session = menu.sessionId
    ? useLibrary.getState().sessions.find((s) => s.id === menu.sessionId)
    : undefined;

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
    >
      {session && <div className="context-menu__heading truncate">{session.title}</div>}

      {items.map((command) => (
        <button
          key={command.id}
          className={`context-menu__item${command.id === 'artix.delete' ? ' is-danger' : ''}`}
          role="menuitem"
          onClick={() => {
            close();
            if (menu.sessionId) useLibrary.getState().select(menu.sessionId);
            void commands.run(command.id, context);
          }}
        >
          <span>{command.title}</span>
          {command.shortcut && <kbd>{displayShortcut(command.shortcut)}</kbd>}
        </button>
      ))}

      {items.length === 0 && <div className="context-menu__empty">No actions available</div>}
    </div>
  );
}
