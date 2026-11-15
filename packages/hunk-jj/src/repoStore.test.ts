import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveJjRepoStoreDirectory } from "./repoStore";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-jj-repo-store-")));
  tempDirs.push(dir);
  return dir;
}

/** Create an initial workspace whose `.jj/repo` is the store directory itself. */
function createTestInitialWorkspace(parent: string) {
  const workspace = join(parent, "main");
  mkdirSync(join(workspace, ".jj", "repo", "op_heads"), { recursive: true });
  return workspace;
}

/** Create a secondary workspace whose `.jj/repo` is a file holding `pointer`. */
function createTestSecondaryWorkspace(parent: string, pointer: string) {
  const workspace = join(parent, "nested", "secondary");
  mkdirSync(join(workspace, ".jj"), { recursive: true });
  writeFileSync(join(workspace, ".jj", "repo"), pointer);
  return workspace;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveJjRepoStoreDirectory", () => {
  test("returns the store directory of an initial workspace", () => {
    const main = createTestInitialWorkspace(createTempDir());

    expect(resolveJjRepoStoreDirectory(main)).toBe(join(main, ".jj", "repo"));
  });

  test("follows a pointer relative to the secondary workspace's .jj directory", () => {
    const parent = createTempDir();
    const store = join(createTestInitialWorkspace(parent), ".jj", "repo");
    const pointer = relative(join(parent, "nested", "secondary", ".jj"), store);
    const secondary = createTestSecondaryWorkspace(parent, pointer);

    expect(resolveJjRepoStoreDirectory(secondary)).toBe(store);
  });

  test("follows a relative pointer written with forward slashes", () => {
    const parent = createTempDir();
    const store = join(createTestInitialWorkspace(parent), ".jj", "repo");
    const secondary = createTestSecondaryWorkspace(parent, "../../../main/.jj/repo");

    expect(resolveJjRepoStoreDirectory(secondary)).toBe(store);
  });

  test("follows an absolute pointer and ignores a trailing line ending", () => {
    const parent = createTempDir();
    const store = join(createTestInitialWorkspace(parent), ".jj", "repo");
    const secondary = createTestSecondaryWorkspace(parent, `${store}\n`);

    expect(resolveJjRepoStoreDirectory(secondary)).toBe(store);
  });

  // Creating a symlink needs a privilege on Windows that test machines may not grant.
  const symlinkTest = platform() === "win32" ? test.skip : test;

  symlinkTest("resolves a relative pointer from the real location of a symlinked .jj", () => {
    const parent = createTempDir();
    const store = join(createTestInitialWorkspace(parent), ".jj", "repo");
    // The real `.jj` sits at another depth than the workspace's own, so a lexical resolve misses.
    const realJjDirectory = join(parent, "elsewhere", "deeper", "still", "jj-data");
    mkdirSync(realJjDirectory, { recursive: true });
    writeFileSync(join(realJjDirectory, "repo"), relative(realJjDirectory, store));
    const workspace = join(parent, "linked");
    mkdirSync(workspace);
    symlinkSync(realJjDirectory, join(workspace, ".jj"), "dir");

    expect(resolveJjRepoStoreDirectory(workspace)).toBe(store);
  });

  test("keeps the workspace-local path when the pointer is missing", () => {
    const workspace = join(createTempDir(), "missing");
    mkdirSync(join(workspace, ".jj"), { recursive: true });

    expect(resolveJjRepoStoreDirectory(workspace)).toBe(join(workspace, ".jj", "repo"));
  });

  test("keeps the workspace-local path when the pointer is empty or leads nowhere", () => {
    const parent = createTempDir();
    const empty = createTestSecondaryWorkspace(join(parent, "empty"), "");
    const dangling = createTestSecondaryWorkspace(
      join(parent, "dangling"),
      "../../../gone/.jj/repo",
    );

    expect(resolveJjRepoStoreDirectory(empty)).toBe(join(empty, ".jj", "repo"));
    expect(resolveJjRepoStoreDirectory(dangling)).toBe(join(dangling, ".jj", "repo"));
  });
});
