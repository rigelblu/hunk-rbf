import { describe, expect, test } from "bun:test";
import { measureTextWidth } from "../lib/text";
import type { LogQueryState } from "./controller";
import {
  beginRequest,
  decideApply,
  editDraft,
  editRevsetStatusHint,
  editorMode,
  endRequest,
  failureNotice,
  highlightRow,
  insertHighlighted,
  modeLine,
  moveHighlight,
  openRevsetEditor,
  planActionRows,
  planRevsetEditor,
  scrollNotice,
  wrapNoticeText,
  type EditorLayout,
  type EditorRow,
  type RevsetEditorState,
} from "./revsetEditor";

const LAUNCH = "(((trunk()..visible_heads()) | trunk()) ~ root())";
const launchQuery: LogQueryState = {
  editable: true,
  mode: "launch",
  expression: LAUNCH,
  limit: 100,
  generation: 0,
};

/** Flatten a layout into the plain text of each row, as the frames draw them. */
function textRows(layout: EditorLayout) {
  if (layout.kind !== "layout") throw new Error("too small");
  return layout.rows.map((row: EditorRow) => {
    switch (row.kind) {
      case "field":
        return "<field>";
      case "blank":
        return "";
      case "item":
        return `${row.highlighted ? "> " : "  "}${row.text}`;
      case "actions":
        return row.items.map((item) => item.label).join("  ");
      default:
        return row.text;
    }
  });
}

describe("editor state", () => {
  test("opens on the accepted expression with no highlight and the accepted mode", () => {
    const state = openRevsetEditor(launchQuery, ["@-"]);
    expect(state).toMatchObject({ draft: LAUNCH, highlight: null, phase: "editing", notice: "" });
    expect(editorMode(state)).toBe("launch");
    expect(modeLine(editorMode(state), state.limit)).toBe("Launch policy · Limit: 100");
  });

  test("preserves padded legacy metadata while treating unchanged text as a no-op", () => {
    for (const mode of ["launch", "custom"] as const) {
      const expression = '  author("Tom  Hosiawa")  ';
      const state = openRevsetEditor({ ...launchQuery, mode, expression }, []);
      expect(state.draft).toBe(expression);
      expect(state.accepted.expression).toBe(expression);
      expect(editorMode(state)).toBe(mode);
      expect(decideApply(state)).toEqual({ kind: "noop" });
      expect(decideApply(editDraft(state, expression.trim()))).toEqual({ kind: "noop" });
      expect(decideApply(editDraft(state, 'author("Tom Hosiawa")'))).toEqual({
        kind: "apply",
        request: { kind: "apply", expression: 'author("Tom Hosiawa")' },
      });
    }
  });

  test("opens empty with the unavailable notice when the source gave no expression", () => {
    const state = openRevsetEditor({ ...launchQuery, expression: undefined }, []);
    expect(state.draft).toBe("");
    expect(state.notice).toBe("Active revset unavailable. Enter a new revset or Reset.");
    expect(editorMode(state)).toBe("custom");
  });

  test("previews Apply: the accepted mode while the trimmed draft equals the accepted text", () => {
    const custom = openRevsetEditor({ ...launchQuery, mode: "custom", expression: "@-" }, []);
    expect(editorMode(custom)).toBe("custom");
    expect(editorMode(editDraft(custom, " @- "))).toBe("custom");
    // The launch text typed over a custom query is still a custom expression.
    expect(editorMode(editDraft(custom, LAUNCH))).toBe("custom");
    const launch = openRevsetEditor(launchQuery, []);
    expect(editorMode(editDraft(launch, `  ${LAUNCH}  `))).toBe("launch");
    expect(editorMode(editDraft(launch, "@"))).toBe("custom");
    expect(editorMode(editDraft(launch, ""))).toBe("custom");
    expect(modeLine("custom", undefined)).toBe("Custom revset · Limit: none");
  });

  test("any edit clears the highlight and the notice", () => {
    let state = openRevsetEditor(launchQuery, ["a", "b"]);
    state = { ...moveHighlight(state, 1), notice: "Revset not applied: nope", noticeOffset: 3 };
    expect(state.highlight).toBe(0);
    const edited = editDraft(state, "x");
    expect(edited).toMatchObject({ draft: "x", highlight: null, notice: "", noticeOffset: 0 });
    expect(editDraft(edited, "x")).toBe(edited);
  });

  test("moves the highlight with wrap-around, from the end that matches the direction", () => {
    const state = openRevsetEditor(launchQuery, ["a", "b", "c"]);
    expect(moveHighlight(state, 1).highlight).toBe(0);
    expect(moveHighlight(state, -1).highlight).toBe(2);
    expect(moveHighlight(moveHighlight(state, -1), 1).highlight).toBe(0);
    expect(moveHighlight(moveHighlight(state, 1), -1).highlight).toBe(2);
    expect(moveHighlight(openRevsetEditor(launchQuery, []), 1).highlight).toBeNull();
    expect(highlightRow(state, 1).highlight).toBe(1);
    expect(highlightRow(state, 9)).toBe(state);
  });

  test("inserting replaces the whole field and never applies", () => {
    const state = moveHighlight(openRevsetEditor(launchQuery, ["@-", "all()"]), 1);
    const inserted = insertHighlighted(state);
    expect(inserted).toMatchObject({ draft: "@-", highlight: null, phase: "editing" });
    expect(insertHighlighted(openRevsetEditor(launchQuery, ["@-"]))).toMatchObject({
      draft: LAUNCH,
    });
  });
});

