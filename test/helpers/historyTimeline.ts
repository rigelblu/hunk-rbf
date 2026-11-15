import { expect } from "bun:test";

/** Assert grouped date headers, commit rails and optional cutoffs share a terminal column. */
export function expectGroupedTimelineTestColumn(
  text: string,
  subjects: readonly string[],
  column: number,
  { ascii = false, cutoffs = false } = {},
) {
  const lines = text.split("\n");
  const node = ascii ? "o-" : "○─";
  const rail = ascii ? "|" : "│";
  const headers = lines.flatMap((line, index) =>
    line.includes(`${node} Commits on`) ? [index] : [],
  );
  expect(headers.length).toBeGreaterThan(0);
  for (const index of headers) {
    expect(lines[index]!.indexOf(node)).toBe(column);
    expect(lines[index + 1]!.indexOf(rail)).toBe(column);
  }
  for (const subject of subjects) {
    const index = lines.findIndex((line) => line.includes(subject));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(lines[index]!.indexOf(rail)).toBe(column);
    expect(lines[index + 1]!.indexOf(rail)).toBe(column);
  }
  if (cutoffs) {
    const tails = lines.filter((line) => /^\s*~\s*$/.test(line));
    expect(tails.length).toBeGreaterThan(0);
    for (const tail of tails) expect(tail.indexOf("~")).toBe(column);
  }
}
