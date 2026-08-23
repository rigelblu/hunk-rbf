import packageJson from "../../../package.json" with { type: "json" };
import rbfVersion from "../../../rbf/RBF_VERSION" with { type: "text" };

export const UNKNOWN_CLI_VERSION = "0.0.0-unknown";

const PACKAGE_CLI_VERSION = packageJson.version;
const RBF_CLI_VERSION = rbfVersion.trim();
const STABLE_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const PRERELEASE_SEMVER_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

/**
 * Normalize one raw version source to a comparable semver or the unknown sentinel.
 * Both the machine resolver and the display formatter call this, so a source can never
 * normalize one way for comparison and another way for display.
 */
export function normalizeCliVersion(raw: unknown): string {
  if (typeof raw !== "string") {
    return UNKNOWN_CLI_VERSION;
  }

  const trimmed = raw.trim();
  return isStableVersion(trimmed) || isPrereleaseVersion(trimmed) ? trimmed : UNKNOWN_CLI_VERSION;
}

/**
 * Resolve the fork's own release version, used by update notices, self-update, and
 * install-source detection. Malformed `rbf/RBF_VERSION` resolves to the unknown sentinel
 * and never falls back to the upstream package version: that fallback made a fork install
 * comparable against upstream releases, which is the wrong comparison.
 *
 * The source is injectable so tests can pin that no-fallback rule against a raw value; every
 * production caller passes nothing. It arrives named rather than positional so the function
 * stays safe to use as a bare callback reference.
 */
export function resolveCliVersion(sources: { rawForkVersion?: unknown } = {}): string {
  return normalizeCliVersion(sources.rawForkVersion ?? RBF_CLI_VERSION);
}

/**
 * Resolve the upstream Hunk version this fork is built against. Display only — no update,
 * self-update, or install-source path may consume it.
 */
export function resolveUpstreamVersion(): string {
  return normalizeCliVersion(PACKAGE_CLI_VERSION);
}

/**
 * Compose the single line `hunk --version`, `hunk -v`, and `hunk version` print. Callers
 * pass each source already normalized on its own, so an invalid source shows its own
 * unknown label and never borrows the other's value. The two versions arrive named rather
 * than positional: both are plain semver strings, and swapping them would print a
 * plausible line naming each identity as the other.
 */
export function formatCliVersionLine(versions: { upstream: string; fork: string }): string {
  return `hunk ${versions.upstream} (Hunk RBF ${versions.fork})`;
}

/** Return whether one version string is a normalized stable semver. */
export function isStableVersion(version: string) {
  return STABLE_SEMVER_PATTERN.test(version);
}

/** Return whether one version string looks like a prerelease semver. */
export function isPrereleaseVersion(version: string) {
  return PRERELEASE_SEMVER_PATTERN.test(version);
}

/** Return whether the installed version can participate in update comparisons. */
export function isComparableVersion(version: string) {
  if (version === UNKNOWN_CLI_VERSION) {
    return false;
  }

  return isStableVersion(version) || isPrereleaseVersion(version);
}

/** Compare two versions and return whether the candidate is strictly newer. */
export function isNewerVersion(current: string, candidate: string) {
  try {
    return Bun.semver.order(current, candidate) < 0;
  } catch {
    return false;
  }
}
