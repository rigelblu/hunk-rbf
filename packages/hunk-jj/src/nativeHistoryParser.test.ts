import { describe, expect, test } from "bun:test";
import { parseJjHistory } from "./history";
import {
  NativeHistoryParser,
  NATIVE_BODY_MARKERS,
  NATIVE_HISTORY_LIMITS,
  nativeCommitRetainedBytes,
} from "./nativeHistoryParser";

/** Encode valid machine fields, including escaped Unicode and controls. */
function createTestRecord(id = 1, description = "subject") {
  return [
    id.toString(16).padStart(40, "0"),
    "abcd1234",
    "logical",
    "",
    '"Ada"',
    JSON.stringify("ada@example.invalid"),
    "2026-01-01T00:00:00Z",
    JSON.stringify(description),
    "0",
    "",
    "",
    "",
    "",
    "false",
    "",
    "false",
  ].join("\0");
}

/** Emit three distinguished body rows followed by exact graph-only continuation rows. */
function createTestFrame(record: string, body = ["@  ", "│  ", "│  "], after: string[] = []) {
  return (
    body
      .map(
        (prefix, i) =>
          `${prefix}${NATIVE_BODY_MARKERS[i]!.start}${i === 0 ? record : ""}${NATIVE_BODY_MARKERS[i]!.end}\n`,
      )
      .join("") + after.map((line) => `${line}\n`).join("")
  );
}

/** Exercise the production metadata decoder through the native byte framing parser. */
function createTestParser() {
  return new NativeHistoryParser(
    (record) => parseJjHistory(`${record}\0`, false, false, undefined, true)[0]!,
  );
}

/** Read every retained page, including entries deferred by queue pressure at EOF. */
function readTestPages(parser: NativeHistoryParser) {
  const pages = [];
  while (!parser.exhausted) {
    const page = parser.read(256);
    expect(page.length).toBeGreaterThan(0);
    pages.push(page);
  }
  return pages.flat();
}

describe("native JJ physical framing", () => {
  test("preserves UTF-8, escaped controls and EOF tails at every byte split", () => {
    const input = Buffer.from(
      createTestFrame(
        createTestRecord(1, "日本語\nbody\u0000\u001e\t"),
        ["界  ", "│  ", "╰─ "],
        ["╭─╯", "~  "],
      ) + createTestFrame(createTestRecord(2), ["○ ", "  ", "  "], ["╰─"]).trimEnd(),
    );
    for (let split = 0; split <= input.length; split++) {
      const parser = createTestParser();
      parser.push(input.subarray(0, split));
      parser.push(input.subarray(split));
      parser.finish();
      const rows = [parser.read(1)[0]!, parser.read(1)[0]!] as const;
      expect(rows[0].subject).toBe("日本語");
      expect(rows[0].body).toBe("body\u0000\u001e\t");
      expect(rows[0].nativeGraph).toEqual({ body: ["界  ", "│  ", "╰─ "], after: ["╭─╯", "~  "] });
      expect(rows[1].nativeGraph?.after).toEqual(["╰─"]);
      expect(parser.exhausted).toBeTrue();
    }
  });

  test("rejects missing, misplaced, repeated or hidden framing and invalid UTF-8", () => {
    const valid = createTestFrame(createTestRecord());
    for (const invalid of [
      valid.replace(NATIVE_BODY_MARKERS[1]!.start, NATIVE_BODY_MARKERS[2]!.start),
      valid.replace(NATIVE_BODY_MARKERS[2]!.end, ""),
      valid.replace(NATIVE_BODY_MARKERS[1]!.end, `payload${NATIVE_BODY_MARKERS[1]!.end}`),
      valid + "\t\n",
      valid + "\u2028\n",
      valid + createTestFrame(createTestRecord()),
    ]) {
      expect(() => {
        const parser = createTestParser();
        parser.push(Buffer.from(invalid));
        parser.finish();
      }).toThrow();
    }
    expect(() => {
      const parser = createTestParser();
      parser.push(Buffer.from([0xff, 10]));
    }).toThrow("invalid UTF-8");
  });
});

