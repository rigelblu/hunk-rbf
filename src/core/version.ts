import packageJson from "../../package.json" with { type: "json" };
import rbfVersion from "../../rbf/RBF_VERSION" with { type: "text" };

export const UNKNOWN_CLI_VERSION = "0.0.0-unknown";

const PACKAGE_CLI_VERSION = packageJson.version;
const RBF_CLI_VERSION = rbfVersion.trim();

/** Resolve the CLI version reported by `hunk --version`. */
export function resolveCliVersion(): string {
  if (RBF_CLI_VERSION.length > 0) {
    return RBF_CLI_VERSION;
  }

  if (typeof PACKAGE_CLI_VERSION !== "string" || PACKAGE_CLI_VERSION.length === 0) {
    return UNKNOWN_CLI_VERSION;
  }

  return PACKAGE_CLI_VERSION;
}
