# Architecture

## The one-sentence version

A pure TypeScript domain core, a swappable storage adapter, a search engine that
works identically over SQLite FTS5 or an in-memory index, and a GPU-driven
renderer that the React tree never touches per frame.

---

## Layering

Dependencies point strictly downward. Nothing in a lower layer imports from a
higher one.

```
                    ┌──────────────────────┐
                    │         ui/          │  React components
                    └──────────┬───────────┘
                    ┌──────────┴───────────┐
                    │        state/        │  zustand stores, app container
                    └──────────┬───────────┘
        ┌──────────────┬───────┴───────┬──────────────┐
        │  commands/   │   plugins/    │  renderer/   │
        └──────┬───────┴───────┬───────┴──────┬───────┘
        ┌──────┴───────┬───────┴───────┬──────┴───────┐
        │  importers/  │  exporters/   │   search/    │
        └──────┬───────┴───────┬───────┴──────┬───────┘
                    ┌──────────┴───────────┐
                    │       storage/       │  StorageAdapter interface
                    └──────────┬───────────┘
                    ┌──────────┴───────────┐
                    │        core/         │  zero dependencies
                    └──────────────────────┘
```

`core/` imports nothing — not React, not Three.js, not the storage layer. That
constraint is what makes the domain logic testable in isolation and is why the
test suite runs in ~3 seconds with no DOM.

---

## Storage: one interface, two implementations

```ts
interface StorageAdapter {
  init(): Promise<Result<LibraryStats>>;
  listSessions(filters?): Promise<Result<Session[]>>;
  search(query: ParsedQuery): Promise<Result<SearchResult>>;
  saveSessions(details: SessionDetail[]): Promise<Result<ImportOutcome>>;
  /* …plus filesystem operations, gated by `capabilities.filesystem` */
}
```

| | `TauriStorageAdapter` | `MemoryStorageAdapter` |
| --- | --- | --- |
| Persistence | SQLite, WAL | JS maps (+ trimmed localStorage) |
| Full text | FTS5, BM25 | inverted index |
| Filesystem | native, user-picked paths | unsupported, reports it clearly |
| Used by | the desktop app | browser preview, tests, demo data |

The in-memory adapter is not a mock. It is a complete, correct implementation
that the conformance tests in `src/storage/storage.test.ts` treat as the
executable specification of the contract. That is what lets the entire
application be developed and tested without a Rust toolchain.

### Why a single write connection

SQLite in WAL mode serialises writers anyway, and every Artix write is a short
transaction. A connection pool would add lifecycle complexity and lock-ordering
hazards without adding throughput. `Database::with()` holds a mutex; a poisoned
mutex is recovered rather than propagated, because the WAL is still consistent.

---

## Search: a hybrid, not a fallback chain

Text matching, filtering and ranking are three separate concerns, and only the
first differs between backends.

```
  query string
      │
      ▼
  parseQuery()            ── the `key:value` DSL, quotes, negation, dates
      │
      ├─── desktop ──►  buildFtsMatch() ──► SQLite FTS5 ──► [id, bm25][]
      │                        │
      │                        └── zero hits? ──┐
      │                                          ▼
      └─── browser  ──────────────────►  InvertedIndex (fuzzy expansion)
                                                 │
      ┌──────────────────────────────────────────┘
      ▼
  compileFilters()        ── one closure, one linear pass over cached sessions
      │
      ▼
  combineScore()          ── 0.62·relevance + 0.23·recency + 0.15·importance
      │
      ▼
  sortHits() + highlight
```

FTS5 is fast and scales to full transcripts but has no typo tolerance. The
desktop adapter therefore also keeps a *shallow* in-memory index (titles,
projects, summaries, tags, technologies — a few MB even at 100k sessions) purely
to supply fuzzy candidates when FTS5 finds nothing. `galxy rendrer` still lands
on the right star.

Filtering and ranking always run in TypeScript against the cached session list,
which is why results are ordered identically in both backends — and why the
galaxy, which needs that list anyway, gets search for free.

### Ranking

Pure text relevance is the wrong answer for a memory tool. Searching "auth bug"
should surface last Tuesday's session over an equally relevant one from two
years ago — but not so aggressively that a perfect old match is buried. Hence
the fixed blend above, with a 90-day recency half-life and a bounded lift for
pinned sessions.

---

## The renderer

### Everything is derived

`src/core/celestial.ts` is the single source of truth for complexity,
importance and celestial kind. `src/renderer/layout.ts` is the single source of
truth for position. Both are pure functions of stored data, so the galaxy is
byte-identical on every launch and on every machine — `Math.random()` is banned
anywhere near the renderer.

### One draw call

The whole library is a single `THREE.Points`. Per-node attributes are static:

| Attribute | Contents |
| --- | --- |
| `aOrbit` | day, base angle, height, epicycle phase |
| `aTraits` | size, brightness, kind, pinned |
| `aColor` | language colour |
| `aHighlight` | search highlight, 0..1 |

