/**
 * Arranging notes and folders by hand. The backend keeps each folder's order
 * in `.penna/order.json` and returns the tree in it; these work out a folder's
 * new order from what the Notes panel shows. A folder shows its notes first,
 * then its subfolders, so each kind is arranged among its own.
 */
import type { DirNode, FileNode, TreeNode } from "../services/tauri";
import { dailyDateOf } from "./daily";
import { basename, folderOf } from "./format";

/** A note, or a folder (`folder: true`), by its vault path. */
interface Item {
  path: string;
  folder: boolean;
}

/** Next to this row: above it, or below it with `after`. */
export interface Place {
  path: string;
  after: boolean;
}

function findDir(nodes: TreeNode[], path: string): DirNode | null {
  for (const node of nodes) {
    if (node.kind !== "dir") continue;
    if (node.path === path) return node;
    if (path.startsWith(`${node.path}/`)) return findDir(node.children, path);
  }
  return null;
}

/** A folder's notes and subfolders in the order shown. Daily notes come newest first until it's arranged by hand. */
export function shown(nodes: TreeNode[], dailyFirst: boolean): { files: FileNode[]; dirs: DirNode[] } {
  const files = nodes.filter((n): n is FileNode => n.kind === "file");
  if (dailyFirst) files.sort((a, b) => (dailyDateOf(b.path)?.getTime() ?? 0) - (dailyDateOf(a.path)?.getTime() ?? 0));
  return { files, dirs: nodes.filter((n): n is DirNode => n.kind === "dir") };
}

/** What `folder` shows (`""` is the top of the vault), or null when it isn't there. */
function shownIn(tree: TreeNode[], folder: string) {
  if (!folder) return shown(tree, false);
  const dir = findDir(tree, folder);
  return dir ? shown(dir.children, !dir.ordered) : null;
}

/**
 * The names `folder` holds, in order, once `item` goes next to `at` (a row of
 * the same kind in that folder). `item` may come from another folder. Null
 * when that's where it already is.
 */
export function placeNames(tree: TreeNode[], item: Item, folder: string, at: Place): string[] | null {
  const now = shownIn(tree, folder);
  if (!now) return null;
  const same = (item.folder ? now.dirs : now.files).map((n) => n.path);
  const others = (item.folder ? now.files : now.dirs).map((n) => n.name);
  const next = same.filter((p) => p !== item.path);
  const i = next.indexOf(at.path);
  if (i === -1) return null;
  next.splice(at.after ? i + 1 : i, 0, item.path);
  if (next.join("\n") === same.join("\n")) return null;
  const names = next.map(basename);
  return item.folder ? [...names, ...others] : [...others, ...names];
}

/** The names for moving `item` one place up (-1) or down (1) in its folder, or null when it can't go further. */
export function shiftNames(tree: TreeNode[], item: Item, by: -1 | 1): string[] | null {
  const folder = folderOf(item.path);
  const now = shownIn(tree, folder);
  if (!now) return null;
  const same = (item.folder ? now.dirs : now.files).map((n) => n.path);
  const to = same[same.indexOf(item.path) + by];
  return to && same.includes(item.path) ? placeNames(tree, item, folder, { path: to, after: by > 0 }) : null;
}

/**
 * How a folder (`""`: the top of the vault) goes back to the usual order: "A to Z", or "newest first" when it
 * holds daily notes. Null when it wasn't arranged by hand. The top of the vault has no flag, so it counts as
 * arranged once it isn't A to Z.
 */
export function usualOrder(tree: TreeNode[], folder: string): string | null {
  const dir = folder ? findDir(tree, folder) : null;
  if (folder && !dir?.ordered) return null;
  const nodes = dir ? dir.children : tree;
  if (!dir) {
    const sorted = (list: TreeNode[]) => list.every((n, i) => i === 0 || list[i - 1].name.toLowerCase() <= n.name.toLowerCase());
    if (sorted(nodes.filter((n) => n.kind === "file")) && sorted(nodes.filter((n) => n.kind === "dir"))) return null;
  }
  return dir && nodes.some((n) => n.kind === "file" && dailyDateOf(n.path)) ? "newest first" : "A to Z";
}
