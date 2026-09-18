import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRecords, streamRecords } from "./index.js";
import { syslogPattern, epochMillisPattern, isoPattern } from "./timestamps.js";

async function* asChunks(pieces: string[]): AsyncGenerator<string> {
  for (const piece of pieces) yield piece;
}

async function collect(chunks: string[], referenceYear = 2024) {
  const records = [];
  for await (const record of streamRecords(asChunks(chunks), { referenceYear })) {
    records.push(record);
  }
  return records;
}

interface SplitCase {
  name: string;
  input: string;
  expected: Array<{ timestamp: string | null; lines: string[] }>;
}

const REFERENCE_YEAR = 2024;

const splitCases: SplitCase[] = [
  {
    name: "empty input produces no records",
    input: "",
    expected: [],
  },
  {
    name: "single line with no trailing newline",
    input: "hello world",
    expected: [{ timestamp: null, lines: ["hello world"] }],
  },
  {
    name: "a stack trace stays attached to the record it belongs to",
    input: [
      "2024-01-02T10:00:00Z ERROR something broke",
      "java.lang.RuntimeException: boom",
      "    at com.example.Main.run(Main.java:42)",
      "    at com.example.Main.main(Main.java:10)",
      "2024-01-02T10:00:05Z INFO recovered",
      "",
    ].join("\n"),
    expected: [
      {
        timestamp: "2024-01-02T10:00:00.000Z",
        lines: [
          "2024-01-02T10:00:00Z ERROR something broke",
          "java.lang.RuntimeException: boom",
          "    at com.example.Main.run(Main.java:42)",
          "    at com.example.Main.main(Main.java:10)",
        ],
      },
      { timestamp: "2024-01-02T10:00:05.000Z", lines: ["2024-01-02T10:00:05Z INFO recovered"] },
    ],
  },
  {
    name: "lines before the first timestamp form their own record",
    input: ["-- log opened --", "2024-01-02T10:00:00Z INFO start", ""].join("\n"),
    expected: [
      { timestamp: null, lines: ["-- log opened --"] },
      { timestamp: "2024-01-02T10:00:00.000Z", lines: ["2024-01-02T10:00:00Z INFO start"] },
    ],
  },
  {
    name: "blank lines inside a record are preserved, not dropped",
    input: [
      "2024-01-02T10:00:00Z INFO start",
      "",
      "still part of the same record",
      "2024-01-02T10:00:01Z INFO next",
      "",
    ].join("\n"),
    expected: [
      {
        timestamp: "2024-01-02T10:00:00.000Z",
        lines: ["2024-01-02T10:00:00Z INFO start", "", "still part of the same record"],
      },
      { timestamp: "2024-01-02T10:00:01.000Z", lines: ["2024-01-02T10:00:01Z INFO next"] },
    ],
  },
  {
    name: "CRLF line endings are treated the same as LF",
    input: "2024-01-02T10:00:00Z INFO a\r\ncontinuation\r\n2024-01-02T10:00:01Z INFO b\r\n",
    expected: [
      { timestamp: "2024-01-02T10:00:00.000Z", lines: ["2024-01-02T10:00:00Z INFO a", "continuation"] },
      { timestamp: "2024-01-02T10:00:01.000Z", lines: ["2024-01-02T10:00:01Z INFO b"] },
    ],
  },
  {
    name: "an invalid syslog date (Feb 30) is not treated as a timestamp",
    input: "Feb 30 10:00:00 host something happened\n",
    expected: [{ timestamp: null, lines: ["Feb 30 10:00:00 host something happened"] }],
  },
  {
    name: "a valid syslog date starts a new record",
    input: "Jan  2 03:04:05 host something happened\n",
    expected: [
      {
        timestamp: new Date(REFERENCE_YEAR, 0, 2, 3, 4, 5).toISOString(),
        lines: ["Jan  2 03:04:05 host something happened"],
      },
    ],
  },
  {
    name: "a bracketed timestamp with milliseconds is recognized",
    input: "[2024-01-02 10:00:00.123] something happened\n",
    expected: [
      { timestamp: "2024-01-02T10:00:00.123Z", lines: ["[2024-01-02 10:00:00.123] something happened"] },
    ],
  },
  {
    name: "mixed timestamp formats in the same stream each start a record",
    input: [
      "[2024-01-02 09:00:00] booting",
      "Jan  2 09:00:01 host service ready",
      "2024-01-02T09:00:02Z INFO listening",
      "",
    ].join("\n"),
    expected: [
      { timestamp: "2024-01-02T09:00:00.000Z", lines: ["[2024-01-02 09:00:00] booting"] },
      {
        timestamp: new Date(REFERENCE_YEAR, 0, 2, 9, 0, 1).toISOString(),
        lines: ["Jan  2 09:00:01 host service ready"],
      },
      { timestamp: "2024-01-02T09:00:02.000Z", lines: ["2024-01-02T09:00:02Z INFO listening"] },
    ],
  },
];

