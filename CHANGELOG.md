# Changelog

All notable changes to Artix are recorded here. Dates are UTC.

## v0.1.1 — 2026-07-24

The first release built entirely from the source people can download, and the
release where Claude Code sync became automatic.

### Added

- **Automatic Claude Code sync.** After the first import, Artix keeps itself
  current — an incremental scan shortly after launch and every 10 minutes while
  open, importing only transcripts whose modification time changed. On by
  default; adjustable or off in Settings → Import. Everything stays local.
- **Instant sync (opt-in).** Settings → Import can install a `SessionEnd` hook
  into `~/.claude/settings.json`; a finished session then appears within a
  second or two instead of at the next timer tick. Only Artix's own hook entry
  is touched, and it runs a local command — nothing is sent anywhere.
- **Resume in Claude Code.** Select a session and press
  `Ctrl/Cmd+Shift+R` to write a budgeted briefing into that project's
  `CLAUDE.md`, so your next session there starts already briefed. Your own
  content in the file is preserved.
- **Always-visible "Import sessions" button** in the toolbar.
- **Prebuilt installers** for Windows, macOS (Apple silicon + Intel) and Linux,
  built and attached automatically on each tagged release.

### Changed

- **Sessions update in place instead of duplicating.** Identity is now the
  source's own session id, so a transcript that grows between syncs refreshes
  the existing record. Your notes and pinned state survive the refresh.
- **Sub-agent transcripts** attach to their parent session as searchable notes
  rather than importing as empty standalone sessions.
- Language detection no longer misreads agent transcripts as `json` — data and
  markup formats are damped so the primary language reflects real code.

### Fixed

- **Memory-bounded import.** Large session stores are read and imported in
  batches, so a first sync of a gigabyte of transcripts no longer risks running
  out of memory.
- A visible window no longer flashes when the instant-sync hook fires.
- CI now builds the frontend before Rust, matching a clean checkout.

## v0.1.0 — 2026-07-23

Initial release. Local-first archive of Claude Code sessions with SQLite FTS5
search, the galaxy renderer, import/export, the context-bundle exporter, and the
plugin system.
