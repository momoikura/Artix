# Contributing to Artix

Thanks for considering it. Artix is small and opinionated, so this document is
mostly about the opinions — following them makes review fast.

## Setup

```bash
npm install
npm run dev        # browser preview, no Rust needed
npm test           # 162 frontend tests, ~2s
```

For the desktop backend you also need the [Rust toolchain](https://rustup.rs)
and your platform's Tauri prerequisites — see [docs/INSTALL.md](docs/INSTALL.md).

```bash
npm run dev:desktop
cd src-tauri && cargo test    # 23 storage tests
```

## Before opening a PR

```bash
npm run typecheck    # strict, must be clean
npm test
npm run build
cd src-tauri && cargo check --all-targets && cargo test
```

CI runs exactly these. If they pass locally they pass there.

## The rules that actually matter

**`src/core/` imports nothing.** Not React, not Three.js, not the storage layer.
That constraint is what keeps the domain testable in isolation. If you find
yourself wanting an import there, the logic probably belongs a layer up.

**Both storage adapters stay in sync.** `MemoryStorageAdapter` is not a mock —
it is a complete implementation, and `src/storage/storage.test.ts` is the
executable specification of the contract. A change to one adapter's semantics
needs the same change in the other.

**The layout formula exists twice.** Once in `src/renderer/layout.ts` for
picking, once in GLSL for rendering. They must agree or hit-testing silently
targets the wrong stars. Constants live in `LAYOUT` and are injected into the
shader as `#define`s; `renderer.test.ts` pins that. Change them together.

**Nothing random in the renderer.** `Math.random()` is banned anywhere near
`src/renderer/`. Every position derives from a seeded hash so the galaxy is
identical on every launch and every machine.

**No network primitives.** Artix works offline, permanently. Do not add an HTTP
client, a telemetry hook, or a plugin API that would allow one. This is the
product's core promise, not a preference.

**Importers never throw.** Return a warning instead. One malformed line must
never lose a 4,000-message transcript.

## Code style

- Strict TypeScript. No `any`, no non-null assertions on values you have not
  actually checked.
- Comments explain **why**, not what. If a comment restates the code, delete it.
- Errors that cross a trust boundary (IPC, files, plugins) return `Result`
  rather than throwing. Exceptions are for programmer error.
- Timestamps are epoch milliseconds, UTC, everywhere. Format only at the UI edge.

## Tests

New behaviour needs a test. Prefer tests that would fail for a real reason —
`filters_are_parameterised_against_injection` fires a `DROP TABLE` through the
project filter and asserts the table survives. That is worth writing. A test
asserting a getter returns what you just set is not.

## Adding an importer

Do it as a plugin first — the built-ins register through exactly the same API
(`src/plugins/builtin/csv-index.ts` is a working example). If it turns out to be
broadly useful, we can move it into `src/importers/`.

Be honest in `detect()`: return `0` rather than a hopeful `0.3` when the content
is clearly something else. An over-eager importer steals files from a correct one.

## Commits

Present tense, imperative, explain the why in the body when it is not obvious:

```
Damp incidental languages in the primary-language vote

Agent transcripts serialise tool calls as JSON, which outweighed real
code by an order of magnitude and made every session read as "json".
```

## Reporting bugs

Include your OS, whether it is the desktop or browser build, and — if it is a
rendering issue — the quality tier from Settings and the FPS reading in the HUD.

**Never paste session content into an issue.** Your transcripts are private;
describe the shape of the problem instead.
