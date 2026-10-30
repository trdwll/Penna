//! The order notes and folders show in once someone arranges them by hand.
//!
//! Kept in `.penna/order.json`, synced with the notes like the vault settings:
//! for each folder (`""` is the top of the vault), the names of what's in it,
//! in order. Anything not listed (a note made since, or one added on another
//! device) comes after the listed ones, A to Z as before. Folders still come
//! before notes in the tree.
//!
//! The sidebar order is also the order links resolve names in (the first note
//! called `Idea` wins), and every caller walks the tree from `scan_tree`, so
//! the editor and the link rewriter keep seeing the same order.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::vault::{TreeNode, write_atomic};

/// Folder path → the names in it, in order.
pub type Order = BTreeMap<String, Vec<String>>;

fn order_path(root: &Path) -> PathBuf {
    root.join(".penna").join("order.json")
}

/// The saved order; empty when there's none, or it can't be read.
pub fn read(root: &Path) -> Order {
    fs::read_to_string(order_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Save the order, one name per line so two devices' changes merge. No order
/// at all removes the file.
fn write(root: &Path, order: &Order) -> AppResult<()> {
    let path = order_path(root);
    if order.is_empty() {
        return match fs::remove_file(&path) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(AppError::Io {
                context: format!("removing '{}'", path.display()),
                source: err,
            }),
            _ => Ok(()),
        };
    }
    let Ok(mut json) = serde_json::to_string_pretty(order) else {
        return Ok(());
    };
    json.push('\n');
    write_atomic(&path, &json)
}

/// Names compare like the filesystem on Windows: ignoring case.
fn key(name: &str) -> String {
    name.to_lowercase()
}

/// The order with folders and names lowercased, and each name's place.
fn ranks(order: &Order) -> HashMap<String, HashMap<String, usize>> {
    order
        .iter()
        .map(|(folder, names)| {
            let mut places = HashMap::new();
            for (i, name) in names.iter().enumerate() {
                places.entry(key(name)).or_insert(i);
            }
            (key(folder), places)
        })
        .collect()
}

/// Put every folder's children in the saved order, folders still first.
/// Sets `ordered` on folders that have one.
pub fn apply(tree: &mut [TreeNode], order: &Order) {
    if !order.is_empty() {
        apply_in(tree, "", &ranks(order));
    }
}

fn apply_in(nodes: &mut [TreeNode], folder: &str, ranks: &HashMap<String, HashMap<String, usize>>) {
    for node in nodes.iter_mut() {
        if let TreeNode::Dir {
            path,
            children,
            ordered,
            ..
        } = node
        {
            apply_in(children, path, ranks);
            *ordered = ranks.get(&key(path)).is_some_and(|r| !r.is_empty());
        }
    }
    let Some(places) = ranks.get(&key(folder)).filter(|r| !r.is_empty()) else {
        return;
    };
    // Stable: what isn't listed keeps its A to Z order, after what is.
    nodes.sort_by_key(|node| {
        let (is_file, name) = match node {
            TreeNode::Dir { name, .. } => (false, name),
            TreeNode::File { name, .. } => (true, name),
        };
        (
            is_file,
            places.get(&key(name)).copied().unwrap_or(usize::MAX),
        )
    });
}

/// `A/B/c.md` → (`A/B`, `c.md`); `c.md` → (``, `c.md`).
fn split(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

/// The saved key for `folder`, matched ignoring case.
fn find_key(order: &Order, folder: &str) -> Option<String> {
    let wanted = key(folder);
    order.keys().find(|k| key(k) == wanted).cloned()
}

/// Arrange a folder (`""` for the top of the vault) by hand: `names` are what's
/// in it, in order. No names puts it back to A to Z.
pub fn set(root: &Path, folder: &str, names: Vec<String>) -> AppResult<()> {
    let folder = folder.trim_matches('/');
    let mut order = read(root);
    if let Some(old) = find_key(&order, folder) {
        order.remove(&old);
    }
    let names: Vec<String> = names
        .into_iter()
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty() && !n.contains('/'))
        .collect();
    if !names.is_empty() {
        order.insert(folder.to_owned(), names);
    }
    write(root, &order)
}

/// Keys at or under `path` (its own order and its subfolders'), as
/// (old key, the rest after `path`).
fn keys_under(order: &Order, path: &str) -> Vec<(String, String)> {
    let wanted = key(path);
    let len = path.chars().count();
    order
        .keys()
        .filter_map(|k| {
            let lower = key(k);
            let inside = lower == wanted || lower.starts_with(&format!("{wanted}/"));
            inside.then(|| (k.clone(), k.chars().skip(len).collect()))
        })
        .collect()
}

fn drop_empty(order: &mut Order) {
    order.retain(|_, names| !names.is_empty());
}

/// A note or folder was renamed or moved from `from` to `to`. A rename keeps
/// its place; a move to another folder puts it after the arranged ones there.
/// A folder's own order goes with it.
pub fn moved(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let mut order = read(root);
    if order.is_empty() {
        return Ok(());
    }
    let before = order.clone();
    let ((from_dir, from_name), (to_dir, to_name)) = (split(from), split(to));
    if let Some(k) = find_key(&order, from_dir)
        && let Some(names) = order.get_mut(&k)
        && let Some(i) = names.iter().position(|n| key(n) == key(from_name))
    {
        if key(from_dir) == key(to_dir) {
            names[i] = to_name.to_owned();
        } else {
            names.remove(i);
        }
    }
    for (old, rest) in keys_under(&order, from) {
        if let Some(names) = order.remove(&old) {
            order.insert(format!("{to}{rest}"), names);
        }
    }
    drop_empty(&mut order);
    if order == before {
        Ok(())
    } else {
        write(root, &order)
    }
}

/// A note or folder was deleted: forget its place, and a folder's order.
pub fn removed(root: &Path, path: &str) -> AppResult<()> {
    let mut order = read(root);
    if order.is_empty() {
        return Ok(());
    }
    let before = order.clone();
    let (dir, name) = split(path);
    if let Some(k) = find_key(&order, dir)
        && let Some(names) = order.get_mut(&k)
    {
        names.retain(|n| key(n) != key(name));
    }
    for (old, _) in keys_under(&order, path) {
        order.remove(&old);
    }
    drop_empty(&mut order);
    if order == before {
        Ok(())
    } else {
        write(root, &order)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{note_paths, rename_folder, rename_note, scan_tree};

    fn temp_vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penna-order-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(nodes: &[TreeNode]) -> Vec<&str> {
        nodes
            .iter()
            .map(|n| match n {
                TreeNode::Dir { name, .. } | TreeNode::File { name, .. } => name.as_str(),
            })
            .collect()
    }

    fn strings(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn arranged_folders_keep_their_order_and_the_rest_follow() {
        let root = temp_vault("apply");
        fs::create_dir_all(root.join("Story/Part Two")).unwrap();
        fs::create_dir_all(root.join("Story/Part One")).unwrap();
        for note in [
            "Story/Act I.md",
            "Story/Act II.md",
            "Story/Overview.md",
            "Story/Characters.md",
            "Story/Part One/a.md",
            "Story/Part Two/b.md",
            "Inbox.md",
        ] {
            fs::write(root.join(note), "").unwrap();
        }

        set(
            &root,
            "Story",
            strings(&[
                "Part Two",
                "overview.md",
                "Act II.md",
                "Gone.md",
                "Act I.md",
            ]),
        )
        .unwrap();
        let tree = scan_tree(&root).unwrap();
        let TreeNode::Dir {
            children, ordered, ..
        } = &tree[0]
        else {
            panic!("expected Story")
        };
        assert!(*ordered);
        // Folders first; listed names in their order (ignoring case), the rest A to Z after.
        assert_eq!(
            names(children),
            [
                "Part Two",
                "Part One",
                "Overview.md",
                "Act II.md",
                "Act I.md",
                "Characters.md"
            ]
        );
        // Links resolve in this order too.
        assert_eq!(
            note_paths(&root).unwrap()[..3],
            [
                "Story/Part Two/b.md",
                "Story/Part One/a.md",
                "Story/Overview.md"
            ]
        );

        // No names: back to A to Z, and no file left behind.
        set(&root, "Story", Vec::new()).unwrap();
        assert!(!order_path(&root).exists());
        let tree = scan_tree(&root).unwrap();
        let TreeNode::Dir {
            children, ordered, ..
        } = &tree[0]
        else {
            panic!("expected Story")
        };
        assert!(!*ordered);
        assert_eq!(
            names(children)[2..],
            ["Act I.md", "Act II.md", "Characters.md", "Overview.md"]
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn renames_moves_and_deletes_keep_the_order_current() {
        let root = temp_vault("follow");
        fs::create_dir_all(root.join("Story/Scenes")).unwrap();
        for note in [
            "Story/Overview.md",
            "Story/Act I.md",
            "Story/Scenes/Open.md",
            "Story/Scenes/Close.md",
            "Notes.md",
        ] {
            fs::write(root.join(note), "").unwrap();
        }
        set(&root, "Story", strings(&["Overview.md", "Act I.md"])).unwrap();
        set(&root, "Story/Scenes", strings(&["Open.md", "Close.md"])).unwrap();
        set(&root, "", strings(&["Story", "Notes.md"])).unwrap();

        // A rename keeps its place.
        rename_note(&root, "Story/Overview.md", "Story/Summary.md").unwrap();
        assert_eq!(read(&root)["Story"], ["Summary.md", "Act I.md"]);

        // A renamed folder keeps its own order (and its subfolders') and its place.
        rename_folder(&root, "Story", "Novel").unwrap();
        let order = read(&root);
        assert_eq!(order[""], ["Novel", "Notes.md"]);
        assert_eq!(order["Novel"], ["Summary.md", "Act I.md"]);
        assert_eq!(order["Novel/Scenes"], ["Open.md", "Close.md"]);
        assert!(!order.contains_key("Story"));

        // A move to another folder leaves its old place.
        rename_note(&root, "Novel/Act I.md", "Act I.md").unwrap();
        assert_eq!(read(&root)["Novel"], ["Summary.md"]);

        // A delete forgets it; an emptied list goes. (`delete_note` calls this
        // after the Recycle Bin, which tests stay away from.)
        removed(&root, "Novel/Summary.md").unwrap();
        assert!(!read(&root).contains_key("Novel"));
        removed(&root, "Novel/Scenes").unwrap();
        assert!(!read(&root).contains_key("Novel/Scenes"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_broken_file_means_no_order() {
        let root = temp_vault("broken");
        fs::create_dir_all(root.join(".penna")).unwrap();
        fs::write(order_path(&root), "{ not json").unwrap();
        fs::write(root.join("b.md"), "").unwrap();
        fs::write(root.join("a.md"), "").unwrap();
        assert!(read(&root).is_empty());
        assert_eq!(names(&scan_tree(&root).unwrap()), ["a.md", "b.md"]);
        fs::remove_dir_all(&root).unwrap();
    }
}
