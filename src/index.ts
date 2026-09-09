import type { TimestampPattern } from "./timestamps.js";
import { defaultPatterns } from "./timestamps.js";

export type { TimestampPattern } from "./timestamps.js";
export {
  isoPattern,
  bracketedPattern,
  syslogPattern,
  epochMillisPattern,
  defaultPatterns,
} from "./timestamps.js";

export interface LogRecord {
  /** The record's lines rejoined with "\n", regardless of the source line ending. */
  raw: string;
  /** The lines that make up this record, in order, without line endings. */
  lines: string[];
  /** null when no configured pattern matched the first line of the record. */
  timestamp: Date | null;
}

export interface SplitOptions {
  /** Overrides the built-in patterns entirely when provided. */
  timestampPatterns?: TimestampPattern[];
  /** Year to assume for timestamp formats (like syslog) that omit one. */
  referenceYear?: number;
}

function matchTimestamp(line: string, patterns: TimestampPattern[]): Date | null {
  for (const pattern of patterns) {
    const match = line.match(pattern.regex);
    if (!match) continue;
    const date = pattern.parse(match);
    if (date && !Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * Splits raw log text into records. A line that starts with a recognizable
 * timestamp begins a new record; any line that doesn't (a stack trace frame,
 * a wrapped message, a blank line) is appended to the record above it.
 *
 * Lines before the first recognized timestamp form their own record with a
 * null timestamp, so nothing at the start of a file is silently dropped.
 */
export function splitRecords(text: string, options: SplitOptions = {}): LogRecord[] {
  if (text === "") return [];

  const patterns = options.timestampPatterns ?? defaultPatterns(options.referenceYear);
  const endsWithNewline = /\r\n$|\n$|\r$/.test(text);
  const lines = text.split(/\r\n|\r|\n/);
  if (endsWithNewline) lines.pop();

  const records: LogRecord[] = [];
  let current: { lines: string[]; timestamp: Date | null } | null = null;

  for (const line of lines) {
    const timestamp = matchTimestamp(line, patterns);
    if (timestamp) {
      if (current) records.push(toRecord(current));
      current = { lines: [line], timestamp };
    } else if (current) {
      current.lines.push(line);
    } else {
      current = { lines: [line], timestamp: null };
    }
  }
  if (current) records.push(toRecord(current));

  return records;
}

function toRecord(current: { lines: string[]; timestamp: Date | null }): LogRecord {
  return { raw: current.lines.join("\n"), lines: current.lines, timestamp: current.timestamp };
}
