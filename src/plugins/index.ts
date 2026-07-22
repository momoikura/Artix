/** Public surface of the Artix plugin subsystem. */

export * from './api.ts';
export { PluginHost } from './host.ts';
export { csvIndexPlugin } from './builtin/csv-index.ts';

import { csvIndexPlugin } from './builtin/csv-index.ts';
import type { ArtixPlugin } from './api.ts';

/** Plugins shipped with Artix. Registered but not enabled by default. */
export const BUILTIN_PLUGINS: readonly ArtixPlugin[] = [csvIndexPlugin];
