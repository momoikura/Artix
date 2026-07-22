# Installation

## Quick start

```bash
git clone <this-repo> artix
cd artix
npm install
npm run dev          # browser preview at http://localhost:5173
```

That is enough to explore the galaxy, search, import files and try every part of
the UI. It uses an in-memory storage adapter, so **data does not persist beyond
trimmed localStorage** — for a real archive you want the desktop build.

---

## Desktop build

### 1. Node.js

Node **20.19+** or **22+**. Check with `node --version`.

### 2. Rust

Install from [rustup.rs](https://rustup.rs), then confirm:

```bash
rustc --version   # 1.77.2 or newer
cargo --version
```

`cargo` must be on your `PATH`. On Windows you may need to restart your
terminal after installing.

### 3. Platform prerequisites

**Windows**
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the "Desktop development with C++" workload.
- WebView2 — already present on Windows 10 1803+ and all Windows 11. The
  installer bundles a bootstrapper for older systems.

**macOS**
```bash
xcode-select --install
```
macOS 10.15+. For universal binaries: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

**Linux (Debian/Ubuntu)**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Linux (Fedora)**
```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
sudo dnf group install "C Development Tools and Libraries"
```

**Linux (Arch)**
```bash
sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg
```

### 4. Icons

The repository ships no binary assets. Generate the icon set once:

```bash
npm run icons
```

This draws a 1024×1024 master procedurally with Node's `zlib` (no image
libraries), then expands it into every platform format via `tauri icon`.

### 5. Run and build

```bash
npm run dev:desktop     # hot-reloading desktop app
npm run build:desktop   # installers for the current platform
```

Artifacts land in `src-tauri/target/release/bundle/`:

| Platform | Output |
| --- | --- |
| Windows | `msi/*.msi`, `nsis/*.exe` |
| macOS | `dmg/*.dmg`, `macos/*.app` |
| Linux | `deb/*.deb`, `appimage/*.AppImage`, `rpm/*.rpm` |

The first Rust build compiles SQLite from source and takes several minutes.
Later builds are incremental.

---

## Where your data lives

A single SQLite file plus its WAL sidecars:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\dev.artix.desktop\artix.db` |
| macOS | `~/Library/Application Support/dev.artix.desktop/artix.db` |
| Linux | `~/.local/share/dev.artix.desktop/artix.db` |

**Portable / second library.** Set `ARTIX_DATA_DIR` to use any directory —
useful for a USB stick or for keeping a test archive separate:

```bash
ARTIX_DATA_DIR=/media/usb/artix npm run dev:desktop
```

**Backups.** Settings → *Export entire library (JSON)* writes a complete,
re-importable archive. Copying `artix.db` also works, but stop the app first or
use the built-in backup command so the WAL is checkpointed.

---

## Offline guarantee

Artix makes no network requests at runtime, and the Rust backend links no HTTP
client. After installation you can disconnect permanently.

Two things do need the network, both **before** you ship:

1. `npm install` — downloads dependencies.
2. The first `cargo build` — downloads and compiles crates.

To build on a machine that is already offline, vendor both first:

```bash
# on a connected machine
npm ci
cd src-tauri && cargo vendor > vendor-config.toml

# copy node_modules/ and src-tauri/vendor/ across, then append
# vendor-config.toml to src-tauri/.cargo/config.toml on the target machine
```

`tauri.conf.json` sets a strict CSP with no remote origins, so even a
compromised dependency in the frontend cannot exfiltrate anything from the
webview.

---

## Verifying an installation

```bash
npm run typecheck   # strict TypeScript, no errors
npm test            # 153 unit tests
npm run build       # production bundle
cd src-tauri
cargo check --all-targets   # backend compiles clean
cargo test                  # 23 storage tests: FTS5, cascades, injection, wire shape
```

The Rust suite exercises the real SQL against an in-memory database: FTS5
ranking and operators, cascade deletes, dedupe on `content_hash`, parameter
binding under hostile input, and the exact JSON shape errors serialise to. It
also checks that the linked SQLite really has FTS5 compiled in — Artix verifies
this at startup too, and refuses to open a library with a clear message rather
than failing later at the first search.

### Running the Rust tests on the GNU target

`cargo test` works out of the box on the MSVC target, which is what Artix ships.
If you are using `x86_64-pc-windows-gnu` instead, the test binary links the full
Tauri stack and needs three things beside it in `target/debug/deps/`:

```bash
cp "$MINGW/bin/libgcc_s_seh-1.dll" "$MINGW/bin/libwinpthread-1.dll" \
   "$MINGW/bin/libstdc++-6.dll" src-tauri/target/debug/deps/
cp ~/.cargo/registry/src/*/webview2-com-sys-*/x64/WebView2Loader.dll \
   src-tauri/target/debug/deps/
```

Watch for older `libwinpthread-1.dll` copies shipped by Git for Windows or the
Android SDK appearing earlier on `PATH` — they cause a
`STATUS_ENTRYPOINT_NOT_FOUND` at test startup. Staging the correct DLLs next to
the binary wins, because an executable's own directory is searched first.

---

## Troubleshooting

**`cargo: command not found`** — Rust is not on your `PATH`. Restart your
terminal, or `source "$HOME/.cargo/env"`.

**`error: linker 'cc' not found`** (Linux) — install `build-essential` or your
distribution's equivalent.

**`webkit2gtk-4.1 not found`** (older Linux) — some distributions still ship
`4.0`. Either install the 4.1 development package from backports, or pin
`tauri` to a version built against 4.0.

**Blank window on launch** — open the devtools with `Ctrl/Cmd+Shift+I`. A
failure to open the database is reported in the window itself, not silently.

**Search returns nothing after an edit** — Settings → *Reindex*. It is safe to
run at any time and rebuilds the FTS index from the stored sessions.

**Poor frame rate** — Settings → Rendering. Automatic quality already steps
down on its own, but nebula and depth of field are the two most expensive
effects and can be turned off independently.
