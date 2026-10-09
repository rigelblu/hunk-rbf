import type { Session } from "tuistory";
import { setDetectedTerminalColors } from "../../packages/hunk/src/core/theme/terminalColors";
import { ensureMinimumContrast } from "../../packages/hunk/src/ui/lib/color";
import { resolveTheme } from "../../packages/hunk/src/ui/themes";

/** Normalized 16-color ANSI palette plus default foreground and background. */
export interface TestTerminalPalette {
  foreground: string;
  background: string;
  ansi: readonly string[];
}

/** Initial dark terminal palette for PTY theme tests. */
export const TEST_TERMINAL_PALETTE_A: TestTerminalPalette = {
  foreground: "#f0f0f0",
  background: "#101010",
  ansi: [
    "#101010",
    "#ff4040",
    "#40ff40",
    "#ffff40",
    "#4080ff",
    "#ff40ff",
    "#40ffff",
    "#f0f0f0",
    "#808080",
    "#ff7070",
    "#70ff70",
    "#ffff70",
    "#70a0ff",
    "#ff70ff",
    "#70ffff",
    "#ffffff",
  ],
};

/** Second dark terminal palette for PTY theme tests. */
export const TEST_TERMINAL_PALETTE_B: TestTerminalPalette = {
  foreground: "#e8e8e8",
  background: "#202020",
  ansi: [
    "#202020",
    "#dd3355",
    "#00aa55",
    "#ccaa33",
    "#55aaff",
    "#aa66ff",
    "#33bbbb",
    "#e8e8e8",
    "#777777",
    "#ff6688",
    "#33cc77",
    "#ddbb55",
    "#77bbff",
    "#bb88ff",
    "#55dddd",
    "#ffffff",
  ],
};

/** Third dark terminal palette for PTY theme tests. */
export const TEST_TERMINAL_PALETTE_C: TestTerminalPalette = {
  foreground: "#d8d8d8",
  background: "#181818",
  ansi: [
    "#181818",
    "#ee2244",
    "#00bb66",
    "#bbaa22",
    "#4499ee",
    "#9955ee",
    "#22aaaa",
    "#d8d8d8",
    "#666666",
    "#ee5577",
    "#22bb66",
    "#ccaa44",
    "#66aacc",
    "#aa77ee",
    "#44cccc",
    "#ffffff",
  ],
};

/** Initial light terminal palette for PTY theme tests. */
export const TEST_TERMINAL_LIGHT_PALETTE_A: TestTerminalPalette = {
  foreground: "#1f2328",
  background: "#ffffff",
  ansi: [
    "#24292f",
    "#cf222e",
    "#1a7f37",
    "#9a6700",
    "#0969da",
    "#8250df",
    "#1b7c83",
    "#6e7781",
    "#57606a",
    "#a40e26",
    "#116329",
    "#7d4e00",
    "#0550ae",
    "#6639ba",
    "#134e56",
    "#24292f",
  ],
};

/** Second light terminal palette for PTY theme tests. */
export const TEST_TERMINAL_LIGHT_PALETTE_B: TestTerminalPalette = {
  foreground: "#2e3440",
  background: "#eceff4",
  ansi: [
    "#3b4252",
    "#bf616a",
    "#a3be8c",
    "#ebcb8b",
    "#81a1c1",
    "#b48ead",
    "#88c0d0",
    "#e5e9f0",
    "#4c566a",
    "#bf616a",
    "#a3be8c",
    "#ebcb8b",
    "#81a1c1",
    "#b48ead",
    "#8fbcbb",
    "#eceff4",
  ],
};

/** Third light terminal palette for PTY theme tests. */
export const TEST_TERMINAL_LIGHT_PALETTE_C: TestTerminalPalette = {
  foreground: "#4c4f69",
  background: "#eff1f5",
  ansi: [
    "#5c5f77",
    "#d20f39",
    "#40a02b",
    "#df8e1d",
    "#1e66f5",
    "#8839ef",
    "#179299",
    "#acb0be",
    "#6c6f85",
    "#d20f39",
    "#40a02b",
    "#df8e1d",
    "#1e66f5",
    "#8839ef",
    "#179299",
    "#bcc0cc",
  ],
};

/** Derive the expected final colors on an added diff row for a terminal palette. */
export function deriveAddedRowColorsTest(
  palette: TestTerminalPalette,
  appearance: "light" | "dark" = "dark",
) {
  setDetectedTerminalColors({
    foreground: palette.foreground,
    background: palette.background,
    palette: [...palette.ansi],
  });
  const theme = resolveTheme("terminal", appearance);
  return {
    keyword: ensureMinimumContrast(palette.ansi[5]!, theme.addedBg),
    text: ensureMinimumContrast(palette.foreground, theme.addedBg),
  };
}

const TERMINAL_QUERY_PATTERN = /\x1b\](?:4;(\d+)|(\d+));\?(?:\x07|\x1b\\)|\x1b\[c/g;

/** Answer Hunk and OpenTUI color queries from a mutable terminal palette. */
export function createTestTerminalResponder(initialPalette: TestTerminalPalette) {
  let palette = initialPalette;
  let buffer = "";

  return {
    getPalette() {
      return palette;
    },
    setPalette(nextPalette: TestTerminalPalette) {
      palette = nextPalette;
    },
    respond(data: string, session: Session) {
      buffer += data;
      TERMINAL_QUERY_PATTERN.lastIndex = 0;
      let consumedThrough = 0;
      let response = "";
      let match: RegExpExecArray | null;

      while ((match = TERMINAL_QUERY_PATTERN.exec(buffer))) {
        consumedThrough = TERMINAL_QUERY_PATTERN.lastIndex;
        const paletteIndex = match[1] === undefined ? undefined : Number(match[1]);
        const specialIndex = match[2] === undefined ? undefined : Number(match[2]);
        if (paletteIndex !== undefined) {
          const color = palette.ansi[paletteIndex];
          if (color) response += `\x1b]4;${paletteIndex};${color}\x07`;
        } else if (specialIndex !== undefined) {
          const color = specialIndex === 11 ? palette.background : palette.foreground;
          response += `\x1b]${specialIndex};${color}\x07`;
        } else {
          response += "\x1b[?62;22c";
        }
      }

      buffer = buffer.slice(consumedThrough).slice(-64);
      if (response) session.writeRaw(response);
    },
  };
}

/** Wait until one exact foreground color paints the expected terminal text. */
export async function waitForForegroundTest(
  session: Session,
  color: string,
  needle: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let coloredText = "";
  while (Date.now() < deadline) {
    coloredText = await session.text({ immediate: true, only: { foreground: color } });
    if (coloredText.includes(needle)) return coloredText;
    await session.waitIdle({ timeout: 100 });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const spans = session
    .getTerminalData()
    .lines.flatMap((line) => line.spans)
    .filter((s) => s.text.trim().length > 0)
    .map((s) => `[fg=${s.fg},bg=${s.bg}: "${s.text}"]`)
    .join(" ");

  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)} in foreground ${color}. Last colored text:\n${coloredText}\nAll non-empty spans:\n${spans}`,
  );
}
