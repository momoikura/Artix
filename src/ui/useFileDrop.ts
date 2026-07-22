/**
 * File drag-and-drop.
 *
 * Two completely different mechanisms behind one hook:
 *
 *  - Under Tauri the webview swallows HTML5 drag events and emits a native
 *    drag-drop event carrying real filesystem *paths*, which we then read
 *    through the storage adapter.
 *  - In the browser there are no paths, only `File` objects, so the content is
 *    read directly via `File.text()`.
 *
 * Both paths converge on `runImport`, so deduplication, extraction and progress
 * reporting behave identically however a file arrived.
 */

import { useEffect, useState } from 'react';

import { notify } from '../core/events.ts';
import { importers, runImport } from '../importers/registry.ts';
import { isTauri } from '../storage/tauri-adapter.ts';
import type { ImportSource } from '../importers/types.ts';
import type { StorageAdapter } from '../storage/adapter.ts';

/** Extensions we accept on drop, derived from the registered importers. */
function accepted(): Set<string> {
  return new Set(importers.extensions().map((e) => e.toLowerCase()));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

async function importSources(storage: StorageAdapter, sources: ImportSource[]): Promise<void> {
  if (sources.length === 0) {
    notify('warn', 'Nothing importable in that drop.', `Accepted: ${importers.extensions().join(', ')}`);
    return;
  }

  const report = await runImport(storage, { sources });

  const skipped = report.skipped.length + report.duplicates.length;
  notify(
    report.failed.length > 0 ? 'warn' : 'success',
    `Imported ${report.imported.length} session${report.imported.length === 1 ? '' : 's'}.`,
    [
      skipped > 0 ? `${skipped} already in library` : '',
      ...report.warnings.slice(0, 3),
    ]
      .filter(Boolean)
      .join('\n') || undefined,
  );
}

/**
 * Returns whether a drag is currently hovering, so the caller can render a
 * drop target. `storage` is required because the Tauri path only receives
 * paths and must read them through the adapter.
 */
export function useFileDrop(storage: StorageAdapter | null): boolean {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    if (!storage) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    /* ------------------------------------------------------------ Tauri */
    if (isTauri()) {
      void (async () => {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const stop = await getCurrentWebview().onDragDropEvent(async (event) => {
          const payload = event.payload;

          if (payload.type === 'over') {
            setHovering(true);
            return;
          }
          if (payload.type === 'leave') {
            setHovering(false);
            return;
          }
          if (payload.type !== 'drop') return;

          setHovering(false);
          const allow = accepted();
          const sources: ImportSource[] = [];

          for (const path of payload.paths) {
            if (!allow.has(extensionOf(path))) continue;
            const contents = await storage.readTextFile(path);
            if (!contents.ok) {
              notify('warn', `Could not read ${basename(path)}`, contents.error.message);
              continue;
            }
            sources.push({ reference: path, name: basename(path), content: contents.value });
          }

          await importSources(storage, sources);
        });

        // The listener may resolve after unmount; drop it immediately if so.
        if (disposed) stop();
        else unlisten = stop;
      })();

      return () => {
        disposed = true;
        unlisten?.();
      };
    }

    /* ---------------------------------------------------------- browser */
    // Nested elements fire dragenter/dragleave constantly, so track depth
    // rather than toggling on every event or the overlay flickers.
    let depth = 0;

    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      depth++;
      setHovering(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      // Without this the browser navigates to the dropped file.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setHovering(false);
    };

    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setHovering(false);

      const files = [...(event.dataTransfer?.files ?? [])];
      const allow = accepted();

      void Promise.all(
        files
          .filter((file) => allow.has(extensionOf(file.name)))
          .map(async (file) => ({
            reference: `drop://${file.name}`,
            name: file.name,
            content: await file.text(),
            modifiedAt: file.lastModified,
          })),
      ).then((sources) => importSources(storage, sources));
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      disposed = true;
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [storage]);

  return hovering;
}
