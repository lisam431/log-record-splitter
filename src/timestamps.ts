// Each pattern owns its own validation. Date parsing in JS is permissive
// (new Date(2024, 1, 30) silently rolls over to March 2), and that rollover
// is exactly the kind of thing that turns "sort by timestamp" into a bug,
// so every parser here rejects out-of-range fields instead of normalizing them.

export interface TimestampPattern {
  name: string;
  regex: RegExp;
  parse(match: RegExpMatchArray): Date | null;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseIsoLike(value: string): Date | null {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

// 2024-01-02T10:00:00.123Z, 2024-01-02T10:00:00+02:00, 2024-01-02 10:00:00
export function isoPattern(): TimestampPattern {
  return {
    name: "iso8601",
    regex: /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)/,
    parse: (match) => parseIsoLike(match[1] as string),
  };
}

// [2024-01-02 10:00:00.123] as used by a lot of framework loggers
export function bracketedPattern(): TimestampPattern {
  return {
    name: "bracketed",
    regex: /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]/,
    parse: (match) => parseIsoLike(match[1] as string),
  };
}

// Classic syslog: "Jan  2 03:04:05" (day is space-padded, no year).
// The year has to come from outside the line, since syslog doesn't carry one.
export function syslogPattern(referenceYear: number): TimestampPattern {
  return {
    name: "syslog",
    regex: /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})/,
    parse: (match) => {
      const monthIndex = MONTHS.indexOf(match[1] as string);
      if (monthIndex === -1) return null;
      const day = Number(match[2]);
      const hour = Number(match[3]);
      const minute = Number(match[4]);
      const second = Number(match[5]);
      if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
        return null;
      }
      const date = new Date(referenceYear, monthIndex, day, hour, minute, second);
      // Catches "Feb 30" and similar: Date() rolls that into March, so if
      // what comes back doesn't match what went in, the input was invalid.
      if (date.getMonth() !== monthIndex || date.getDate() !== day) return null;
      return date;
    },
  };
}

// Bare epoch milliseconds at the start of a line, e.g. from a JSON logger
// field that got flattened to text. Bounded to a plausible calendar range
// so an arbitrary 13-digit number in a log line isn't mistaken for a date.
export function epochMillisPattern(): TimestampPattern {
  return {
    name: "epoch-millis",
    regex: /^(\d{13})(?=\s|$)/,
    parse: (match) => {
      const millis = Number(match[1]);
      const date = new Date(millis);
      const year = date.getUTCFullYear();
      if (year < 2000 || year > 2100) return null;
      return date;
    },
  };
}

export function defaultPatterns(
  referenceYear: number = new Date().getFullYear(),
): TimestampPattern[] {
  return [isoPattern(), bracketedPattern(), syslogPattern(referenceYear), epochMillisPattern()];
}