describe("native JJ independent budget boundaries", () => {
  for (const delta of [-1, 0, 1]) {
    test(`encoded record at 1 MiB ${delta >= 0 ? "+" : ""}${delta} bytes excludes prefix/framing`, () => {
      const base = createTestRecord(1, "");
      const available = NATIVE_HISTORY_LIMITS.record + delta - Buffer.byteLength(base);
      const record = createTestRecord(
        1,
        "é".repeat(Math.floor(available / 2)) + (available % 2 ? "x" : ""),
      );
      expect(Buffer.byteLength(record)).toBe(NATIVE_HISTORY_LIMITS.record + delta);
      const run = () => {
        const parser = createTestParser();
        parser.push(Buffer.from(createTestFrame(record)));
        parser.finish();
        return parser.read(1);
      };
      if (delta > 0) expect(run).toThrow("machine record");
      else expect(run()).toHaveLength(1);
    });
    test(`graph line at 4096 ${delta >= 0 ? "+" : ""}${delta} UTF-16 units`, () => {
      const units = NATIVE_HISTORY_LIMITS.line + delta;
      const line = "界".repeat(units);
      const run = () => {
        const parser = createTestParser();
        parser.push(Buffer.from(createTestFrame(createTestRecord(), [line, "", ""])));
        parser.finish();
        return parser.read(1);
      };
      if (delta > 0) expect(run).toThrow("4096");
      else expect(run()[0]!.nativeGraph!.body[0].length).toBe(units);
    });
    test(`after rows at 128 ${delta >= 0 ? "+" : ""}${delta}`, () => {
      const run = () => {
        const parser = createTestParser();
        parser.push(
          Buffer.from(
            createTestFrame(
              createTestRecord(),
              ["", "", ""],
              Array.from({ length: 128 + delta }, () => "|"),
            ),
          ),
        );
        parser.finish();
        return parser.read(1);
      };
      if (delta > 0) expect(run).toThrow("128 rows");
      else expect(run()[0]!.nativeGraph!.after).toHaveLength(128 + delta);
    });
    test(`graph text at 256 KiB ${delta >= 0 ? "+" : ""}${delta} UTF-16 units`, () => {
      const units = NATIVE_HISTORY_LIMITS.graph / 2 + delta;
      const rows: string[] = [];
      for (let remaining = units; remaining > 0; remaining -= 4096)
        rows.push("界".repeat(Math.min(4096, remaining)));
      const run = () => {
        const parser = createTestParser();
        parser.push(Buffer.from(createTestFrame(createTestRecord(), ["", "", ""], rows)));
        parser.finish();
        return parser.read(1);
      };
      if (delta > 0) expect(run).toThrow("256 KiB");
      else expect(run()).toHaveLength(1);
    });
    test(`queue count at 512 ${delta >= 0 ? "+" : ""}${delta} commits drains/resumes`, () => {
      const parser = createTestParser();
      for (let id = 1; id <= 512 + delta; id++)
        parser.push(Buffer.from(createTestFrame(createTestRecord(id))));
      parser.finish();
      expect(parser.count).toBe(Math.min(512, 512 + delta));
      expect(parser.pressured).toBe(delta >= 0);
      expect(readTestPages(parser)).toHaveLength(512 + delta);
    });
    test(`queue bytes at 8 MiB ${delta >= 0 ? "+" : ""}${delta} UTF-16 units drains without exceeding bound`, () => {
      const parser = createTestParser();
      const body = ["@  ", "│  ", "│  "];
      const base = parseJjHistory(
        `${createTestRecord(1, "")}\0`,
        false,
        false,
        undefined,
        true,
      )[0]!;
      base.nativeGraph = { body: body as [string, string, string], after: [] };
      const fixed = nativeCommitRetainedBytes(base) - base.subject.length * 2;
      const ordinary = 65_000;
      const last =
        (NATIVE_HISTORY_LIMITS.queue + 2 * delta - 63 * (fixed + ordinary * 2) - fixed) / 2;
      for (let id = 1; id <= 64; id++)
        parser.push(
          Buffer.from(
            createTestFrame(createTestRecord(id, "x".repeat(id === 64 ? last : ordinary)), body),
          ),
        );
      parser.finish();
      expect(parser.pressured).toBe(delta >= 0);
      const first = parser.read(256);
      expect(first.reduce((sum, c) => sum + nativeCommitRetainedBytes(c), 0)).toBeLessThanOrEqual(
        NATIVE_HISTORY_LIMITS.queue,
      );
      const all = [...first, ...readTestPages(parser)];
      expect(all).toHaveLength(64);
      expect(all.reduce((sum, c) => sum + nativeCommitRetainedBytes(c), 0)).toBe(
        NATIVE_HISTORY_LIMITS.queue + 2 * delta,
      );
    });
    test(`pending bytes at 2 MiB ${delta >= 0 ? "+" : ""}${delta} includes raw remainder and decoded entry`, () => {
      const parser = createTestParser();
      for (let id = 1; id <= 512; id++)
        parser.push(Buffer.from(createTestFrame(createTestRecord(id))));
      const record = createTestRecord(513);
      parser.push(
        Buffer.from(`${NATIVE_BODY_MARKERS[0]!.start}${record}${NATIVE_BODY_MARKERS[0]!.end}\n`),
      );
      expect(parser.pressured).toBeTrue();
      const needed = NATIVE_HISTORY_LIMITS.pending + delta - record.length * 2;
      let raw = NATIVE_BODY_MARKERS.slice(1)
        .map((marker) => `${marker.start}${marker.end}\n`)
        .join("");
      for (let id = 514; raw.length < needed; id++)
        raw += createTestFrame(createTestRecord(id), ["@  ", "|  ", "|  "]);
      const run = () => parser.push(Buffer.from(raw.slice(0, needed)));
      if (delta > 0) expect(run).toThrow("2 MiB");
      else {
        expect(run).not.toThrow();
        expect(() => parser.read(256)).not.toThrow();
      }
    });
  }
  test("byte pressure below requested count exposes a bounded page rather than waiting for EOF", () => {
    const parser = createTestParser();
    const after = Array.from({ length: 30 }, () => "|".repeat(4096));
    for (let id = 1; id <= 50; id++) {
      const bytes = Buffer.from(
        createTestFrame(createTestRecord(id), ["@  ", "|  ", "|  "], after),
      );
      for (let at = 0; at < bytes.length; at += 16384) {
        parser.push(bytes.subarray(at, at + 16384));
        if (parser.pressured) {
          expect(parser.count).toBeLessThan(256);
          expect(parser.read(256).length).toBeGreaterThan(0);
        }
      }
    }
    parser.finish();
    readTestPages(parser);
  });
});
