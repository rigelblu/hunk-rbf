import { describe, expect, test } from "bun:test";
import { PREVIOUS_INPUTS_LIMIT, PreviousInputs } from "./previousInputs";

describe("PreviousInputs", () => {
  test("lists the most recent expression first and trims what it stores", () => {
    const inputs = new PreviousInputs();
    inputs.record("@-");
    inputs.record("  trunk()..@  ");
    expect(inputs.list()).toEqual(["trunk()..@", "@-"]);
  });

  test("moves a re-applied expression to the front without duplicating it", () => {
    const inputs = new PreviousInputs();
    for (const text of ["a", "b", "c", " a "]) inputs.record(text);
    expect(inputs.list()).toEqual(["a", "c", "b"]);
  });

  test("ignores a blank expression", () => {
    const inputs = new PreviousInputs();
    inputs.record("   ");
    expect(inputs.list()).toEqual([]);
  });

  test("keeps the newest 50 and drops the oldest", () => {
    const inputs = new PreviousInputs();
    for (let index = 0; index < PREVIOUS_INPUTS_LIMIT + 5; index += 1)
      inputs.record(`rev-${index}`);
    const list = inputs.list();
    expect(list).toHaveLength(50);
    expect(list[0]).toBe("rev-54");
    expect(list.at(-1)).toBe("rev-5");
  });

  test("hands out a copy a caller cannot use to change the list", () => {
    const inputs = new PreviousInputs();
    inputs.record("a");
    const list = inputs.list() as string[];
    expect(() => list.push("b")).toThrow();
    expect(inputs.list()).toEqual(["a"]);
  });

  test("records only an Apply that a provider accepted", () => {
    const inputs = new PreviousInputs();
    const apply = { kind: "apply", expression: " @- " } as const;
    inputs.recordOutcome(apply, { status: "failed", reason: "nope" });
    inputs.recordOutcome(apply, { status: "aborted" });
    inputs.recordOutcome(apply, { status: "obsolete" });
    inputs.recordOutcome({ kind: "reset" }, { status: "applied", mode: "launch" });
    expect(inputs.list()).toEqual([]);
    inputs.recordOutcome(apply, { status: "applied", mode: "custom", expression: "@-" });
    expect(inputs.list()).toEqual(["@-"]);
  });
});
