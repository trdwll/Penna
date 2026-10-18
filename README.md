# Penna

A local-first Markdown notebook for Windows. Notes are plain `.md` files in a
folder you choose (the *vault*); every version is kept by Git and synced to a
remote you control.

- **Desktop shell:** Tauri v2 (custom title bar, no native frame)
- **Backend:** Rust (`git2`, `notify-debouncer-mini`, `walkdir`, `serde`, `tokio`, `trash`)
- **Frontend:** React 19 + TypeScript + Vite, Tailwind CSS v4, CodeMirror 6
- **Design:** "Margin". Writing comes first: a typeset page, quiet chrome, and
  structure (`##`, change marks, line numbers) hanging in the left margin.
  Design canvas: https://claude.ai/artifact/Gr1qQK8AcjeT8G7cGNzKk5 (private)

---

## Status

**Milestone 1, the Notes view, is built:**

- Title bar: vault switcher, Preview / Source switch, Changes toggle, save state, sync pill, window controls
- Left rail: Notes, Search, Today, History, Settings
- Notes panel: the vault as a table of contents, find-a-note (Ctrl+K), new note (Ctrl+N), dots on changed notes
- Editor
  - **Preview** is the WYSIWYG mode. Markdown syntax is hidden except on the line you're editing; `##` hangs in the margin; checkboxes, bullets, links, wiki links, quotes, rules and code blocks render; front matter shows as tag chips.
  - **Source** is the raw Markdown in DM Mono.
- **Changes** (Ctrl+Shift+E): what changed since your last sync. Inline in Preview, a line diff with line numbers in Source. Includes next/previous change (Alt+↑/↓) and "undo changes since…".
- Right margin: outline, backlinks ("Linked from"), version count
- Auto-save, Sync (save version → pull → push), external-change reload, CRLF preservation

**Milestone 2, the editing tools, is built:**

