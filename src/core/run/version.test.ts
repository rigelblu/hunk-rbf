import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  UNKNOWN_CLI_VERSION,
  formatCliVersionLine,
  isComparableVersion,
  normalizeCliVersion,
  resolveCliVersion,
  resolveUpstreamVersion,
} from "./version";

describe("version normalization", () => {
  test("keeps a stable semver unchanged", () => {
    expect(normalizeCliVersion("0.19.0")).toBe("0.19.0");
  });

  test("keeps a prerelease semver unchanged", () => {
    expect(normalizeCliVersion("0.7.0-rc.1")).toBe("0.7.0-rc.1");
  });

  test("trims surrounding whitespace before judging the value", () => {
    expect(normalizeCliVersion(" 0.6.0\n")).toBe("0.6.0");
  });

  test("resolves every malformed or absent source to the unknown sentinel", () => {
    for (const raw of ["", "   ", "v0.6.0", "0.6", "not-a-version", undefined, null, 6]) {
      expect(normalizeCliVersion(raw)).toBe(UNKNOWN_CLI_VERSION);
    }
  });
});

describe("version sources", () => {
  test("reports the fork release version for the tree's own metadata", async () => {
    const forkVersion = (await Bun.file("rbf/RBF_VERSION").text()).trim();

    expect(resolveCliVersion()).toBe(forkVersion);
  });

  test("reports the upstream version separately from the fork version", async () => {
    const upstreamVersion = (
      JSON.parse(await Bun.file("package.json").text()) as { version: string }
    ).version;

    expect(resolveUpstreamVersion()).toBe(upstreamVersion);
    // Each source is read from its own file. Whether today's two values happen to differ is
    // not the contract, so this does not assert that. The "fork version source selection"
    // block below pins the independence by injecting one source and checking the other is
    // unmoved.
    expect(resolveCliVersion()).toBe((await Bun.file("rbf/RBF_VERSION").text()).trim());
  });

  test("keeps the fork version bare and comparable for machine consumers", () => {
    expect(isComparableVersion(resolveCliVersion())).toBe(true);
    expect(resolveCliVersion()).not.toContain("hunk ");
    expect(resolveCliVersion()).not.toContain("(Hunk RBF ");
  });

  test("stops being comparable when fork metadata is malformed, rather than borrowing upstream", () => {
    // The removed upstream fallback used to make this path comparable against upstream
    // releases. Suppressing the update notice is the intended outcome now.
    expect(isComparableVersion(normalizeCliVersion(""))).toBe(false);
  });
});

describe("fork version source selection", () => {
  test("resolves the fork source by default", async () => {
    expect(resolveCliVersion()).toBe((await Bun.file("rbf/RBF_VERSION").text()).trim());
  });

  test("resolves an unusable fork source to unknown, never to the upstream version", () => {
    // The removed fallback returned the upstream version for these inputs, which let a fork
    // install compare itself against upstream npm releases. Killing that is the point of the
    // slice, so this is the assertion that fails if anyone restores it.
    for (const rawForkVersion of ["", "   ", "not-a-version", "v0.6.0", "0.6"]) {
      expect(resolveCliVersion({ rawForkVersion })).toBe(UNKNOWN_CLI_VERSION);
      expect(resolveCliVersion({ rawForkVersion })).not.toBe(resolveUpstreamVersion());
    }
  });

  test("stops being comparable on an unusable fork source, so update notices go quiet", () => {
    expect(isComparableVersion(resolveCliVersion({ rawForkVersion: "" }))).toBe(false);
  });

  test("reads only the fork source, whatever upstream says", () => {
    expect(resolveCliVersion({ rawForkVersion: "9.9.9" })).toBe("9.9.9");
    expect(resolveUpstreamVersion()).not.toBe("9.9.9");
  });

  test("classifies an unnameable build as an untagged source build", async () => {
    // `detectInstallSource` receives this value through `updateNotice` and `selfUpdate`, so the
    // resolver change reaches install-source classification even though nothing there calls
    // `resolveCliVersion` directly.
    const { detectInstallSource } = await import("../install/installSource");

    expect(
      detectInstallSource({
        env: {},
        executablePath: join("/", "usr", "local", "bin", "hunk"),
        homeDir: join("/", "home", "reviewer"),
        version: resolveCliVersion({ rawForkVersion: "" }),
      }),
    ).toBe("dev");
  });

  test("shows an unusable fork source in its own position only", () => {
    expect(
      formatCliVersionLine({
        upstream: resolveUpstreamVersion(),
        fork: resolveCliVersion({ rawForkVersion: "" }),
      }),
    ).toBe(`hunk ${resolveUpstreamVersion()} (Hunk RBF 0.0.0-unknown)`);
  });
});

describe("version line formatting", () => {
  test("names upstream compatibility first and fork identity second", () => {
    expect(formatCliVersionLine({ upstream: "0.19.0", fork: "0.6.0" })).toBe(
      "hunk 0.19.0 (Hunk RBF 0.6.0)",
    );
  });

  test("marks only the upstream value unknown when upstream metadata is malformed", () => {
    expect(
      formatCliVersionLine({
        upstream: normalizeCliVersion("nope"),
        fork: normalizeCliVersion("0.6.0"),
      }),
    ).toBe("hunk 0.0.0-unknown (Hunk RBF 0.6.0)");
  });

  test("marks only the fork value unknown when fork metadata is malformed", () => {
    expect(
      formatCliVersionLine({
        upstream: normalizeCliVersion("0.19.0"),
        fork: normalizeCliVersion(""),
      }),
    ).toBe("hunk 0.19.0 (Hunk RBF 0.0.0-unknown)");
  });

  test("marks both values unknown independently when both sources are malformed", () => {
    expect(
      formatCliVersionLine({
        upstream: normalizeCliVersion(""),
        fork: normalizeCliVersion("nope"),
      }),
    ).toBe("hunk 0.0.0-unknown (Hunk RBF 0.0.0-unknown)");
  });

  test("composes the tree's real sources into one line", () => {
    expect(
      formatCliVersionLine({
        upstream: resolveUpstreamVersion(),
        fork: resolveCliVersion(),
      }),
    ).toBe(`hunk ${resolveUpstreamVersion()} (Hunk RBF ${resolveCliVersion()})`);
  });
});
