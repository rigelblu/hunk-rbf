import fs from "node:fs";
import { join, resolve } from "node:path";

/**
 * Resolves the directory that holds a Jujutsu repository's shared store for one workspace.
 *
 * The initial workspace keeps the store in `.jj/repo`. A workspace made by `jj workspace add`
 * keeps a file there instead, holding the store's path: absolute, or relative to the real
 * location of that workspace's `.jj` directory. Reads the pointer without spawning `jj`, and
 * returns the workspace-local path whenever the pointer is missing, unreadable, empty, or does
 * not lead to a directory.
 */
export function resolveJjRepoStoreDirectory(workspaceRoot: string) {
  const jjDirectory = join(workspaceRoot, ".jj");
  const local = join(jjDirectory, "repo");
  try {
    if (!fs.statSync(local).isFile()) {
      return local;
    }
    const pointer = fs.readFileSync(local, "utf8").replace(/[\r\n]+$/, "");
    if (!pointer) {
      return local;
    }
    // A relative pointer starts from where `.jj` really is, which matters when `.jj` is a
    // symlink. `resolve` accepts both separators on Windows, where a pointer may carry either.
    const store = resolve(fs.realpathSync(jjDirectory), pointer);
    return fs.statSync(store).isDirectory() ? store : local;
  } catch {
    return local;
  }
}
