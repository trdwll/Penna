# Penna

A local-first Markdown notebook. Your notes are plain `.md` files in a folder you choose, every version is kept
with Git, and sync goes to a Git remote you control. For Windows and Linux.

## Download

Get the latest build from [Releases](../../releases/latest).

| | Windows | Linux |
| --- | --- | --- |
| Install | `Penna_<version>_x64-setup.exe` | `.deb` or `.rpm` |
| Portable | `Penna_<version>_x64-portable.zip` (settings stay in its `data` folder) | `.AppImage` |

The builds aren't signed yet, so Windows may warn about an unknown publisher: choose **More info → Run anyway**.

## What it does

- **Write** in Preview, where formatting shows as you type and the file stays plain Markdown, or in Source. Tables,
  images, `![[note]]` embeds, `==highlight==`, a `/` insert menu, and blocks you can drag around.
- **Find** anything with the quick switcher (Ctrl+P), full-text search (including text you've since deleted), a tags
  view, backlinks, and notes that mention this one without linking it.
- **Daily notes and templates**, with unfinished tasks carried over to the next day.
- **History and sync**: see what changed since your last version, restore old text, and sync with any Git remote.
  When two devices edit the same lines, you choose what to keep.
- **Organize** by renaming and moving notes and folders; links across the vault update themselves.
- **Two notes side by side**, and **export** to HTML or PDF.

## Keyboard

| Keys | |
| --- | --- |
| Ctrl+P | Go to a note, heading or tag (`>` for commands) |
| Ctrl+N / Ctrl+Shift+N | New note / new note from a template |
| Ctrl+D | Today's note |
| Ctrl+Shift+F | Search |
| Ctrl+Shift+T | Tags |
| Ctrl+E | Switch Preview / Source |
| Ctrl+Shift+E | Show what changed |
| Ctrl+\\ | Open a note beside this one, or close it |
| Ctrl+Shift+S | Sync |
| F2 | Rename the note |
| / | Insert menu (at the start of a line) |
| [[ | Link to a note |

Settings → Shortcuts lists the rest.

## Build from source

```sh
npm install
npm run tauri dev     # run with hot reload
npm run tauri build   # installers in src-tauri/target/release/bundle
cd src-tauri && cargo test
```

You need Node 22, stable Rust, and Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/): on Windows
the C++ build tools and WebView2; on Linux `libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`,
`libssl-dev` and `libxdo-dev`.

How the code fits together is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Releasing

`main` is for development. Bump the version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`, then push to `release`:

```sh
git push origin main:release
```

The release workflow builds Windows and Linux packages, tags the commit `v<version>`, and publishes them as a
GitHub release. It stops early if that version was already released.