describe("decideApply", () => {
  test("refuses a blank draft with the empty-input sentence", () => {
    const state = editDraft(openRevsetEditor(launchQuery, []), "   ");
    expect(decideApply(state)).toEqual({
      kind: "reject",
      notice: "Enter a revset, or choose Reset.",
    });
  });

  test("closes as a no-op when the trimmed draft equals the accepted text", () => {
    const state = openRevsetEditor(launchQuery, []);
    expect(decideApply(state)).toEqual({ kind: "noop" });
    expect(decideApply(editDraft(state, `  ${LAUNCH} `))).toEqual({ kind: "noop" });
  });

  test("applies any other draft, trimmed, including launch text over a custom query", () => {
    const custom = openRevsetEditor({ ...launchQuery, mode: "custom", expression: "@-" }, []);
    expect(decideApply(editDraft(custom, " @ "))).toEqual({
      kind: "apply",
      request: { kind: "apply", expression: "@" },
    });
    expect(decideApply(editDraft(custom, LAUNCH))).toEqual({
      kind: "apply",
      request: { kind: "apply", expression: LAUNCH },
    });
  });

  test("never treats a draft as unchanged when the source gave no expression", () => {
    const state = editDraft(openRevsetEditor({ ...launchQuery, expression: undefined }, []), "@");
    expect(decideApply(state).kind).toBe("apply");
  });
});

describe("requests", () => {
  test("busy states hide the list and name the work; ending one keeps the draft", () => {
    const state = editDraft(openRevsetEditor(launchQuery, ["a"]), "@-");
    const applying = beginRequest(state, { kind: "apply", expression: "@-" });
    expect(applying).toMatchObject({ phase: "applying", notice: "Applying revset…", draft: "@-" });
    expect(beginRequest(state, { kind: "reset" })).toMatchObject({
      phase: "resetting",
      notice: "Restoring launch policy…",
    });
    expect(endRequest(applying, "boom")).toMatchObject({
      phase: "editing",
      notice: "boom",
      draft: "@-",
    });
  });

  test("names a failure by what was attempted", () => {
    expect(failureNotice({ kind: "apply", expression: "x" }, "bad")).toBe(
      "Revset not applied: bad",
    );
    expect(failureNotice({ kind: "reset" }, "Could not run jj.")).toBe(
      "Reset failed: Could not run jj.",
    );
  });
});

describe("wrapNoticeText", () => {
  test("keeps line breaks and leading spaces, and wraps at words", () => {
    expect(
      wrapNoticeText(
        "Revset not applied: Function `missing_function` doesn't exist\nCaused by:  --> 1:53\n  = Function `missing_function` doesn't exist",
        34,
      ),
    ).toEqual([
      "Revset not applied: Function",
      "`missing_function` doesn't exist",
      "Caused by:  --> 1:53",
      "  = Function `missing_function`",
      "doesn't exist",
    ]);
  });

  test("splits a word wider than the region", () => {
    expect(wrapNoticeText("x".repeat(25), 10)).toEqual([
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
    ]);
  });
});

describe("planActionRows", () => {
  test("keeps the legend whole on one row where it fits and wraps by item where it does not", () => {
    expect(planActionRows(false, 68)).toHaveLength(1);
    expect(planActionRows(false, 34).map((row) => row.map((item) => item.label))).toEqual([
      ["[F2] Apply", "[F3] Reset", "[Esc] Cancel"].slice(0, 2),
      ["[Esc] Cancel"],
    ]);
    expect(planActionRows(true, 34).map((row) => row.map((item) => item.label))).toEqual([
      ["[F2] Apply (busy)"],
      ["[F3] Reset (busy)"],
      ["[Esc] Cancel"],
    ]);
    expect(planActionRows(true, 68)).toHaveLength(1);
  });
});

