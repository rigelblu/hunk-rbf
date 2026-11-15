import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { JJ_MUTATION_KINDS, listJjMutationKinds } from "./mutationKinds";

/** The only modules a kind may import: public types, the kind interface, and the shared wording. */
const ALLOWED_KIND_IMPORTS = new Set(["hunkdiff/extension", "./mutationKind", "./mutationWording"]);
/** Names that reach a module or a process without an import statement. */
const SIDE_DOOR_NAMES = new Set([
  "Bun",
  "Function",
  "WebAssembly",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "binding",
  "constructor",
  "eval",
  "fetch",
  "getBuiltinModule",
  "global",
  "globalThis",
  "require",
]);
/** Objects whose members must be named in the source, so a built-up name cannot reach a module. */
const NO_COMPUTED_ACCESS = new Set(["process", "global", "globalThis"]);

/** Maps a kind name to its module file: "abandon" lives in `mutationAbandon.ts`. */
function kindModuleTestPath(kind: string): string {
  return join(import.meta.dir, `mutation${kind.charAt(0).toUpperCase()}${kind.slice(1)}.ts`);
}

/**
 * Lists what a pure module's source breaks.
 *
 * It reads the syntax tree, so the wording inside a string or a comment never
 * counts as an import, and no spacing or line break hides one. It guards
 * against accidents; it is not a proof that a module cannot reach the system.
 */
function findPurityTestViolations(source: string, allowed: ReadonlySet<string>): string[] {
  const file = ts.createSourceFile("kind.ts", source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const checkSpecifier = (specifier: ts.Expression | undefined, isTypeOnly: boolean) => {
    if (!specifier || !ts.isStringLiteral(specifier)) return;
    if (!allowed.has(specifier.text)) violations.push(`imports ${specifier.text}`);
    // A value import from the public surface would pull in runtime code.
    else if (specifier.text === "hunkdiff/extension" && !isTypeOnly) {
      violations.push("value import from hunkdiff/extension");
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause) violations.push("side-effect import");
      checkSpecifier(node.moduleSpecifier, node.importClause?.isTypeOnly ?? false);
    } else if (ts.isExportDeclaration(node)) {
      checkSpecifier(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      violations.push("import assignment");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push("dynamic import");
    } else if (ts.isIdentifier(node) && SIDE_DOOR_NAMES.has(node.text)) {
      violations.push(`uses ${node.text}`);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      NO_COMPUTED_ACCESS.has(node.expression.text)
    ) {
      violations.push(`computed access on ${node.expression.text}`);
    } else if (ts.isStringLiteralLike(node) && SIDE_DOOR_NAMES.has(node.text)) {
      violations.push(`names ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

describe("JJ_MUTATION_KINDS", () => {
  test("registers each kind under its own name, in alphabetical order", () => {
    const keys = Object.keys(JJ_MUTATION_KINDS);
    expect(keys).toEqual([...keys].sort());
    expect(listJjMutationKinds()).toEqual(keys as ReturnType<typeof listJjMutationKinds>);
    for (const [key, kind] of Object.entries(JJ_MUTATION_KINDS)) {
      expect(kind.kind).toBe(key as typeof kind.kind);
    }
    expect(keys).toContain("abandon");
  });

  test("keeps every kind module and the shared wording pure", () => {
    for (const kind of Object.keys(JJ_MUTATION_KINDS)) {
      const path = kindModuleTestPath(kind);
      expect(existsSync(path)).toBe(true);
      expect(findPurityTestViolations(readFileSync(path, "utf8"), ALLOWED_KIND_IMPORTS)).toEqual(
        [],
      );
    }
    // The two modules a kind may import are held to the same rule, with only public types allowed.
    for (const shared of ["mutationWording.ts", "mutationKind.ts"]) {
      const source = readFileSync(join(import.meta.dir, shared), "utf8");
      expect(findPurityTestViolations(source, new Set(["hunkdiff/extension"]))).toEqual([]);
    }
  });

  test("catches each way a kind module could stop being pure", () => {
    const impure = [
      'import "./startsJjOnLoad";',
      'import "node:fs";',
      'import { spawnSync } from"node:child_process";',
      'import{spawn}from"node:child_process"',
      '/* c */ import { existsSync } from "node:fs";',
      'import {\n  a, // ;\n  b,\n} from "node:fs";',
      "const { spawnSync } = Bun;",
      'process.getBuiltinModule("node:child_process");',
      'globalThis["Bun"];',
      'const key = "Bun";',
      'export * from "./mutationRunner";',
      'const fs = require("node:fs");',
      'const fs = await import("node:fs");',
      'import fs = require("node:fs");',
      'import { HunkExtensionUserError } from "hunkdiff/extension";',
      'process.binding("fs");',
      'process["getBuiltin" + "Module"]("node:fs");',
      'global["B" + "un"];',
      'fetch("file:///etc/hosts");',
      'Function("return 1")();',
      'new Worker("./x.js");',
      '(() => {}).constructor("return process")();',
    ];
    for (const source of impure) {
      expect({
        source,
        violations: findPurityTestViolations(source, ALLOWED_KIND_IMPORTS),
      }).not.toEqual({
        source,
        violations: [],
      });
    }
  });

  test("accepts the allowed imports and wording that only looks like an import", () => {
    const pure = [
      'import type { A } from "hunkdiff/extension";',
      'import type { B } from "./mutationKind";',
      'import { countOf } from "./mutationWording";',
      'export const headline = `Move 2 revisions from "${a}" onto "${b}"; nothing else changes.`;',
    ].join("\n");
    expect(findPurityTestViolations(pure, ALLOWED_KIND_IMPORTS)).toEqual([]);
  });
});