The vertex shader computes the actual world position from those plus `uNowDay`,
`uSpanDays` and `uElapsed`. Consequences:

- rotation, epicycles and **timeline reorganisation** cost zero CPU;
- scrubbing the timeline is a uniform write, not a geometry rebuild;
- 100k nodes upload once as 6 MB of typed arrays.

`frustumCulled = false` and `boundingSphere = null`, because the CPU-side
positions are placeholders and any culling decision made from them would be
wrong.

### The duplicated formula

The layout formula exists twice: in TypeScript for hit-testing and labels, and
in GLSL for rendering. This is a deliberate trade — the alternative is
round-tripping GPU state back to the CPU every frame.

The risk is drift, so it is contained:

1. every constant lives in `LAYOUT` and is injected into the shader as a
   `#define` by `layoutDefines()`;
2. `renderer.test.ts` asserts the injected defines match `LAYOUT` exactly, and
   that they are GLSL-valid float literals (`9.0`, never `9`);
3. both implementations carry a comment pointing at the other.

### Picking without a GPU readback

GPU picking would need a readback and a pipeline stall. Instead:

1. intersect the view ray with the galactic plane (the disk is thin, so this is
   an excellent approximation) — falling back to sampling along the ray when the
   view is edge-on;
2. query a uniform 2D hash grid around that point;
3. project the handful of candidates and take the nearest in screen space,
   weighted so brighter stars win ties.

The grid is built in *static* space with the pattern rotation removed. Because
that rotation is rigid, queries inverse-rotate the query point instead of the
index being rebuilt every frame. Only a timeline scrub — which changes radii —
invalidates it. Measured cost: **0.66 ms per pick at 100k nodes**.

### Sizing

The drawing buffer is synced to the canvas's CSS size **in the render loop**, not
solely from a `ResizeObserver`. Observers do not fire in every environment (some
embedded webviews and headless renderers never deliver the initial
notification), and a galaxy rendering into a 1×1 buffer is a silent, total
failure. Comparing two integers per frame is free.

### Adaptive quality

`AdaptiveQuality` watches a rolling median and p90 of frame time. It steps down
one tier when the budget is consistently missed, steps up far more reluctantly,
and **never returns to a tier that already failed** — visible pumping between
settings is worse than simply sitting one tier lower.

---

## Data flow for an import

```
file → ImportSource → registry.detect() → importer.parse() → SessionDraft[]
                                                                   │
                                        computeSessionHash() ──► dedupe
                                                                   │
                                              buildSession() → SessionDetail
                                                                   │
                                            buildDocument() → SearchDocument
                                                                   │
                                        storage.saveSessions()  → SQLite + FTS5
                                                                   │
                                        bus.emit('library:changed')
                                                                   │
                              library store refresh → GalaxyNode[] → renderer
```

Deduplication happens *before* the write, so re-importing 5,000 files costs one
hash lookup each rather than 5,000 failed inserts.

---

## Extensibility

Registries, not switch statements:

| Registry | Contribution |
| --- | --- |
| `ImporterRegistry` | new source formats |
| `ExporterRegistry` | new output formats |
| `CommandRegistry` | new actions (palette, shortcuts, context menu, all at once) |
| `PluginHost` | panels, visualisations, and all of the above |

Built-in importers and exporters register through exactly the same call a
plugin uses. `src/plugins/builtin/csv-index.ts` is a working example that adds
a real feature without touching the core.

`PluginHost` tracks every contribution a plugin makes and disposes all of them
on deactivate, so enabling and disabling a plugin is exactly reversible. A
plugin that throws during activation is rolled back and reported rather than
taking the application down.

---

## Design decisions worth knowing

**No markdown renderer.** Message bodies render code fences as `<pre>` and
everything else as plain text. A full markdown pipeline is a large dependency
and an injection surface for third-party imported content; code fences are the
only formatting that materially changes comprehension.

**Notes are never overwritten.** Re-importing a session updates extracted
content but leaves user notes alone, and notes are weighted heavily in search.
They are the one field only the human can produce.

**`Result<T, E>` at trust boundaries.** IPC, files and plugins return `Result`
rather than throwing. Exceptions are reserved for genuine programmer error.

**ULID-shaped ids.** Lexicographically sortable by creation time, so SQLite
indexes give chronological ordering for free and debugging is far easier than
with opaque UUIDs.

**Timestamps are epoch milliseconds, everywhere.** Formatting happens only at
the very edge, in the UI. The renderer converts to *days since a fixed epoch*
because epoch milliseconds do not survive `float32`.

**The context bundle budgets by priority, not by truncation.** Content is added
in strict value order and the first section that does not fit ends the bundle.
Decisions and open todos therefore survive when the transcript does not — they
are the parts that cannot be recovered from the code.