describe("planRevsetEditor frames", () => {
  const idle = openRevsetEditor(launchQuery, []);

  test("idle at 80x32 is the 72-wide, 12-row frame with the empty-list line", () => {
    const layout = planRevsetEditor(idle, { width: 80, height: 32 });
    expect(layout).toMatchObject({
      kind: "layout",
      compact: false,
      frame: { width: 72, height: 12 },
    });
    expect(textRows(layout)).toEqual([
      "<field>",
      "Launch policy · Limit: 100",
      "",
      "No previous inputs yet.",
      "",
      "Enter apply",
      "[F2] Apply  [F3] Reset  [Esc] Cancel",
    ]);
  });

  test("frame width follows the terminal: 96 at 120 columns and 2 narrower than a narrow terminal", () => {
    expect(planRevsetEditor(idle, { width: 120, height: 32 })).toMatchObject({
      frame: { width: 96, height: 12 },
    });
    expect(planRevsetEditor(idle, { width: 40, height: 24 })).toMatchObject({
      frame: { width: 38, height: 13 },
    });
  });

  test("a highlighted previous input shows the list, the restriction and the insert hint", () => {
    const state = moveHighlight(
      editDraft(openRevsetEditor(launchQuery, ["@-", "mine() & bookmarks()"]), "@"),
      1,
    );
    const layout = planRevsetEditor(state, { width: 80, height: 32 });
    expect(layout).toMatchObject({ frame: { width: 72, height: 16 }, listVisible: true });
    expect(textRows(layout)).toEqual([
      "<field>",
      "Custom revset · Limit: 100",
      "",
      "Custom revset: graph links and range review unavailable.",
      "",
      "Previous inputs",
      "> @-",
      "  mine() & bookmarks()",
      "",
      "Tab/↑↓ choose · Enter insert",
      "[F2] Apply  [F3] Reset  [Esc] Cancel",
    ]);
  });

  test("without a highlight the choose hint reads apply, and an empty list drops the choose hint", () => {
    const withList = textRows(
      planRevsetEditor(openRevsetEditor(launchQuery, ["@-"]), { width: 80, height: 32 }),
    );
    expect(withList).toContain("Tab/↑↓ choose · Enter apply");
    expect(textRows(planRevsetEditor(idle, { width: 80, height: 32 }))).toContain("Enter apply");
  });

  test("an error notice sits under the restriction, above the list", () => {
    const state = endRequest(
      editDraft(openRevsetEditor(launchQuery, []), `${LAUNCH} & missing_function()`),
      "Revset not applied: Function `missing_function` doesn't exist\nCaused by:  --> 1:53\n  = Function `missing_function` doesn't exist",
    );
    const layout = planRevsetEditor(state, { width: 80, height: 32 });
    expect(layout).toMatchObject({ frame: { width: 72, height: 18 } });
    expect(textRows(layout)).toEqual([
      "<field>",
      "Custom revset · Limit: 100",
      "",
      "Custom revset: graph links and range review unavailable.",
      "",
      "Revset not applied: Function `missing_function` doesn't exist",
      "Caused by:  --> 1:53",
      "  = Function `missing_function` doesn't exist",
      "",
      "No previous inputs yet.",
      "",
      "Enter apply",
      "[F2] Apply  [F3] Reset  [Esc] Cancel",
    ]);
  });

  test("applying hides the list and the hint, labels the actions busy, and keeps the restriction", () => {
    const state = beginRequest(editDraft(idle, "@-"), { kind: "apply", expression: "@-" });
    const layout = planRevsetEditor(state, { width: 80, height: 32 });
    const rows = textRows(layout);
    expect(rows).toContain("Applying revset…");
    expect(rows).toContain("Custom revset: graph links and range review unavailable.");
    expect(rows.at(-1)).toBe("[F2] Apply (busy)  [F3] Reset (busy)  [Esc] Cancel");
    expect(rows.some((row) => row.startsWith("Enter") || row.includes("Previous"))).toBeFalse();
  });

  test("a notice taller than its region scrolls, with one row given to the scroll hint and none to the Enter hint", () => {
    const long = `Revset not applied: ${Array.from({ length: 150 }, (_, i) => `review/topic-${String(i).padStart(3, "0")},`).join(" ")}`;
    const state = endRequest(editDraft(idle, "team_review()"), long);
    const layout = planRevsetEditor(state, { width: 80, height: 32 });
    expect(layout).toMatchObject({ kind: "layout", frame: { height: 30 } });
    if (layout.kind !== "layout") throw new Error("expected layout");
    expect(layout.noticeScroll).toMatchObject({ visible: 19, offset: 0 });
    const rows = textRows(layout);
    expect(rows.some((row) => /^PgUp\/PgDn scroll · 19\/\d+ lines$/.test(row))).toBeTrue();
    expect(rows.some((row) => row.startsWith("Enter"))).toBeFalse();
    expect(
      rows.some((row) => row.includes("Previous inputs") || row.includes("No previous")),
    ).toBeFalse();
    const scrolled = scrollNotice(state, layout, 19);
    expect(scrolled.noticeOffset).toBe(19);
    expect(scrollNotice(state, layout, -5)).toBe(state);
    const far = scrollNotice(state, layout, 10_000);
    expect(far.noticeOffset).toBe(layout.noticeScroll!.maxOffset);
  });

  test("a notice that fits whole replaces nothing it does not have to", () => {
    const state = endRequest(editDraft(idle, "x"), "Reset failed: Could not run jj.");
    const rows = textRows(planRevsetEditor(state, { width: 80, height: 32 }));
    expect(rows).toContain("Reset failed: Could not run jj.");
    expect(rows.some((row) => row.startsWith("PgUp"))).toBeFalse();
  });

  test("lists at most eight previous inputs and counts the rest", () => {
    const previous = Array.from({ length: 12 }, (_, i) => `rev-${i}`);
    const layout = planRevsetEditor(openRevsetEditor(launchQuery, previous), {
      width: 80,
      height: 40,
    });
    const rows = textRows(layout);
    expect(rows.filter((row) => row.startsWith("  rev-"))).toHaveLength(8);
    expect(rows).toContain("8/12 suggestions");
    // Moving past the window scrolls it to keep the highlight visible.
    let state = openRevsetEditor(launchQuery, previous);
    for (let step = 0; step < 10; step += 1) state = moveHighlight(state, 1);
    const scrolled = textRows(planRevsetEditor(state, { width: 80, height: 40 }));
    expect(scrolled.find((row) => row.startsWith("> "))).toBe("> rev-9");
  });
});

