/**
 * File dialogs.
 *
 * One API, two implementations: native dialogs under Tauri, and a hidden
 * `<input type="file">` in the browser build. The browser path cannot return
 * real paths, so it returns the file *contents* directly — which is exactly
 * what the importers want anyway.
 */

import { isTauri } from '../storage/tauri-adapter.ts';
import type { ImportSource } from '../importers/types.ts';

export interface OpenFilesOptions {
  title?: string;
  extensions?: string[];
  multiple?: boolean;
}

/**
 * Ask the user for files and return them as import sources.
 *
 * Under Tauri this picks paths and reads them through the storage adapter;
 * in the browser it reads the `File` objects directly.
 */
export async function pickImportSources(
  options: OpenFilesOptions,
  readFile: (path: string) => Promise<string | null>,
): Promise<ImportSource[]> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selection = await open({
      title: options.title ?? 'Import sessions',
      multiple: options.multiple ?? true,
      directory: false,
      filters:
        options.extensions && options.extensions.length > 0
          ? [{ name: 'Sessions', extensions: options.extensions }]
          : undefined,
    });

    if (selection === null) return [];
    const paths = Array.isArray(selection) ? selection : [selection];

    const sources: ImportSource[] = [];
    for (const path of paths) {
      const content = await readFile(path);
      if (content === null) continue;
      sources.push({
        reference: path,
        name: basename(path),
        content,
      });
    }
    return sources;
  }

  return pickViaInput(options);
}

/** Ask for a folder. Returns null in the browser build, where it is impossible. */
export async function pickFolder(title = 'Choose a folder'): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selection = await open({ title, directory: true, multiple: false });
  return typeof selection === 'string' ? selection : null;
}

/** Ask where to save. Returns null in the browser build. */
export async function pickSaveDestination(
  defaultName: string,
  extensions: string[],
): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const selection = await save({
    defaultPath: defaultName,
    filters: [{ name: extensions[0]?.toUpperCase() ?? 'File', extensions }],
  });
  return selection ?? null;
}

/**
 * Browser fallback: trigger a download.
 *
 * Used for exports when there is no filesystem to write to, so the browser
 * build is still genuinely useful rather than half-crippled.
 */
export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  // Revoke on the next tick — revoking synchronously cancels the download in
  // some browsers.
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 0);
}

/* ------------------------------------------------------------- internals */

function pickViaInput(options: OpenFilesOptions): Promise<ImportSource[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple ?? true;
    if (options.extensions && options.extensions.length > 0) {
      input.accept = options.extensions.map((extension) => `.${extension}`).join(',');
    }
    input.style.display = 'none';

    let settled = false;
    const finish = (sources: ImportSource[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(sources);
    };

    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      if (files.length === 0) {
        finish([]);
        return;
      }

      void Promise.all(
        files.map(async (file) => ({
          reference: `upload://${file.name}`,
          name: file.name,
          content: await file.text(),
          modifiedAt: file.lastModified,
        })),
      ).then(finish);
    });

    // `cancel` is not universally supported; the focus fallback covers the rest.
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener(
      'focus',
      () => {
        // Give `change` a chance to fire first.
        setTimeout(() => {
          if (!input.files || input.files.length === 0) finish([]);
        }, 400);
      },
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}
