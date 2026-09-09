# log-record-splitter

Splits raw log text into logical records instead of physical lines.

The problem: `text.split("\n")` is not the same thing as "one entry per
line". Most real log files mix single-line entries with multi-line ones —
a Java stack trace, a wrapped SQL statement, a pretty-printed JSON blob —
and none of the continuation lines carry a timestamp of their own. Split
naively and a five-line exception report turns into five separate "log
lines" with no way to tell they belong together.

This library groups lines back into records using a simple rule: a line
that starts with a timestamp begins a new record, and everything after it
up to the next timestamp belongs to that record.

## Install

No package is published yet. Copy `src/` into your project, or add this
repo as a path dependency once it has a release.

## Usage

```ts
import { readFileSync } from "node:fs";
import { splitRecords } from "./src/index.js";

const text = readFileSync("app.log", "utf8");
const records = splitRecords(text);

for (const record of records) {
  console.log(record.timestamp?.toISOString() ?? "(no timestamp)", "->", record.lines.length, "line(s)");
}
```

Given:

```
2024-01-02T10:00:00Z ERROR something broke
java.lang.RuntimeException: boom
    at com.example.Main.run(Main.java:42)
    at com.example.Main.main(Main.java:10)
2024-01-02T10:00:05Z INFO recovered
```

`splitRecords` returns two records: the four-line exception block attached
to the 10:00:00 entry, and a single-line record for 10:00:05.

## Timestamp formats

Four formats are recognized out of the box:

- ISO 8601 — `2024-01-02T10:00:00.123Z`, `2024-01-02 10:00:00+02:00`
- Bracketed — `[2024-01-02 10:00:00.123]`
- Syslog — `Jan  2 03:04:05` (no year in the format itself — see below)
- Epoch milliseconds — a bare 13-digit number at the start of a line

Syslog timestamps don't carry a year, so `splitRecords` needs one from you:

```ts
splitRecords(text, { referenceYear: 2024 });
```

Without it, the current calendar year is assumed.

You can also supply your own pattern list and skip the built-ins entirely:

```ts
import { splitRecords, isoPattern } from "./src/index.js";

splitRecords(text, { timestampPatterns: [isoPattern()] });
```

A `TimestampPattern` is just a regex anchored to the start of a line plus a
function that turns the match into a `Date` or `null`. Returning `null`
tells the splitter "this looked like a timestamp but isn't a valid one" —
which matters more than it sounds like: `new Date(2024, 1, 30)` silently
rolls over into March instead of failing, so every built-in pattern checks
its own field ranges rather than trusting the `Date` constructor.

## Notes and limitations

- Records are joined with `raw: lines.join("\n")`, so the original line
  ending (LF vs CRLF) is not preserved anywhere — everything is normalized
  to `\n`.
- Lines before the first recognized timestamp become their own record with
  `timestamp: null`, rather than being dropped or attached to whatever
  comes after them.
- The epoch-millisecond pattern only accepts values that land between the
  years 2000 and 2100, to cut down on false positives from unrelated
  13-digit numbers in a log line.

## Development

```
npm run build   # compile src/ to dist/
npm test        # compile, then run the test suite with node --test
```

Tests live next to the code they cover (`src/index.test.ts`) and use
Node's built-in test runner — no test framework dependency.