describe("planRevsetEditor compact frames", () => {
  const idle = openRevsetEditor(launchQuery, []);

  test("at 40x12 the frame is 38x11 with a three-row body and the legend on two rows", () => {
    const layout = planRevsetEditor(idle, { width: 40, height: 12 });
    expect(layout).toMatchObject({
      kind: "layout",
      compact: true,
      frame: { width: 38, height: 11 },
    });
    expect(textRows(layout)).toEqual([
      "<field>",
      "Launch policy · Limit: 100",
      "No previous inputs yet.",
      "",
      "",
      "Enter apply",
      "[F2] Apply  [F3] Reset",
      "[Esc] Cancel",
    ]);
  });

  test("fills the body with the notice, then the list, then the restriction only if both rows fit", () => {
    const failed = endRequest(
      editDraft(openRevsetEditor(launchQuery, ["@-"]), "@-"),
      "Reset failed: Could not run jj.",
    );
    expect(textRows(planRevsetEditor(failed, { width: 40, height: 12 })).slice(2, 5)).toEqual([
      "Reset failed: Could not run jj.",
      "Previous inputs",
      "  @-",
    ]);
    const two = openRevsetEditor(launchQuery, ["@-", "mine() & bookmarks()"]);
    expect(
      textRows(
        planRevsetEditor(moveHighlight(editDraft(two, "@"), 1), { width: 40, height: 12 }),
      ).slice(2, 5),
    ).toEqual(["Previous inputs", "> @-", "1/2 suggestions"]);
    const emptyDraft = editDraft(idle, "");
    // The restriction needs two rows here; notice (1) + empty list (1) leave only one.
    expect(
      textRows(
        planRevsetEditor(endRequest(emptyDraft, "Enter a revset, or choose Reset."), {
          width: 40,
          height: 12,
        }),
      ).slice(2, 5),
    ).toEqual(["Enter a revset, or choose Reset.", "No previous inputs yet.", ""]);
  });

  test("a long notice shows two lines and the scroll row, replacing the list", () => {
    const state = endRequest(
      editDraft(idle, "x"),
      "Revset not applied: Function `missing_function` doesn't exist\nCaused by:  --> 1:53\n  = Function `missing_function` doesn't exist",
    );
    const layout = planRevsetEditor(state, { width: 40, height: 12 });
    if (layout.kind !== "layout") throw new Error("expected layout");
    expect(layout.noticeScroll).toMatchObject({ visible: 2, total: 5 });
    expect(textRows(layout).slice(2, 5)).toEqual([
      "Revset not applied: Function",
      "`missing_function` doesn't exist",
      "PgUp/PgDn scroll · 2/5 lines",
    ]);
    expect(layout.listVisible).toBeFalse();
    // The notice lost lines to scrolling, so the hint gave way before it.
    expect(textRows(layout)).not.toContain("Enter apply");
  });

  test("busy compact editor shows the notice and the restriction, and three action rows", () => {
    const state = beginRequest(editDraft(idle, "@-"), { kind: "apply", expression: "@-" });
    expect(textRows(planRevsetEditor(state, { width: 40, height: 12 }))).toEqual([
      "<field>",
      "Custom revset · Limit: 100",
      "Applying revset…",
      "Custom revset: graph links and",
      "range review unavailable.",
      "[F2] Apply (busy)",
      "[F3] Reset (busy)",
      "[Esc] Cancel",
    ]);
  });
});

describe("planRevsetEditor too small", () => {
  const idle = openRevsetEditor(launchQuery, []);

  test("is too small under 24 columns or 8 rows, and where the controls cannot fit", () => {
    for (const size of [
      { width: 20, height: 7 },
      { width: 23, height: 24 },
      { width: 40, height: 7 },
      { width: 24, height: 8 },
    ])
      expect(planRevsetEditor(idle, size)).toEqual({ kind: "too-small" });
    expect(planRevsetEditor(idle, { width: 24, height: 12 }).kind).toBe("layout");
    expect(planRevsetEditor(idle, { width: 40, height: 9 }).kind).toBe("layout");
  });
});

