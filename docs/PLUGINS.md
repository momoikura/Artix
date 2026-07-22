# Plugins

Artix hardcodes no providers. Importers, exporters, commands, panels and whole
visualisations are contributions to registries, and **every built-in feature
registers through the same API a plugin uses**.

`src/plugins/builtin/csv-index.ts` is a complete working example that adds a
real export format without touching the core.

---

## Shape of a plugin

```ts
import type { ArtixPlugin, ArtixPluginApi } from '@/plugins/api.ts';

export const myPlugin: ArtixPlugin = {
  id: 'acme.notion-sync',        // reverse-DNS, globally unique
  name: 'Notion importer',
  description: 'Imports pages exported from Notion.',
  version: '1.0.0',
  requires: '>=0.1.0',           // minimum Artix version

  activate(api: ArtixPluginApi) {
    api.contributeImporter({ /* … */ });
  },

  deactivate() {
    // Optional. Contributions are disposed for you.
  },
};
```

`activate` may be async. If it throws, the host rolls back everything the
plugin already contributed, disables it, and shows the error in Settings — a
broken plugin never takes the application down.

---

## Contribution points

Each `contribute*` call returns a disposer, and the host tracks them all, so
deactivating is exactly reversible.

### Importer

```ts
api.contributeImporter({
  id: `${api.pluginId}:notion`,
  label: 'Notion export',
  description: 'Markdown pages exported from Notion.',
  extensions: ['md', 'zip'],

  // Confidence 0..1 that this importer can parse the source.
  // Be honest: return 0 rather than a hopeful 0.3. The registry picks the
  // highest scorer, and an over-eager importer steals files from a correct one.
  detect: (source) => (source.content.includes('notion.so') ? 0.9 : 0),

  parse: (source) => ({
    drafts: [{
      title: 'Page title',
      project: 'notes',
      source: `${api.pluginId}:notion`,
      sourceRef: source.reference,
      startedAt: source.modifiedAt ?? Date.now(),
      messages: [{ seq: 0, role: 'user', content: source.content,
                   createdAt: null, tokenEstimate: 0, toolName: null }],
    }],
    warnings: [],
  }),
});
```

Return `SessionDraft`s; the core assigns ids, computes the dedupe hash, derives
complexity/importance/kind and builds the search document. `parse` should never
throw — return a warning instead, and never lose a whole file to one bad line.

The helpers in `src/core/extract.ts` (`extractFromMessages`, `deriveTitle`,
`deriveSummary`, `detectTechnologies`) do the structural work for you.

### Exporter

```ts
api.contributeExporter({
  id: `${api.pluginId}:csv`,
  label: 'CSV index',
  description: 'One row per session.',
  extension: 'csv',
  multiFile: false,          // true ⇒ multiple sessions are zipped
  render: (sessions, options) => [{ path: 'index.csv', content: '…' }],
});
```

Exporters are pure: they return named text artifacts and never touch the
filesystem. Writing (including ZIP packaging) is the pipeline's job.

### Command

Commands appear in the palette, the shortcut list and — where relevant — the
context menu, all from one registration.

```ts
api.contributeCommand({
  id: `${api.pluginId}.sync`,
  title: 'Sync with Notion',
  category: 'Library',
  keywords: ['notion', 'pull'],
  shortcut: 'Mod+Alt+N',              // `Mod` = Cmd on macOS, Ctrl elsewhere
  when: (ctx) => ctx.selectedIds.length > 0,
  run: async (ctx) => { /* … */ },
});
```

### Panel

```ts
api.contributePanel({
  id: 'stats',
  title: 'Extra statistics',
  slot: 'session-sidebar',   // | 'session-tab' | 'galaxy-overlay' | 'settings'
  order: 50,
  render: (ctx) => renderSomething(ctx.session),
});
```

### Visualisation

An alternative way to view the library — a peer of the galaxy, not a bolt-on.

```ts
api.contributeVisualization({
  id: 'timeline-grid',
  label: 'Grid',
  description: 'A dense chronological grid.',
  mount: (container, host) => {
    const view = build(container, host.sessions);
    host.onSelect(null);
    return () => view.destroy();   // teardown
  },
});
```

---

## Storage and events

```ts
// Namespaced automatically — you cannot read another plugin's keys.
await api.storage.set('cursor', '2026-07-01');
const cursor = await api.storage.get('cursor');

// Read-only view of the library.
const sessions = await api.storage.listSessions();
const detail = await api.storage.getSession(id);

// Events. Automatically unsubscribed on deactivate.
api.on('library:changed', ({ reason, ids }) => { /* … */ });

api.notify('success', 'Synced 12 pages.');
api.log.info('cursor advanced', cursor);
```

Plugins get a deliberately narrow storage surface: full reads, namespaced
key/value writes, no direct session mutation. Anything that writes sessions goes
through the import pipeline, so deduplication and derivation cannot be bypassed.

---

## What plugins cannot do

**There are no network primitives in the API, deliberately.** Artix's premise is
that it works offline forever, and a plugin cannot change that through this
interface. A plugin that needs remote data should import a file the user
exported.

Plugins also cannot mutate sessions directly, register a duplicate plugin id, or
survive a failed activation with partial contributions in place.

---

## Registering

```ts
import { PluginHost } from '@/plugins/host.ts';

host.add(myPlugin);              // known, not yet active
await host.activate(myPlugin.id);
```

Built-ins are listed in `BUILTIN_PLUGINS` (`src/plugins/index.ts`) and added at
startup. Which plugins are *enabled* is persisted in `settings.plugins`;
`host.sync(enabledIds)` reconciles the two, and the Settings UI toggles are
wired to it.

---

## Testing a plugin

Plugins are plain objects, so they need no host to test:

```ts
import { describe, expect, it } from 'vitest';
import { myPlugin } from './my-plugin.ts';

it('registers an importer', async () => {
  const contributions: unknown[] = [];
  await myPlugin.activate({
    version: '0.1.0',
    pluginId: myPlugin.id,
    contributeImporter: (i) => { contributions.push(i); return () => {}; },
    // …stub only what the plugin actually calls
  } as never);

  expect(contributions).toHaveLength(1);
});
```

For an integration test, use `MemoryStorageAdapter` with a real `PluginHost` —
that is exactly what the application does in the browser build.

---

## Conventions

| | |
| --- | --- |
| Plugin id | reverse-DNS: `acme.notion-sync` |
| Contribution id | prefix with `api.pluginId` to avoid collisions |
| Version | semver; `requires` supports `>=x.y.z` |
| Errors | return warnings, do not throw |
| Side effects | only inside `activate`, never at module scope |
