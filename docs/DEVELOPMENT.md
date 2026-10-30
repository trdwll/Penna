# Developing Penna

Tauri v2 app: a Rust backend (`src-tauri/`) and a React 19 + TypeScript frontend (`src/`) with CodeMirror 6 as the
editor and Tailwind CSS v4 for styling. Fonts are bundled (Fontsource), so it works offline and under the CSP.

## Layout

```
src/                         Frontend (webview)
├── App.tsx                  Shell state: vault, open note, views, Git, shortcuts
├── services/tauri.ts        Typed IPC wrappers, events, window controls, dialogs
├── editor/                  CodeMirror: Preview decorations, tables, embeds, insert menu, conflicts, Changes
├── components/              Views and panels (Notes, Search, Tags, Today, History, Settings, dialogs)
└── lib/                     Helpers: paths, dates, settings, tags, templates, export, diffs, update check
src-tauri/                   Backend (Rust)
├── tauri.conf.json          Frameless window, CSP, bundle
├── capabilities/            Window, dialog and opener permissions
└── src/
    ├── lib.rs               AppState, #[tauri::command] handlers, builder, portable mode
    ├── vault.rs             Tree scan, path validation, atomic I/O, rename/delete, backlinks
    ├── order.rs             Notes and folders arranged by hand (.penna/order.json)
    ├── links.rs             Finding and rewriting links (wiki + relative Markdown)
    ├── attachments.rs       Saving, importing and opening attachments; the penna: scheme
    ├── git.rs               Status, commit, pull/push/sync, merges, history
    ├── search.rs            Full-text search (words, phrases, tags)
    ├── tags.rs              #tags and front-matter tags; renaming a tag everywhere
    ├── mentions.rs          Unlinked mentions and linking them
    ├── export.rs            Images into exported pages; PDF through WebView2
    ├── watcher.rs           Debounced file watcher → "vault:changed"
    └── error.rs             AppError → String at the IPC boundary
```

## Architecture

**Threading.** Every command is `async` and moves disk, libgit2 and network work onto tokio's blocking pool, so the
UI never waits on I/O. A tokio mutex serializes Git writes; reads like status don't take it.

**Paths.** Everything crossing IPC is vault-relative with `/` separators. `vault::resolve` rejects absolute paths,
drive prefixes, `..`, and hidden segments (which also protects `.git/`).

**Editor.** CodeMirror edits the Markdown text directly. Preview hides the syntax with decorations instead of
converting to rich text, so files are saved exactly as written and Git diffs only show real edits. Mode and Changes
are swapped through compartments, so toggling keeps undo history, cursor and scroll. Changes uses
`@codemirror/merge` against the note as it was at the last sync.

**Vault-wide features** (backlinks, mentions, tags, search) read the notes on each call. That's fine for a few
thousand notes; a persistent index can replace it later without changing the IPC shapes.

**Files.** The `penna:` URI scheme (`http://penna.localhost/…` on Windows) serves vault files to the editor's
images; it only serves files inside the open vault and sends SVGs with a sandboxing CSP. The watcher emits
`vault:changed` with `{ paths }`.

**Settings.** App settings live in the webview's local storage (this PC); vault settings live in
`.penna/settings.json` and sync with the notes, as does `.penna/order.json`: for each folder arranged by hand,
the names in it in order (`scan_tree` applies it, so links resolve in the same order the sidebar shows; names not
listed follow A to Z; renames, moves and deletes in Penna keep it current). A file named `portable` next to the Windows exe moves the webview's
data into a `data` folder beside it.

**Updates.** `src/lib/updates.ts` fetches `api.github.com/repos/trdwll/Penna/releases/latest` (the one outside
host in the CSP's `connect-src`) 5 s after start and then at most once a day, compares its tag with the app's version
in semver order, and remembers the answer in local storage. It only links to the release page; nothing downloads or
installs. GitHub answers 404 while there are no releases or the repository is private, which the app shows as "No
releases on GitHub yet". Settings → General turns the automatic check off; "Check now" and the command still work.

## Sync

- **Sync** = stage everything → commit if anything changed → pull → push. Without a remote it only saves a version.
- **Pull never overwrites uncommitted work.** Merges are computed in memory first. When edits overlap, Sync saves
  yours as a version, writes Git's standard conflict markers and pauses; the app shows each place as a choice, and
  **Finish sync** commits the merge with both parents.
- **Auth:** ssh-agent, then `~/.ssh/id_*` keys, then Git Credential Manager.
- **Automatic sync** runs on a timer or after you stop typing, pulls when a vault opens, and syncs when Penna closes.

## Commands

The IPC surface is typed in `src/services/tauri.ts` (the `Commands` map) and implemented in `src-tauri/src/lib.rs`.
Every command returns `Result<T, String>`; errors are already worded for people.

## Tests

- `cd src-tauri && cargo test`: backend tests, including real push/pull/merge against a local bare repo.
- `npx tsc --noEmit -p .`: type check.
- End-to-end checks drive a running app over the Chrome DevTools protocol (WebView2's
  `--remote-debugging-port`) with a throwaway `WEBVIEW2_USER_DATA_FOLDER`, so a real vault is never touched.

Code style: Prettier at width 140 (`.prettierrc`) for files you touch, `cargo fmt` and `cargo clippy` for Rust.

## Releases

`.github/workflows/release.yml` runs on every push to `release`: it checks that the three version numbers agree and
are new, builds the Windows installer and portable zip and the Linux `.deb`, `.rpm` and `.AppImage`, then tags the
commit and publishes a GitHub release with checksums. Lint it with
`docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:latest`.