describe("editRevsetStatusHint", () => {
  const hint = "v select · Enter open · F10 menu";
  test("goes in front only where the longer hint fits beside the status text", () => {
    expect(editRevsetStatusHint(hint, "L", "Jujutsu · 5 commits", 80)).toBe(
      `L edit revset · ${hint}`,
    );
    expect(editRevsetStatusHint(hint, "L", "Selected newest; previous not loaded.", 80)).toBe(hint);
  });

  test("leaves the hint alone with no key or no hint", () => {
    expect(editRevsetStatusHint(hint, undefined, "Jujutsu · 5 commits", 80)).toBe(hint);
    expect(editRevsetStatusHint("", "L", "Jujutsu · 5 commits", 50)).toBe("");
  });

  test("matches the documented thresholds: 71 columns beside the idle status, and no room beside a notice", () => {
    expect(editRevsetStatusHint(hint, "L", "Jujutsu · 5 commits", 70)).toBe(hint);
    expect(editRevsetStatusHint(hint, "L", "Jujutsu · 5 commits", 71)).toBe(
      `L edit revset · ${hint}`,
    );
    const long = "↑↓ move · v or Shift-↑↓ select · Enter open · / search · F10 menu";
    const notice = "Selected newest; previous not loaded.";
    expect(editRevsetStatusHint(long, "L", notice, 120)).toBe(long);
    expect(editRevsetStatusHint(hint, "L", notice, 80)).toBe(hint);
    expect(editRevsetStatusHint(long, "L", "Jujutsu · 5 commits", 120)).toBe(
      `L edit revset · ${long}`,
    );
  });
});

describe("planRevsetEditor never draws outside its frame", () => {
  const long = `Revset not applied: ${Array.from({ length: 150 }, (_, i) => `review/topic-${String(i).padStart(3, "0")},`).join(" ")}`;
  const states = () => {
    const base = openRevsetEditor(launchQuery, []);
    const withList = (count: number) =>
      openRevsetEditor(
        launchQuery,
        Array.from({ length: count }, (_, index) => `previous-${index} & mine()`),
      );
    const list = [
      ["launch draft", base],
      ["custom draft", editDraft(base, "@-")],
      ["empty draft", editDraft(base, "")],
    ] as Array<[string, RevsetEditorState]>;
    for (const count of [0, 2, 9]) {
      const opened = editDraft(withList(count), "@");
      list.push([`${count} previous`, opened]);
      list.push([`${count} previous, highlighted`, moveHighlight(opened, 1)]);
    }
    const custom = editDraft(base, "@-");
    list.push(["applying", beginRequest(custom, { kind: "apply", expression: "@-" })]);
    list.push(["resetting", beginRequest(custom, { kind: "reset" }, { height: 14, top: 4 })]);
    list.push(["short error", endRequest(custom, "Reset failed: Could not run jj.")]);
    list.push(["long error", endRequest(custom, long)]);
    list.push(["unavailable", openRevsetEditor({ ...launchQuery, expression: undefined }, [])]);
    return list;
  };

  test.each(Array.from({ length: 111 }, (_, index) => 20 + index))(
    "at every size and state the frame fits the rows, its rows fit the frame, and the actions stay at %d columns",
    (width) => {
      for (let height = 6; height <= 40; height += 1) {
        for (const [name, state] of states()) {
          const layout = planRevsetEditor(state, { width, height });
          if (layout.kind === "too-small") continue;
          const compact = layout.compact;
          const available = height - (compact ? 1 : 2);
          const where = `${name} at ${width}x${height}`;
          expect(layout.frame.height, where).toBeLessThanOrEqual(available);
          expect(layout.frame.height, where).toBe((compact ? 3 : 5) + layout.rows.length);
          expect(layout.frame.top, where).toBeGreaterThanOrEqual(0);
          expect(layout.frame.top + layout.frame.height, where).toBeLessThanOrEqual(height);
          expect(layout.frame.width, where).toBeLessThanOrEqual(width - 2);
          const ids = layout.rows.flatMap((row) =>
            row.kind === "actions" ? row.items.map((item) => item.id) : [],
          );
          expect(ids.toSorted(), where).toEqual(["apply", "cancel", "reset"]);
          expect(layout.rows[0]?.kind, where).toBe("field");
          // A failure or a busy notice may take the mode line's row on a very short terminal.
          const noticeDriven = /error|applying|resetting/.test(name);
          expect(["mode", ...(noticeDriven ? ["text"] : [])], where).toContain(
            layout.rows[1]?.kind ?? "none",
          );
          for (const row of layout.rows) {
            const text =
              row.kind === "actions"
                ? row.items.map((item) => item.label).join("  ")
                : row.kind === "mode" || row.kind === "text" || row.kind === "hint"
                  ? row.text
                  : row.kind === "item"
                    ? `  ${row.text}`
                    : "";
            expect(measureTextWidth(text), where).toBeLessThanOrEqual(layout.bodyWidth);
          }
        }
      }
    },
  );

  test("short terminals drop optional rows before the controls: hint last, never Cancel", () => {
    const state = moveHighlight(editDraft(openRevsetEditor(launchQuery, ["a", "b"]), "@"), 1);
    for (const height of [9, 10, 11]) {
      const layout = planRevsetEditor(state, { width: 80, height });
      if (layout.kind !== "layout") throw new Error(`expected a layout at ${height} rows`);
      expect(layout.frame.height).toBeLessThanOrEqual(height - 1);
      expect(layout.rows.some((row) => row.kind === "actions")).toBeTrue();
    }
    expect(planRevsetEditor(state, { width: 80, height: 8 }).kind).toBe("layout");
    expect(planRevsetEditor(state, { width: 80, height: 7 }).kind).toBe("too-small");
  });

  test("the 14-versus-15-row switch picks the compact or the normal frame", () => {
    const state = openRevsetEditor(launchQuery, []);
    expect(planRevsetEditor(state, { width: 80, height: 14 })).toMatchObject({ compact: true });
    expect(planRevsetEditor(state, { width: 80, height: 15 })).toMatchObject({ compact: false });
  });
});

