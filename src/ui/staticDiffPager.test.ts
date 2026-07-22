import { describe, expect, test } from "bun:test";
import type { DiffRow } from "./diff/pierre";
import { resolveTheme, themeRenderSurfaces } from "./themes";
import {
  renderStaticDiffPager,
  renderStaticSplitRow,
  renderStaticStackRow,
} from "./staticDiffPager";

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Remove Hunk's intentional SGR color codes while leaving unsafe controls visible. */
function stripColorSgr(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const OSC52_CLIPBOARD = "\x1b]52;c;SGVsbG8=\x07";
const CSI_CLEAR_SCREEN = "\x1b[2J";
const DCS_PAYLOAD = "\x1bPqpayload\x1b\\";
const APC_PAYLOAD = "\x1b_payload\x1b\\";
const PM_PAYLOAD = "\x1b^payload\x1b\\";
const SOS_PAYLOAD = "\x1bXpayload\x1b\\";

function expectNoUnsafeTerminalControls(text: string) {
  expect(text).not.toContain(OSC52_CLIPBOARD);
  expect(text).not.toContain(CSI_CLEAR_SCREEN);
  expect(text).not.toContain(DCS_PAYLOAD);
  expect(text).not.toContain(APC_PAYLOAD);
  expect(text).not.toContain(PM_PAYLOAD);
  expect(text).not.toContain(SOS_PAYLOAD);
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("\r");
  expect(text).not.toContain("\b");
  expect(text).not.toContain("\x1b");
}

describe("static diff pager", () => {
  test("renders diff-like stdin as non-interactive ANSI output", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";

    const output = await renderStaticDiffPager(patchText);

    const plain = stripAnsi(output);

    expect(plain).toContain("a.ts modified +1 -1");
    expect(plain).toContain("▌@@ -1 +1 @@\n");
    expect(plain).toContain("▌1   -  const value = 1;");
    expect(plain).toContain("▌  1 +  const value = 2;");
    expect(output).toContain("\x1b[38;2;");
    expect(output).not.toContain("\x1b[?1049h");
  });

  test("honors configured hidden line numbers and hunk headers", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";

    const plain = stripAnsi(
      await renderStaticDiffPager(patchText, {
        lineNumbers: false,
        hunkHeaders: false,
      }),
    );

    expect(plain).not.toContain("@@ -1 +1 @@");
    expect(plain).toContain("▌- const value = 1;");
    expect(plain).toContain("▌+ const value = 2;");
  });

  test("honors explicit split mode in static pager output", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";

    const plain = stripAnsi(
      await renderStaticDiffPager(
        patchText,
        { mode: "split" },
        { terminalColumns: 80, stderr: { write: () => true } },
      ),
    );
    const changedLine = plain.split("\n").find((line) => line.includes("const value"));

    expect(changedLine).toBeDefined();
    expect(changedLine).toContain("▌1 - const value = 1;");
    expect(changedLine).toContain("▌1 + const value = 2;");
    expect(plain).not.toContain("▌  1 +  const value = 2;");
  });

  test("keeps auto mode stacked in static pager output", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";

    const plain = stripAnsi(
      await renderStaticDiffPager(
        patchText,
        { mode: "auto" },
        { terminalColumns: 200, stderr: { write: () => true } },
      ),
    );

    expect(plain).toContain("▌1   -  const value = 1;");
    expect(plain).toContain("▌  1 +  const value = 2;");
  });

  test("uses configured custom themes in static pager output", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";

    const output = await renderStaticDiffPager(
      patchText,
      { theme: "custom" },
      {
        customThemes: {
          custom: { base: "github-dark-default", text: "#123456" },
        },
      },
    );

    expect(stripAnsi(output)).toContain("a.ts modified +1 -1");
    expect(output).toContain("\x1b[38;2;18;52;86m");
  });

  test("applies the shared contrast policy to semantic custom-theme rows", async () => {
    const patchText =
      "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-starting work\n+starting works\n";
    const output = await renderStaticDiffPager(
      patchText,
      { theme: "dawn" },
      {
        customThemes: {
          dawn: {
            base: "github-light-default",
            background: "#faf4ed",
            contextBg: "#faf4ed",
            diffAddedColor: "#3daa8e",
            diffRemovedColor: "#b4647a",
            syntax: { default: "#ea9d34" },
          },
        },
      },
    );

    expect(output).toContain("\x1b[38;2;138;93;31m\x1b[48;2;220;232;222mstarting");
    expect(output).toContain("\x1b[38;2;126;85;28m\x1b[48;2;191;221;208mworks");
  });

  test("emits explicit custom word-diff backgrounds without strengthening them", async () => {
    const patchText =
      "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-starting work\n+starting works\n";
    const output = await renderStaticDiffPager(
      patchText,
      { theme: "exact" },
      {
        customThemes: {
          exact: {
            base: "github-dark-default",
            addedBg: "#112233",
            removedBg: "#221133",
            addedContentBg: "#112234",
            removedContentBg: "#221134",
          },
        },
      },
    );

    expect(output).toContain("\x1b[48;2;17;34;52mworks");
    expect(output).toContain("\x1b[48;2;34;17;52mwork");
  });

  test("composites custom word overlays before emitting opaque ANSI backgrounds", async () => {
    const patchText =
      "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-starting work\n+starting works\n";
    for (const mode of ["stack", "split"] as const) {
      for (const transparentBackground of [false, true]) {
        const output = await renderStaticDiffPager(
          patchText,
          { theme: "dawn-alpha", mode, transparentBackground },
          {
            customThemes: {
              "dawn-alpha": {
                base: "rose-pine-dawn",
                addedBg: "#dce8de",
                removedBg: "#efdddb",
                addedContentBg: "#2e9e4859",
                removedContentBg: "#78081acc",
              },
            },
            terminalColumns: 160,
          },
        );

        expect(output).toContain("\x1b[48;2;159;206;170mworks");
        expect(output).toContain("\x1b[48;2;144;51;65mwork");
        expect(output).not.toMatch(/\x1b\[48;2;[^m]*;[^m]*;[^m]*;[^m]*m/);
      }
    }
  });

  test("composites word overlays against moved rows in both layouts and transparency modes", () => {
    const theme = resolveTheme("moon-alpha", null, {
      "moon-alpha": {
        base: "github-dark-default",
        addedBg: "#dce8de",
        removedBg: "#efdddb",
        movedAddedBg: "#182d23",
        movedRemovedBg: "#431720",
        addedContentBg: "#2e9e4859",
        removedContentBg: "#78081acc",
      },
    });
    const movedAddition = {
      kind: "addition" as const,
      moveKind: "moved" as const,
      sign: "+",
      newLineNumber: 1,
      spans: [
        {
          text: "added-moved",
          bg: theme.addedContentBg,
          bgOverlay: theme.addedContentOverlay,
        },
      ],
    };
    const movedDeletion = {
      kind: "deletion" as const,
      moveKind: "moved" as const,
      sign: "-",
      oldLineNumber: 1,
      spans: [
        {
          text: "removed-moved",
          bg: theme.removedContentBg,
          bgOverlay: theme.removedContentOverlay,
        },
      ],
    };
    const stackRows: DiffRow[] = [
      {
        type: "stack-line",
        key: "moon-alpha:moved:deletion",
        fileId: "moon-alpha",
        hunkIndex: 0,
        cell: movedDeletion,
      },
      {
        type: "stack-line",
        key: "moon-alpha:moved:addition",
        fileId: "moon-alpha",
        hunkIndex: 0,
        cell: movedAddition,
      },
    ];
    const splitRow: DiffRow = {
      type: "split-line",
      key: "moon-alpha:moved:split",
      fileId: "moon-alpha",
      hunkIndex: 0,
      left: { ...movedDeletion, lineNumber: 1 },
      right: { ...movedAddition, lineNumber: 1 },
    };

    for (const transparentBackground of [false, true]) {
      const surfaces = themeRenderSurfaces(theme, transparentBackground);
      const stackOutput = stackRows
        .map((row) => renderStaticStackRow(row, surfaces, 1, { lineNumbers: false }))
        .join("\n");
      const splitOutput = renderStaticSplitRow(splitRow, surfaces, 1, { lineNumbers: false }, 80);

      for (const output of [stackOutput, splitOutput]) {
        expect(output).toContain("\x1b[48;2;32;84;48madded-moved");
        expect(output).toContain("\x1b[48;2;109;11;27mremoved-moved");
        expect(output).not.toContain("\x1b[48;2;159;206;170madded-moved");
        expect(output).not.toContain("\x1b[48;2;144;51;65mremoved-moved");
        expect(output).not.toMatch(/\x1b\[48;2;[^m]*;[^m]*;[^m]*;[^m]*m/);
      }
    }
  });

  test("keeps only added/removed backgrounds when transparent background is requested", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const value = 1;\n+const value = 2;\n const z = 3;\n";

    const output = await renderStaticDiffPager(patchText, {
      transparentBackground: true,
    });
    const lines = output.split("\n");
    const lineWith = (text: string) => lines.find((line) => stripAnsi(line).includes(text)) ?? "";

    expect(stripAnsi(output)).toContain("a.ts modified +1 -1");
    expect(output).toContain("\x1b[38;2;");
    expect(lineWith("@@ -1,3 +1,3 @@")).not.toContain("\x1b[48;2;");
    expect(lineWith("const a = 1;")).not.toContain("\x1b[48;2;");
    expect(lineWith("const z = 3;")).not.toContain("\x1b[48;2;");
    expect(lineWith("const value = 1;")).toContain("\x1b[48;2;");
    expect(lineWith("const value = 2;")).toContain("\x1b[48;2;");
  });

  test("uses opaque theme surfaces to contrast transparent static context rows", async () => {
    const patchText =
      "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n plain prose\n-starting work\n+starting works\n trailing prose\n";
    const output = await renderStaticDiffPager(
      patchText,
      { theme: "dawn", transparentBackground: true },
      {
        customThemes: {
          dawn: {
            base: "github-light-default",
            background: "#faf4ed",
            contextBg: "#faf4ed",
            syntax: { default: "#ea9d34" },
          },
        },
      },
    );
    const contextLine =
      output.split("\n").find((line) => stripAnsi(line).includes("plain prose")) ?? "";

    expect(contextLine).toContain("\x1b[38;2;152;102;34mplain prose");
    expect(contextLine).not.toContain("\x1b[48;2;");
  });

  test("shows semantic file metadata without raw patch headers", async () => {
    const patchText = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..587be6b",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");

    const plain = stripAnsi(await renderStaticDiffPager(patchText));

    expect(plain).toContain("new.txt new file 100644 +1 -0");
    expect(plain).not.toContain("diff --git");
    expect(plain).not.toContain("index 0000000");
  });

  test("falls back to original text with a diagnostic when the patch cannot be parsed", async () => {
    const text = "diff --git incomplete\n";
    let warning = "";

    await expect(
      renderStaticDiffPager(
        text,
        {},
        {
          stderr: {
            write: (chunk) => {
              warning += String(chunk);
              return true;
            },
          },
        },
      ),
    ).resolves.toBe(text);
    expect(warning).toContain("hunk: static pager render failed");
    expect(warning).toContain("falling back to raw diff");
  });

  test("does not pass terminal control sequences through malformed pager fallback", async () => {
    const text = [
      "diff --git incomplete",
      `clipboard ${OSC52_CLIPBOARD}`,
      `clear-screen ${CSI_CLEAR_SCREEN}`,
      `device-control ${DCS_PAYLOAD}`,
      "bell \x07",
      "carriage\rspoof",
      "backspace\bspoof",
      "bare-escape \x1b",
      "",
    ].join("\n");

    const output = stripColorSgr(
      await renderStaticDiffPager(text, {}, { stderr: { write: () => true } }),
    );

    expectNoUnsafeTerminalControls(output);
  });

  test("does not pass terminal controls through parsed file paths or hunk headers", async () => {
    const payload = `${OSC52_CLIPBOARD}${CSI_CLEAR_SCREEN}${DCS_PAYLOAD}${APC_PAYLOAD}${PM_PAYLOAD}${SOS_PAYLOAD}\x07\rspoof\bhidden\x1b`;
    const patchText = [
      `diff --git a/evil${payload}.ts b/evil${payload}.ts`,
      `--- a/evil${payload}.ts`,
      `+++ b/evil${payload}.ts`,
      `@@ -1 +1 @@ ${payload}`,
      "-const value = 1;",
      "+const value = 2;",
      "",
    ].join("\n");

    const output = stripColorSgr(await renderStaticDiffPager(patchText));

    expect(output).toContain("evil");
    expect(output).toContain("@@ -1 +1 @@");
    expectNoUnsafeTerminalControls(output);
  });

  test("does not pass terminal control sequences through parsed diff content", async () => {
    const patchText = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      `-safe${OSC52_CLIPBOARD}${CSI_CLEAR_SCREEN}${DCS_PAYLOAD}\x07\rspoof\bhidden\x1b`,
      "+const value = 2;",
      "",
    ].join("\n");

    const output = stripColorSgr(await renderStaticDiffPager(patchText));

    expectNoUnsafeTerminalControls(output);
  });
});