- Selection toolbar in Preview: paragraph/heading/quote, bold, italic, strikethrough, inline code, web link, note link
- Shortcuts: Ctrl+B, Ctrl+I, Ctrl+Shift+X (strikethrough), Ctrl+` (code)
- `/` at the start of a line opens the insert menu (headings, lists, checklist, quote, table, code block, note link, divider). Each item shows its Markdown shortcut.
- `[[` suggests notes from the vault
- "+" in the margin beside the current line opens the insert menu
- GFM tables render as tables in Preview; clicking a cell edits that row's Markdown

**Milestone 3, Today and History, is built:**

- **Today** (rail or Ctrl+D) opens `Journal/YYYY-MM-DD.md`, creating it from `Templates/Daily.md` or a built-in Focus / Log template. (Folder, template and title format are settings.)
  - Unfinished tasks from the last daily note are copied in under "Carried over from …".
  - The calendar marks days with notes; picking an empty day offers to start it.
  - The margin shows notes also edited today. Previous/next day links sit at the foot of the page.
  - Log lines starting with a time (`09:41 …`) hang the time in the margin. The `/` menu has **Time**.
  - Daily notes are listed by date ("Saturday, Oct 17") everywhere.
- **History** (rail) shows "Not synced yet" plus every saved version, grouped by day.
  - Each version's changes read as prose: added, removed, and words changed within a line. Unchanged stretches fold away.
  - **Restore these notes…** writes old text back without rewriting history; the next sync saves it as a new version.
  - **Compare with now** opens a note with Changes against that version.
- **Version picker**: the Changes bar can compare against any older version of the note, not just the last sync.

**Milestone 4, Search and Settings, is built:**

- **Search** (rail or Ctrl+Shift+F) searches as you type. Every word must appear; "quoted phrases" match exactly.
  - Filters: titles only, folders (with counts), edited this week / month, tags (front matter and `#inline`). Sort by best match or recently edited.
  - ↑/↓ and Enter open a result with the match selected.
  - **Older versions too** finds text that's since been removed or deleted, and opens the note compared with the version that had it.
- **Settings** (rail or Ctrl+,). Penna settings stay on this PC; vault settings live in `.penna/settings.json` and sync with the notes.
  - General: switch vault, reopen the last vault, where new notes go (vault root, Inbox, or the current note's folder).
  - Editor: open notes in Preview or Source, writing font (Newsreader / Hanken Grotesk / DM Mono), text size (headings scale with it), line width, spell check, keep Windows line endings.
  - Appearance: Match Windows / Light / Dark, margin Markdown marks on or off.
  - Sync: connect or change the remote, test the connection, sync automatically (every 5 / 15 / 60 minutes or after you stop typing), get changes when Penna opens, sync when it closes, the device name, the name on saved versions for this vault, the automatic version message.
  - Daily notes: folder, template, title format, carry over unfinished tasks.
- Each automatic version ends with a `Device: …` line, and History shows which device saved it.

**Milestone 5, side-by-side Changes, is built:**

- In Source, the Changes bar switches between **Unified** and **Side by side** (also in Settings → Editor; Penna remembers the choice).
- Side by side puts the note as it was on the left (read-only) and the note now on the right, which you keep editing. Lines stay aligned; hatched filler sits opposite added or removed lines; line numbers are colored by change; unchanged stretches fold into "Show N unchanged lines" across both columns.
- Switching layouts keeps the cursor and undo history. Preview always shows Changes inline.

**Milestone 6, rename, move and delete, is built:**

- Right-click a note in the Notes panel, or use **⋯** at the top right of the page: **Rename** (F2), **Move to…**, **Delete…**. A focused note in the panel also takes F2, Delete and the menu key.
- **Rename** edits the name in place in the Notes panel. Typing `Folder/Name` renames and moves in one go. A taken name or an invalid one shows an error under the field.
- **Move to…** lists the vault's folders (type to filter). Typing a folder that doesn't exist offers to create it.
- Links follow the note: `[[Name]]`, `[[folder/Name|label]]`, `[[Name#Heading]]`, `![[Name]]` and relative Markdown links (`[text](../Other%20note.md)`) are rewritten across the vault, keeping labels, headings and `%20` or `<…>` style. Name-only links stay name-only unless another note has the same name; then they get the path. Links inside code are left alone. A moved note's own relative links are fixed for its new folder. The toast says how many links changed.
- When the note's first line is a `# Heading` with the old name, the heading takes the new name too.
- **Delete…** asks first, says how many notes link to it, and moves the note to the Recycle Bin. Saved versions stay in History. Folders left empty by a move or delete are removed.
- Git sees a rename as a rename: Changes compares a renamed note with its old name, and the margin's version count and "compare with" list follow it back through renames.
- "Linked from" now counts relative Markdown links too, resolved the same way as the editor and the rewriter (links in code don't count).

**Milestone 7, editing extras, is built:**

- **`==highlight==`**: part of the Markdown grammar (like `~~strike~~`), shown as a highlighter stroke in Preview. In the selection toolbar after a divider, and Ctrl+Shift+H.
- **Block grip**: in Preview, a six-dot grip sits beside the "+" in the margin. Drag it to move the paragraph, heading, table, code block, quote or list item; a line shows where it will land, and the page scrolls near the edges. Click it for **Move up**, **Move down**, **Duplicate** and **Delete**. Ctrl+Shift+↑/↓ moves the block at the cursor in both Preview and Source.
  - Top-level blocks move among top-level blocks; list items move within their list (with what's nested under them). The spacing between blocks stays as it was, numbered lists keep counting 1, 2, 3, and Ctrl+Z puts a block back.
- **Images**: `![alt](path)` and Obsidian-style `![[photo.png]]` show the picture in Preview. On the line you're editing, the Markdown shows with the picture below it. Missing images say so. Web images (`https:`) show too.
- **Attachments**: paste an image (a screenshot, say), drop files from Explorer onto the page, or pick **Image or file** in the `/` menu. Files are copied into the vault's attachments folder (Settings → Attachments, default `Attachments`; empty keeps them next to the note) with a name that never overwrites anything, and linked with an ordinary relative Markdown link. Images get their own paragraph. Files that are already in the vault are linked where they are.
- Clicking a link to a PDF or other file (`[report](Attachments/report.pdf)` or `[[report.pdf]]`) opens it in its default app. Programs and scripts are only shown in Explorer, never run.
- Moving a note keeps its image and file links working. Folders that hold no notes (like the attachments folder) don't show up in the Notes panel.

**Milestone 8, sync conflicts as a choice, is built** (canvas row "Margin — when two devices edit the same note"):

- When two devices changed the same lines, Sync doesn't fail any more. It saves your edits as a version, writes the merge into the folder with Git's standard conflict markers (labelled with each device's name), and pauses. Everything that didn't overlap is already merged.
- The sync pill turns to **Sync paused · N to choose**, and the Notes panel lists the notes under **Changed on both devices**, with how many places are left in each.
- **Preview** shows each place as a card with both versions ("This PC · 09:41" and "Laptop · 09:52") and the words that differ highlighted. **Keep this** on either side, **Keep both**, or **Edit them together** (keeps both, selected, to merge by hand). A choice leaves "Kept Laptop's version · Undo" until you edit there. Alt+↑/↓ goes to the next place.
- **Source** shows the marked lines as they are on disk, tinted, with the same choices above them; deleting the markers by hand works too, and so does any other editor or Git tool.
- The margin lists the places in this note and the rest of the sync. **Finish sync** (in the margin, the bar on the page, or the pill) saves the merge as a version with both devices' versions as parents and sends it. **Stop this sync…** puts the notes back as they were; the other device's changes wait for the next sync, and edits you made to other notes meanwhile stay.
- Conflicts markers can't express are settled without losing anything: an image or file both devices changed keeps this device's copy and gets the other beside it (`photo (from Laptop).png`); a note deleted on one device and edited on the other keeps the edit.
- While a sync is paused you can keep writing; automatic syncs and the sync on close wait. Getting changes when Penna opens never starts a merge; if they overlap with your edits it says to sync.

**Milestone 9, folders, is built:**

- Right-click a folder in the Notes panel (or focus it and press the menu key): **New note here**, **Rename** (F2, in place), **Move to…**, **Delete…** (Delete key). The new-note field starts with the folder, so Enter puts the note there.
- **Drag** a note or a folder onto a folder (or onto any note in it) to move it there. A label follows the pointer saying where it will go, the folder lights up, and a strip at the bottom takes it to the top of the vault. Esc cancels.
- Moving or renaming a folder moves everything in it (notes, images, other files) and rewrites links across the vault: links to notes and images inside it, path-form embeds like `![[Folder/photo.png]]`, and the moved notes' own relative links out of the folder. Links between notes inside the folder keep working as written. A folder can't go inside itself or replace anything.
- Settings follow: renaming the daily-notes folder, the attachments folder, or the template note's folder updates the vault settings.
- **Delete…** says how many notes and other files are inside and moves the whole folder to the Recycle Bin. Saved versions stay in History.

**Milestone 10, attachment housekeeping, is built:**

- Right-click an image, a link to a file, or a `[[file]]` embed in a note (Preview or Source, rendered or raw): **Open**, **Show in Explorer**, **Rename…**, **Delete…**.
- **Rename…** selects the name without its extension, which stays unless you type one. Every link and embed that uses the file follows, including embeds by name (`![[photo.png]]` becomes `![[diagram.png]]`, or the full path when another file has that name).
- **Delete…** says how many notes use the file and moves it to the Recycle Bin. Its links stay and show the file is missing.
- **Settings → Attachments → Files no note links to** counts images and files no note shows or links to, and **Review…** lists them with sizes (all picked) to move to the Recycle Bin.
- Images are fetched fresh after a file changes, so a renamed or replaced picture shows right away.

**Version 0.2.0** covers milestones 1–10.

**Milestone 11, polish (version 0.3.0):**

- **Images in tables**: `![](…)` and `![[…]]` in a cell show the picture; cells also render ==highlight== and ~~strike~~. Right-clicking a picture in a table gives its file menu.
- **Note embeds**: `![[Note]]` shows the note's text in Preview, read-only, in a quiet card with an **Open** button; `![[Note#Heading]]` shows just that section. Headings, paragraphs, lists, tasks, quotes, code and images render; very long notes stop after 40 blocks. Embeds load again when the embedded note changes, don't nest, and a note never embeds itself. Clicking the card (not Open) puts the cursor on its Markdown.
- **History after a rename**: "Compare with now" and matches found only in older versions follow a note to its current name and folder ("“Old” is now “New”"), including renames not saved as a version yet. Only notes that are really gone say so.

**Milestone 12, the quick switcher (version 0.4.0):**

- **Ctrl+P** opens one box that goes anywhere. Empty, it lists the notes you opened last in this vault (remembered per vault, and kept up to date when notes move).
- Typing matches note names and folders fuzzily ("mrgux" finds "Merge UX"; exact and prefix matches come first, then the ones you opened most recently), and every heading in the vault ("Next week · in Merge UX"). Matched letters are bold. Enter opens a note, or opens it at the heading.
- **>** (or **Ctrl+Shift+P**) lists commands with their shortcuts: New note, Today, Search, History, Settings, Sync (or Finish sync while paused), Preview/Source, Changes, Rename/Move/Delete this note, Add an image or file, Open another vault, and the themes.
- When no note has that exact name, the last row is **New note “…”**. **Ctrl+Enter** searches everything for what's typed.

**Milestone 13, tags (version 0.5.0):**

- **Tags view** (the **#** in the rail, or **Ctrl+Shift+T**): every tag in the vault with how many notes use it, most used or A–Z, with a filter. Nested tags sit under their parent (`#sync/mobile` under `#sync`, which counts both) and fold away.
- Choosing a tag lists its notes like Search does: name, folder, when edited, the line where the tag is written (tags as pills) or "In properties". **Also tagged** narrows to notes that have another tag too. Clicking a note opens it at that line.
- **Rename a tag everywhere** (**F2**, or *Rename #tag…* in the margin): the dialog says what will change (how many notes, in text and properties; nested tags that move with it; whether the new name is already in use, in which case the two become one). Front matter keeps one copy of each tag. Tags inside code stay as written.
- In Preview, `#tags` show as pills. Clicking one, or a tag chip in a note's properties, opens the Tags view at that tag (on the line you're editing, a click just places the cursor).
- In the quick switcher, start with **#** to jump to a tag. Tags inside code (fenced blocks, `inline code`) no longer count anywhere, Search's tag filter included.

**Milestone 14, export (version 0.6.0):**

- **Export as HTML…**, **Export as PDF…** and **Print…** in the note's ⋯ menu, the Notes panel's right-click menu, and the quick switcher's commands.
- The export reads like Preview, set as Penna's page (light, serif): headings, emphasis, ==highlight==, ~~strike~~, code, quotes, lists, tasks, tables (with alignment and pictures in cells), images, `#tags` as pills (front-matter tags in a row at the top), and `![[Note#Heading]]` embeds (one level). Line breaks inside a paragraph are kept, as Preview shows them. Web links stay links; links to other notes read as text, since they don't travel with the file.
- **HTML** is one self-contained file: the vault's images and Penna's fonts are inside it (about 400 KB for the fonts), so it opens the same anywhere.
- **PDF** is written straight to the file you choose, by WebView2 (no print dialog), on Letter paper where that's the norm and A4 elsewhere. **Print…** opens the Windows print dialog with the note alone.
- Raw HTML in a note is cleaned to a few harmless tags (`<b>`, `<kbd>`, `<details>`…) without attributes; scripts and the rest show as text.

**Milestone 15, note templates (version 0.7.0):**

- Notes in the vault's **Templates** folder are templates (Settings → Templates sets the folder; the daily note's template lives there too).
- **New note from a template** (**Ctrl+Shift+N**, a folder's right-click menu "New from template here…", or the quick switcher): one dialog with the name on top (it starts as "Meeting 2026-10-18" and follows the chosen template until you type over it) and the templates below, each with a line of its text. ↑↓ choose, Enter creates. A name that's taken is explained in the dialog.
- **Insert a template** into the open note: **Template** in the + / "/" menu (it goes where the slash was), or "Insert a template…" in the quick switcher. The template's front matter is left out.
- Filled in: `{{title}}` (the note's name), `{{date}}` (2026-10-18), `{{date:dddd, MMMM D}}` (your own format, the same tokens as the daily title), `{{weekday}}`, `{{time}}`, and `{{cursor}}`, where typing starts. The daily note understands `{{date:…}}` and `{{cursor}}` now too.
- With no templates yet, the dialog says where they go and offers **Make a template**, which starts one in the folder and opens it.

**Milestone 16, unlinked mentions (version 0.8.0):**

- Under **Linked from**, the margin's **Mentioned in** lists notes that write this note's name, or one of its `aliases:` (front matter), as plain text: whole words, any case, not inside code, links or web addresses. Each shows the first mention with the words around it, and how many there are.
- **Link** turns that note's mentions into links, keeping how they were written: `[[Merge UX]]`, `[[Merge UX|merge ux]]`, `[[Merge UX|MUX]]` for an alias, or the note's path when two notes share its name. If the text moved in the meantime, nothing changes and Penna says so.
- Clicking the note's name opens it at the mention. The list updates when notes change, in Penna or outside it. With no mentions, the section isn't shown.

**Milestone 17, two notes side by side (version 0.9.0, canvas row "Margin — two notes at once"):**

- **Beside** in the title bar (or **Ctrl+\\**) asks for a note and opens it next to the one you're writing; the right margin steps aside while it's open. **Ctrl+click** a note in the Notes panel, or a link in a note, to open it beside; "Open beside" is in a note's right-click menu and in the quick switcher's commands.
- The note beside is a real page: it saves as you type (its header says Saved / Edited), pasted and dropped files go into it, and its links open beside (Ctrl+click one to open it in the main pane instead). Your cursor stays in the note you're writing when one opens beside.
- **Swap** trades the two notes; opening the note that's beside in the main pane does the same. The Notes panel marks it "beside". **Ctrl+\\** or × closes it.
- It follows renames and moves, reloads when it changes outside Penna (unless it has edits of its own waiting), closes if it's deleted, and comes back next time you open the vault.

**Next milestone:** to be decided (see HANDOFF.md).

## Run it

```powershell
npm install
npm run tauri dev        # dev build with hot reload
npm run tauri build      # release installer in src-tauri/target/release/bundle
cd src-tauri; cargo test # backend tests (real push/pull/merge against a local bare repo)
```

Prerequisites (Windows): Microsoft C++ Build Tools ("Desktop development with
C++"), WebView2 (preinstalled on Windows 11), Rust stable (MSVC), Node 20+.
Git for Windows is optional; it provides Git Credential Manager for HTTPS remotes.

## Releasing

Development happens on `main`. Pushing to the `release` branch runs `.github/workflows/release.yml`, which:

1. checks that `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` have the same version, and that
   `v<version>` isn't tagged yet (if it is, it stops: bump the version first);
2. builds on Windows (NSIS installer) and Ubuntu 22.04 (`.deb`, `.rpm`, `.AppImage`);
3. packs a portable Windows copy: `Penna.exe` with a `portable` file beside it, which keeps its settings in a
   `data` folder next to the program instead of the user profile (the AppImage is the portable Linux copy;
   `--appimage-portable-home` keeps its settings beside it);
4. tags the commit `v<version>` and publishes a GitHub release with every file, a `SHA256SUMS.txt`, a download
   table and the generated notes.

```powershell
# bump the version in the three files on main, commit, then:
git push origin main:release
```

The installers aren't signed yet, so Windows shows "unknown publisher" until a code-signing certificate is added.

## Keyboard

| Keys | Does |
| --- | --- |
| Ctrl+E | Switch Preview / Source |
| Ctrl+Shift+E | Show / hide Changes |
| Alt+↓ / Alt+↑ | Next / previous change |
| Ctrl+D | Today's note |
| Ctrl+Shift+F | Search |
| Ctrl+, | Settings |
| Ctrl+P | Go to a note or heading (quick switcher) |
| Ctrl+Shift+T | Tags |
| Ctrl+Shift+N | New note from a template |
| Ctrl+\\ | Open a note beside the one you're writing, or close it |
| Ctrl+click | Open a note (in the panel) or a link beside |
| Ctrl+Shift+P | Commands |
| Ctrl+K | Find a note |
| Ctrl+N | New note |
| F2 | Rename the open note (or the focused one in the Notes panel) |
| Delete | Delete the focused note in the Notes panel (asks first) |
| Ctrl+S | Save now (auto-save runs anyway) |
| Ctrl+Shift+S | Sync |
| Ctrl+F | Find in note |
| Ctrl+B / Ctrl+I | Bold / italic |
| Ctrl+Shift+H | Highlight |
| Ctrl+Shift+↑ / ↓ | Move the block at the cursor up / down |
| Ctrl+Shift+X / Ctrl+` | Strikethrough / inline code |
| / (start of a line) | Insert menu |
| [[ | Link to a note |

## Project structure

```
├── index.html
├── vite.config.ts                 # React + Tailwind plugins, fixed dev port for Tauri
├── src/                           # Frontend (webview)
│   ├── main.tsx
│   ├── index.css                  # Tailwind, bundled fonts, Margin design tokens (light/dark)
│   ├── App.tsx                    # Shell state: vault, note, mode, Changes, Git, shortcuts
│   ├── services/tauri.ts          # Typed IPC wrappers, events, window controls, dialogs
│   ├── editor/
│   │   ├── Editor.tsx             # CodeMirror: modes and Changes via compartments, auto-save
│   │   ├── livePreview.ts         # Preview's WYSIWYG decorations and widgets
│   │   ├── formatToolbar.ts       # Selection toolbar (a CodeMirror tooltip)
│   │   ├── markdownCommands.ts    # Bold/italic/highlight/heading/link commands that edit the Markdown
│   │   ├── highlight.ts           # ==highlight== added to the Markdown grammar
│   │   ├── blocks.ts              # Block grip: drag to move, block menu, Ctrl+Shift+↑/↓
│   │   ├── fileDrop.ts            # Pasting images, the drop caret, inserting attachment links
│   │   ├── conflicts.ts           # Choosing between versions after a sync conflict (both modes)
│   │   ├── embeds.ts              # ![[Note]] embeds: the embedded note's text, read-only
│   │   ├── refresh.ts             # The "redraw images, tables and embeds" signal
│   │   ├── insertMenu.ts          # "/" insert menu, [[ note suggestions, the "+" handle
│   │   ├── splitDiff.ts           # Side-by-side Changes: both sides of the MergeView
│   │   ├── tables.ts              # GFM tables rendered in Preview, click to edit
│   │   ├── theme.ts               # Margin editor themes + highlight styles (both modes)
│   │   └── codeBlocks.ts          # Code-block line styling
│   ├── components/
│   │   ├── TitleBar.tsx           # Vault, view switch, Changes, sync pill, window controls
│   │   ├── SearchView.tsx         # Search: filters, results, older-version matches
│   │   ├── TagsView.tsx           # Tags: the tag list, notes with a tag, narrowing
│   │   ├── BesidePane.tsx         # The note open beside the main one (its own editor)
│   │   ├── TemplateDialog.tsx     # New note from a template / Insert a template
│   │   ├── SettingsView.tsx       # Settings: app (this PC) and vault sections
│   │   ├── Rail.tsx               # Notes / Search / Today / History / Settings
│   │   ├── NotesPanel.tsx         # Vault as a table of contents: rename in place, menus, drag to move
│   │   ├── TodayPanel.tsx         # Calendar + recent daily notes
│   │   ├── HistoryPanel.tsx       # Not synced yet + saved versions by day
│   │   ├── VersionPage.tsx        # A version as prose diffs, restore, compare (+ its margin)
│   │   ├── NotePage.tsx           # Eyebrow (with the ⋯ note menu), Changes bar, inline title, editor
│   │   ├── Menu.tsx               # Small popup menu (right-click and ⋯)
│   │   ├── NoteDialogs.tsx        # Move to…, Delete… and confirm dialogs
│   │   ├── SyncPaused.tsx         # The paused sync's bar on the page and its margin
│   │   ├── QuickSwitcher.tsx      # Ctrl+P: notes, headings, commands
│   │   ├── MarginPanel.tsx        # Outline, backlinks, history, or the list of changes
│   │   ├── Toast.tsx, Welcome.tsx, icons.tsx
│   └── lib/
│       ├── format.ts              # Paths, titles, dates, word count, wiki-link resolution
│       ├── attachments.ts         # Attachment links: relative paths, resolving images and embeds
│       ├── conflicts.ts           # Parsing Git conflict markers, keep-both, place names
│       ├── exportNote.ts          # A note as HTML (from the editor's parser), export CSS, print layout
│       ├── fuzzy.ts               # Fuzzy matching and highlight runs for the quick switcher
│       ├── outline.ts             # Headings for the margin outline
│       ├── daily.ts               # Daily-note dates, titles, template, carry-over
│       ├── settings.ts            # App + vault settings, defaults, applying them to the page
│       ├── tags.ts                # Tag counts and tree, narrowing, rename preview, name rules
│       ├── templates.ts           # Template placeholders ({{title}}, {{date:…}}, {{cursor}}…), the template list
│       ├── proseDiff.ts           # Line + word diffs for the History view
│       └── hooks.ts               # useLatest, useDebouncedCallback, useNow
└── src-tauri/                     # Backend (Rust)
    ├── tauri.conf.json            # Frameless window, CSP, bundle
    ├── capabilities/default.json  # Window, dialog and opener permissions
    └── src/
        ├── lib.rs                 # AppState, #[tauri::command] handlers, builder
        ├── vault.rs               # Tree scan, path validation, atomic I/O, rename/delete, backlinks
        ├── links.rs               # Finding and rewriting links (wiki + relative Markdown)
        ├── attachments.rs         # Saving, importing, listing and opening attachments; the penna: scheme
        ├── git.rs                 # Status, commit, pull/push/sync, history, remote + identity
        ├── search.rs              # Full-text search over the vault (words, phrases, tags)
        ├── tags.rs                # Finding #tags and front-matter tags (and aliases); renaming a tag everywhere
        ├── mentions.rs            # Unlinked mentions of a note's name or aliases, and linking them
        ├── export.rs              # Images into exported pages; PDF through WebView2's PrintToPdf
        ├── watcher.rs             # Debounced watcher → "vault:changed"
        └── error.rs               # AppError → String at the IPC boundary
```

## Architecture

**Threading.** Every command is `async` and moves disk, libgit2 and network
work onto tokio's blocking pool, so the UI never waits on I/O. A tokio mutex
serializes Git writes; reads like status don't take it.

**Paths.** Everything crossing IPC is vault-relative with `/` separators.
`vault::resolve` rejects absolute paths, drive prefixes, `..`, and hidden
segments (which also protects `.git/`).

**Editor.** CodeMirror 6 edits the Markdown text directly. Preview hides the
syntax with decorations instead of converting to rich text, so files are saved
exactly as written and Git diffs only show your actual edits. Mode and Changes
are swapped through compartments, so toggling keeps undo history, cursor and
scroll. Changes uses `@codemirror/merge` against the note as it was at your
last sync: `unifiedMergeView` inline, or a two-editor `MergeView` side by
side. Switching to side by side rebuilds the editor around the same text,
selection and undo history (`historyField.init`).

### IPC commands

| Command | Args | Returns |
| --- | --- | --- |
| `open_vault` | `path` | `TreeNode[]`, and starts the watcher |
| `list_tree` | | `TreeNode[]` |
| `read_note` | `path` | `{ content, modified }` |
| `write_note` | `path`, `content` | new modified time (ms) |
| `create_note` | `path`, `content?` | (never overwrites) |
| `rename_note` | `from`, `to` | `{ path, moved, updated, links, retitled }`; rewrites links, never overwrites |
| `rename_folder` | `from`, `to` | same shape; moves everything inside and rewrites links to it |
| `delete_folder` | `path` | moves the folder to the Recycle Bin |
| `folder_contents` | `path` | `{ notes, files }`, for the delete confirmation |
| `delete_note` | `path` | moves it to the Recycle Bin |
| `list_attachments` | | every non-note file in the vault |
| `save_attachment` | raw bytes; headers `x-name`, `x-note`, `x-folder` | the new file's vault path (never overwrites) |
| `import_attachments` | `paths`, `note`, `folder` | vault paths (files already in the vault aren't copied) |
| `open_attachment` | `path` | opens it in its default app (programs are only revealed in Explorer) |
| `rename_attachment` | `from`, `to` | like `rename_note`; links and embeds that use it follow |
| `delete_attachments` | `paths` | how many went to the Recycle Bin |
| `attachment_usage` | | `{ path, size, notes }[]` for every attachment |
| `reveal_attachment` | `path` | shows it in Explorer |
| `note_backlinks` | `path` | `{ path, context }[]` |
| `git_status` | | `GitStatus` (incl. `changedPaths`) |
| `git_note_base` | `path` | `{ kind: lastSync \| lastVersion \| none, content, commit }` |
| `git_note_history` | `path` | `{ versions: CommitInfo[], more }`, following renames |
| `git_current_path` | `path`, `id` | where a note from that version is now (following renames), or null |
| `git_note_at` | `path`, `id` | the note's text in that version (under its old name if it was renamed since) |
| `git_log` | `skip`, `limit` | `{ versions: { commit, files }[], more }` |
| `git_version` | `id` | `{ commit, base, files: { path, status, oldText, newText }[] }` |
| `git_pending` | | same shape, for changes not synced yet |
| `git_restore` | `id`, `paths` | how many notes were restored |
| `recent_notes` | `limit?` | `{ path, modified }[]`, newest first |
| `list_headings` | | `{ path, level, text, line }[]` for every note (the quick switcher) |
| `list_tags` | | `{ path, modified, tags, properties, mentions: { line, text, tags }[] }[]` for every note with tags |
| `rename_tag` | `from`, `to` | `{ name, notes, changed }`: the tag and the ones nested under it, renamed in every note |
| `unlinked_mentions` | `path` | `{ path, mentions: { line, start, end, before, text, after }[], more }[]`: notes that mention it by name or alias without linking |
| `link_mentions` | `path`, `target`, `places: { line, start, end }[]` | how many mentions in `path` became links to `target` |
| `export_html` | `html`, `target` | saves an exported page; `src="penna-vault:<path>"` images are put inside as `data:` URIs |
| `export_pdf` | `target`, `width`, `height` | prints the page (showing a note in print layout) to a PDF, paper size in inches |
| `search_notes` | `query`, `titlesOnly` | `{ path, modified, titleMatch, count, snippets, tags }[]` |
| `search_history` | `query` | text found only in older versions: `{ path, version, removedIn, deleted, snippet }[]` |
| `vault_settings_read` / `vault_settings_write` | `json` | `.penna/settings.json` |
| `git_remote_url`, `git_set_remote` | `url` | empty URL disconnects |
| `git_test_connection` | | fetches from the remote without changing anything |
| `git_identity`, `git_set_identity` | `name`, `email` | name on versions for this vault only (empty = use global Git) |
| `device_name` | | the computer's name |
| `git_init`, `git_stage`, `git_commit`, `git_pull`, `git_push`, `git_sync` | | as before; `git_pull` reports `wouldConflict` and changes nothing, `git_sync` can pause with `conflicts` |
| `git_merge_state` | | the paused sync: `{ ours, theirs, notes: { path, places }[] }`, or null |
| `git_finish_merge` | `message` | saves the merge (refuses while markers are left), then pushes |
| `git_abort_merge` | | stops the paused sync, keeping edits made meanwhile |

Event: `vault:changed` → `{ paths: string[] }`.

URI scheme: `penna:` (`http://penna.localhost/<encoded vault path>` on Windows) serves vault files to the editor's images.
It only serves files inside the open vault that `vault::resolve` accepts, and sends SVGs with a sandboxing CSP.

## Sync behavior

- **Sync** = stage all → commit (if anything changed) → pull → push. Without a remote it only saves a version.
- **Pull never overwrites uncommitted work.** Checkouts use libgit2's safe strategy before the branch moves; merges are computed in memory first. A pull on its own changes nothing when edits overlap; Sync, after saving your edits as a version, pauses with conflict markers so you can choose.
- **Auth:** ssh-agent, then `~/.ssh/id_*` keys, then Git Credential Manager. Each is tried once.
- **Automatic sync** (Settings → Sync) runs quietly on a timer or a couple of minutes after you stop typing, pulls when a vault opens, and syncs once more when Penna closes (closing waits at most 10 seconds). It only shows a message when changes came in or something went wrong.
- **Second machine:** open an empty folder, click *Set up history*, paste the remote in Settings → Sync, then Sync. The empty repo adopts the remote history.

## How this project was initialized

```powershell
npm create tauri-app@latest -- mdTool --template react-ts --manager npm --identifier com.mdtool.desktop --yes
npm install -D tailwindcss @tailwindcss/vite
npm install @tauri-apps/plugin-dialog @codemirror/state @codemirror/view @codemirror/commands `
  @codemirror/language @codemirror/lang-markdown @codemirror/language-data @codemirror/search `
  @codemirror/merge @codemirror/lang-yaml @lezer/highlight @lezer/common `
  @fontsource-variable/newsreader @fontsource-variable/hanken-grotesk @fontsource/dm-mono
cd src-tauri
cargo add git2 --features https,ssh
cargo add notify-debouncer-mini walkdir thiserror tauri-plugin-dialog
cargo add tokio --no-default-features --features rt,sync
```

The project was later renamed to Penna (crate `penna`, identifier `com.penna.desktop`).

- **git2 0.21 enables no features by default.** `https` and `ssh` must be on.
  On Windows they use WinHTTP and WinCNG, so no OpenSSL is needed.
- **Tailwind v4 is configured in CSS** (`@theme` in `src/index.css`), so there's
  no `tailwind.config.js` or `postcss.config.js`.
- **Fonts are bundled** (Fontsource), so the app works offline and under the CSP.