describe("planRevsetEditor holds its place", () => {
  const frameOf = (state: RevsetEditorState, size: { width: number; height: number }) => {
    const layout = planRevsetEditor(state, size);
    if (layout.kind !== "layout") throw new Error("expected a layout");
    return layout.frame;
  };

  for (const size of [
    { width: 80, height: 32 },
    { width: 120, height: 32 },
    { width: 40, height: 24 },
  ]) {
    test(`the top row does not move with mode, highlight, insert, Apply or Reset at ${size.width}x${size.height}`, () => {
      const base = openRevsetEditor(launchQuery, ["@-", "mine() & bookmarks()"]);
      const launchFrame = frameOf(base, size);
      const custom = editDraft(base, "@");
      const customFrame = frameOf(custom, size);
      const highlighted = moveHighlight(custom, 1);
      const inserted = insertHighlighted(highlighted);
      const frames = [
        launchFrame,
        customFrame,
        frameOf(highlighted, size),
        frameOf(inserted, size),
        // Back to the launch text: the restriction goes and the frame ends higher.
        frameOf(editDraft(inserted, launchQuery.expression!), size),
      ];
      for (const frame of frames) expect(frame.top).toBe(launchFrame.top);
      expect(launchFrame.height).toBeLessThan(customFrame.height);
      expect(launchFrame.top + launchFrame.height).toBeLessThan(
        customFrame.top + customFrame.height,
      );

      // Apply and Reset start from whatever is on screen, and keep both its top and its height.
      for (const from of [custom, base]) {
        const before = frameOf(from, size);
        for (const request of [
          { kind: "apply", expression: "@" } as const,
          { kind: "reset" } as const,
        ]) {
          const busy = beginRequest(from, request, { height: before.height, top: before.top });
          const during = frameOf(busy, size);
          expect(during.top).toBe(before.top);
          expect(during.height).toBe(before.height);
          // The freed list rows stay blank, so the legend sits where it was.
          const rows = planRevsetEditor(busy, size);
          if (rows.kind !== "layout") throw new Error("expected a layout");
          expect(rows.rows.filter((row) => row.kind === "item" || row.kind === "hint")).toEqual([]);
        }
      }
    });

    test(`an error notice may grow the frame and re-centre it at ${size.width}x${size.height}`, () => {
      const custom = editDraft(openRevsetEditor(launchQuery, []), "@");
      const quiet = frameOf(custom, size);
      const failed = frameOf(
        endRequest(custom, "Revset not applied: Function `x` doesn't exist\nCaused by:  --> 1:1"),
        size,
      );
      expect(failed.height).toBeGreaterThan(quiet.height);
      expect(failed.top).toBe(Math.floor((size.height - failed.height) / 2));
      expect(failed.top).toBeLessThan(quiet.top);
    });
  }

  test("compact frames are unchanged by the position rule", () => {
    const size = { width: 40, height: 12 };
    const launch = frameOf(openRevsetEditor(launchQuery, []), size);
    const custom = frameOf(editDraft(openRevsetEditor(launchQuery, []), "@"), size);
    expect(launch).toEqual({ width: 38, height: 11, top: 0 });
    expect(custom).toEqual(launch);
  });
});

