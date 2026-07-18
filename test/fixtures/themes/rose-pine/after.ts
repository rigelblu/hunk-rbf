type ReviewTheme = {
  name: string;
  contrast: number;
  native: boolean;
};

// The first hunk exercises types, strings, numbers, functions, and properties.
export const activeTheme: ReviewTheme = {
  name: "Zed Legacy Rosé Pine",
  contrast: 4.5,
  native: true,
};

export function describeTheme(theme: ReviewTheme): string {
  return `${theme.name} has readable native diff colors`;
}

// Stable context one.
// Stable context two.
// Stable context three.
// Stable context four.
// Stable context five.
// Stable context six.
// Stable context seven.
// Stable context eight.

export const previewCommand =
  "hunk diff test/fixtures/themes/rose-pine/before.ts test/fixtures/themes/rose-pine/after.ts --theme rose-pine-dawn --layout split";
