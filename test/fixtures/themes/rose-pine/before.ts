type ReviewTheme = {
  name: string;
  contrast: number;
};

// The first hunk exercises types, strings, numbers, functions, and properties.
export const activeTheme: ReviewTheme = {
  name: "generic rose pine",
  contrast: 3,
};

export function describeTheme(theme: ReviewTheme): string {
  return `${theme.name} has ${theme.contrast} semantic colors`;
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
  "hunk diff test/fixtures/themes/rose-pine/before.ts test/fixtures/themes/rose-pine/after.ts --theme github-dark-default";