describe("planRevsetEditor sweeps for the list, the error and the busy size", () => {
  const long = `Revset not applied: ${Array.from({ length: 40 }, (_, i) => `line ${i} of a long provider error`).join("\n")}`;
  const previous = (count: number) =>
    Array.from({ length: count }, (_, index) => `author("someone-${index}") & mine()`);
  const sizes: Array<{ width: number; height: number }> = [];
  for (let width = 24; width <= 130; width += 1)
    for (let height = 8; height <= 40; height += 1) sizes.push({ width, height });

  test("a list that a smaller terminal shows is never lost at a larger one", () => {
    for (const count of [1, 2, 9]) {
      const base = openRevsetEditor(launchQuery, previous(count));
      const states: RevsetEditorState[] = [
        base,
        editDraft(base, "@-"),
        moveHighlight(editDraft(base, "@-"), 1),
      ];
      for (const size of sizes) {
        for (const state of states) {
          const forced = planRevsetEditor(state, size, { compact: true });
          const actual = planRevsetEditor(state, size);
          if (forced.kind === "layout" && forced.listVisible) {
            expect(actual.kind, `${count} previous at ${size.width}x${size.height}`).toBe("layout");
            if (actual.kind === "layout")
              expect(
                actual.listVisible,
                `${count} previous at ${size.width}x${size.height}`,
              ).toBeTrue();
          }
        }
      }
    }
  });

  test("at 15 rows the list still shows, as it does at 14", () => {
    const state = editDraft(openRevsetEditor(launchQuery, ["main", "@-"]), "@-");
    for (const width of [24, 40, 80, 120]) {
      for (const height of [14, 15, 16]) {
        const layout = planRevsetEditor(state, { width, height });
        if (layout.kind !== "layout") throw new Error(`expected a layout at ${width}x${height}`);
        expect(layout.listVisible, `${width}x${height}`).toBeTrue();
      }
    }
  });

  test.each(Array.from({ length: 107 }, (_, index) => 24 + index))(
    "a failed Apply shows its error at every size the editor opens at %d columns",
    (width) => {
      const base = editDraft(openRevsetEditor(launchQuery, previous(2)), "@-");
      for (const notice of [
        "Revset not applied: Function `x` doesn't exist",
        long,
        "Reset failed: Could not run jj.",
      ]) {
        const failed = endRequest(base, notice);
        for (const size of sizes.filter((size) => size.width === width)) {
          if (planRevsetEditor(base, size).kind === "too-small") continue;
          const layout = planRevsetEditor(failed, size);
          const where = `${size.width}x${size.height}`;
          expect(layout.kind, where).toBe("layout");
          if (layout.kind !== "layout") continue;
          expect(
            layout.rows.some((row) => row.kind === "text" && row.tone === "error"),
            where,
          ).toBeTrue();
          // The hint is what gives way first.
          if (layout.frame.height >= (layout.compact ? 9 : 14))
            expect(layout.rows.some((row) => row.kind === "actions")).toBeTrue();
        }
      }
    },
  );

  test("a busy frame keeps the size it had and never covers the status row", () => {
    for (const count of [0, 2, 9]) {
      const base = openRevsetEditor(launchQuery, previous(count));
      for (const draft of ["@-", launchQuery.expression!]) {
        const idleState = editDraft(base, draft);
        for (const size of sizes) {
          if (size.height < 15) continue;
          const idle = planRevsetEditor(idleState, size);
          if (idle.kind !== "layout" || idle.compact) continue;
          for (const request of [
            { kind: "apply", expression: draft } as const,
            { kind: "reset" } as const,
          ]) {
            const busy = planRevsetEditor(
              beginRequest(idleState, request, { height: idle.frame.height, top: idle.frame.top }),
              size,
            );
            const where = `${count} previous, ${draft} at ${size.width}x${size.height}`;
            expect(busy.kind, where).toBe("layout");
            if (busy.kind !== "layout") continue;
            const legendRows = busy.rows.filter((row) => row.kind === "actions").length;
            expect(busy.frame.height, where).toBeLessThanOrEqual(
              Math.max(idle.frame.height, 5 + 2 + legendRows),
            );
            expect(busy.frame.top + busy.frame.height, where).toBeLessThanOrEqual(size.height - 1);
          }
        }
      }
    }
  });

  test.each(Array.from({ length: 107 }, (_, index) => 24 + index))(
    "a source with no revset keeps its style and top row from open to the first keystroke at %d columns",
    (width) => {
      for (const count of [1, 2, 9]) {
        const opened = openRevsetEditor({ ...launchQuery, expression: undefined }, previous(count));
        for (const typed of [editDraft(opened, "@"), editDraft(opened, "@-")]) {
          for (const size of sizes.filter((size) => size.width === width)) {
            const before = planRevsetEditor(opened, size);
            const after = planRevsetEditor(typed, size);
            expect(before.kind, `${count} previous at ${size.width}x${size.height}`).toBe(
              after.kind,
            );
            if (before.kind !== "layout" || after.kind !== "layout") continue;
            const where = `${count} previous at ${size.width}x${size.height}`;
            expect(after.compact, where).toBe(before.compact);
            expect(after.frame.top, where).toBe(before.frame.top);
          }
        }
      }
    },
  );

  test("a failed Apply plans the whole error, or ends it with an ellipsis or a scroll row, and the hint goes first", () => {
    const base = editDraft(openRevsetEditor(launchQuery, previous(2)), "@-");
    for (const notice of [
      "Revset not applied: Revision `nosuch` doesn't exist",
      "Revset not applied: Function `x` doesn't exist\nHint: Did you mean `y`, `z`?",
    ]) {
      for (const size of sizes) {
        if (planRevsetEditor(base, size).kind !== "layout") continue;
        const layout = planRevsetEditor(endRequest(base, notice), size);
        const where = `${notice.split("\n").length} lines at ${size.width}x${size.height}`;
        if (layout.kind !== "layout") throw new Error(`too small ${where}`);
        const lines = wrapNoticeText(notice, layout.bodyWidth);
        const errorRows = layout.rows.flatMap((row) =>
          row.kind === "text" && row.tone === "error" ? [row.text] : [],
        );
        const scrollRow = layout.rows.some(
          (row) => row.kind === "text" && row.text.startsWith("PgUp/PgDn scroll"),
        );
        if (errorRows.length === lines.length && !scrollRow) {
          expect(errorRows, where).toEqual(lines);
          continue;
        }
        // An error line is out of view: it says so, and the Enter hint is gone.
        expect(scrollRow || errorRows.at(-1)?.endsWith("…"), where).toBeTrue();
        expect(
          layout.rows.some((row) => row.kind === "hint"),
          where,
        ).toBeFalse();
      }
    }
  });

  test("a two-line error at 40 columns drops the hint, not its second line", () => {
    const base = editDraft(openRevsetEditor(launchQuery, []), "@-");
    const failed = endRequest(base, "Revset not applied: Revision `nosuch` doesn't exist");
    for (const height of [10, 15]) {
      const layout = planRevsetEditor(failed, { width: 40, height });
      if (layout.kind !== "layout") throw new Error("expected layout");
      const rows = textRows(layout);
      expect(rows, `40x${height}`).toContain("Revset not applied: Revision");
      expect(rows, `40x${height}`).toContain("`nosuch` doesn't exist");
      expect(rows, `40x${height}`).toContain("Custom revset · Limit: 100");
      expect(
        rows.some((row) => row.startsWith("Enter")),
        `40x${height}`,
      ).toBeFalse();
    }
  });
});