test("splitRecords", async (t) => {
  for (const testCase of splitCases) {
    await t.test(testCase.name, () => {
      const records = splitRecords(testCase.input, { referenceYear: REFERENCE_YEAR });
      assert.equal(records.length, testCase.expected.length);
      records.forEach((record, index) => {
        const expected = testCase.expected[index];
        assert.ok(expected, `unexpected extra record at index ${index}`);
        assert.equal(
          record.timestamp ? record.timestamp.toISOString() : null,
          expected.timestamp,
          `timestamp mismatch for record ${index}`,
        );
        assert.deepEqual(record.lines, expected.lines, `lines mismatch for record ${index}`);
        assert.equal(record.raw, expected.lines.join("\n"));
      });
    });
  }
});

test("streamRecords", async (t) => {
  for (const testCase of splitCases) {
    await t.test(testCase.name, async () => {
      const records = await collect([testCase.input]);
      assert.equal(records.length, testCase.expected.length);
      records.forEach((record, index) => {
        const expected = testCase.expected[index];
        assert.ok(expected, `unexpected extra record at index ${index}`);
        assert.equal(
          record.timestamp ? record.timestamp.toISOString() : null,
          expected.timestamp,
          `timestamp mismatch for record ${index}`,
        );
        assert.deepEqual(record.lines, expected.lines, `lines mismatch for record ${index}`);
      });
    });
  }

  await t.test("agrees with splitRecords when fed one character at a time", async () => {
    const input = [
      "2024-01-02T10:00:00Z ERROR something broke",
      "java.lang.RuntimeException: boom",
      "    at com.example.Main.run(Main.java:42)",
      "2024-01-02T10:00:05Z INFO recovered",
      "",
    ].join("\n");
    const whole = splitRecords(input, { referenceYear: REFERENCE_YEAR });
    const streamed = await collect(input.split(""));
    assert.deepEqual(
      streamed.map((r) => r.lines),
      whole.map((r) => r.lines),
    );
  });

  await t.test("a CRLF terminator split across a chunk boundary is not treated as two lines", async () => {
    const records = await collect([
      "2024-01-02T10:00:00Z INFO a\r",
      "\n2024-01-02T10:00:01Z INFO b\r\n",
    ]);
    assert.deepEqual(
      records.map((r) => r.lines),
      [["2024-01-02T10:00:00Z INFO a"], ["2024-01-02T10:00:01Z INFO b"]],
    );
  });

  await t.test("a timestamp split across a chunk boundary is still recognized", async () => {
    const records = await collect(["2024-01-02T10:00", ":00Z INFO late arrival\n"]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.timestamp?.toISOString(), "2024-01-02T10:00:00.000Z");
  });

  await t.test("no chunks produces no records", async () => {
    assert.deepEqual(await collect([]), []);
  });
});

interface PatternCase {
  name: string;
  line: string;
  expectMatch: boolean;
}

const epochCases: PatternCase[] = [
  { name: "plausible epoch millis (2024) is accepted", line: `${Date.UTC(2024, 0, 2, 10, 0, 0)} started`, expectMatch: true },
  { name: "13-digit number far outside a sane calendar range is rejected", line: "9999999999999 not a date", expectMatch: false },
  { name: "a 12-digit number does not match at all", line: "123456789012 not enough digits", expectMatch: false },
];

test("epochMillisPattern rejects implausible values despite matching the digit shape", () => {
  const pattern = epochMillisPattern();
  for (const patternCase of epochCases) {
    const match = patternCase.line.match(pattern.regex);
    const result = match ? pattern.parse(match) : null;
    assert.equal(result !== null, patternCase.expectMatch, patternCase.name);
  }
});

const syslogCases: PatternCase[] = [
  { name: "single-digit day with double space padding", line: "Jan  2 03:04:05 host x", expectMatch: true },
  { name: "double-digit day with single space", line: "Jan 12 03:04:05 host x", expectMatch: true },
  { name: "hour out of range is rejected", line: "Jan  2 24:00:00 host x", expectMatch: false },
  { name: "unknown month abbreviation is rejected", line: "Xxx  2 03:04:05 host x", expectMatch: false },
];

test("syslogPattern edge cases", () => {
  const pattern = syslogPattern(REFERENCE_YEAR);
  for (const patternCase of syslogCases) {
    const match = patternCase.line.match(pattern.regex);
    const result = match ? pattern.parse(match) : null;
    assert.equal(result !== null, patternCase.expectMatch, patternCase.name);
  }
});

test("isoPattern rejects a calendar-invalid date instead of rolling it over", () => {
  const pattern = isoPattern();
  const line = "2024-13-05T10:00:00Z out of range month";
  const match = line.match(pattern.regex);
  assert.ok(match, "regex should still match the shape");
  assert.equal(pattern.parse(match as RegExpMatchArray), null);
});