describe("busy frames keep their style and their notice", () => {
  const busyFrom = (state: RevsetEditorState, size: { width: number; height: number }) => {
    const idle = planRevsetEditor(state, size);
    if (idle.kind !== "layout") throw new Error("expected a layout");
    const busy = planRevsetEditor(
      beginRequest(
        state,
        { kind: "apply", expression: "x" },
        { height: idle.frame.height, top: idle.frame.top, compact: idle.compact },
      ),
      size,
    );
    if (busy.kind !== "layout") throw new Error("expected a busy layout");
    return { idle, busy };
  };
  const notices = (layout: Extract<EditorLayout, { kind: "layout" }>) =>
    layout.rows.flatMap((row) => (row.kind === "text" ? [row.text] : []));

  test("a compact frame chosen for the list at 15 rows stays compact while busy", () => {
    const state = editDraft(openRevsetEditor(launchQuery, ["@-"]), "x");
    const { idle, busy } = busyFrom(state, { width: 40, height: 15 });
    expect(idle.compact).toBeTrue();
    expect(busy.compact).toBeTrue();
    expect(busy.frame).toEqual(idle.frame);
    expect(notices(busy)).toContain("Applying revset…");
  });

  test("the busy notice stays wherever the frame has the row for it", () => {
    for (const size of [
      { width: 50, height: 24 },
      { width: 40, height: 16 },
      { width: 40, height: 24 },
      { width: 80, height: 32 },
    ]) {
      const state = editDraft(openRevsetEditor(launchQuery, ["@-"]), launchQuery.expression!);
      const { idle, busy } = busyFrom(state, size);
      expect(busy.frame.height, `${size.width}x${size.height}`).toBe(idle.frame.height);
      expect(notices(busy), `${size.width}x${size.height}`).toContain("Applying revset…");
    }
  });
  test.each(Array.from({ length: 107 }, (_, index) => 24 + index))(
    "a busy frame names its work at every size the editor opens, and never grows at %d columns",
    (width) => {
      const previous = (count: number) =>
        Array.from({ length: count }, (_, index) => `mine-${index}`);
      for (const count of [0, 1, 2, 9]) {
        for (const draft of ["@-", launchQuery.expression!]) {
          for (const source of [launchQuery, { ...launchQuery, expression: undefined }]) {
            const state = editDraft(openRevsetEditor(source, previous(count)), draft);
            for (let height = 8; height <= 40; height += 1) {
              const size = { width, height };
              const idle = planRevsetEditor(state, size);
              if (idle.kind !== "layout") continue;
              for (const [request, text] of [
                [{ kind: "apply", expression: draft }, "Applying revset…"],
                [{ kind: "reset" }, "Restoring launch policy…"],
              ] as const) {
                const where = `${count} previous, ${text} at ${width}x${height}`;
                const busy = planRevsetEditor(
                  beginRequest(state, request, {
                    height: idle.frame.height,
                    top: idle.frame.top,
                    compact: idle.compact,
                  }),
                  size,
                );
                if (busy.kind !== "layout") throw new Error(`too small ${where}`);
                // A notice wider than the frame wraps; its first line is what must show.
                const first = wrapNoticeText(text, busy.bodyWidth)[0]!;
                expect(
                  notices(busy).some((row) => row.startsWith(first.slice(0, 8))),
                  where,
                ).toBeTrue();
                expect(busy.frame.height, where).toBeLessThanOrEqual(idle.frame.height);
              }
            }
          }
        }
      }
    },
  );
});
