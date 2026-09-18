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

interface Accumulator {
  lines: string[];
  timestamp: Date | null;
}

/**
 * Feeds one more line into the accumulator, starting a new record when the
 * line carries a recognizable timestamp. Returns the (possibly new)
 * accumulator plus a record if the previous one just got closed off, so
 * both splitRecords and streamRecords can share this without either one
 * needing the whole input in memory at once.
 */
function pushLine(
  current: Accumulator | null,
  line: string,
  patterns: TimestampPattern[],
): { current: Accumulator; completed: LogRecord | null } {
  const timestamp = matchTimestamp(line, patterns);
  if (timestamp) {
    return { current: { lines: [line], timestamp }, completed: current && toRecord(current) };
  }
  if (current) {
    current.lines.push(line);
    return { current, completed: null };
  }
  return { current: { lines: [line], timestamp: null }, completed: null };
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
  let current: Accumulator | null = null;

  for (const line of lines) {
    const result = pushLine(current, line, patterns);
    current = result.current;
    if (result.completed) records.push(result.completed);
  }
  if (current) records.push(toRecord(current));

  return records;
}

/**
 * Extracts complete lines from the front of a chunk buffer, leaving any
 * trailing partial line (including a lone trailing "\r" that might turn out
 * to be the first half of a "\r\n" split across a chunk boundary) in `rest`.
 */
function splitLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  const terminator = /\r\n|\r|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = terminator.exec(buffer))) {
    const endsAtBufferEnd = match.index + match[0].length === buffer.length;
    if (match[0] === "\r" && endsAtBufferEnd) break;
    lines.push(buffer.slice(start, match.index));
    start = match.index + match[0].length;
  }

  return { lines, rest: buffer.slice(start) };
}

/**
 * Same grouping rules as splitRecords, but for input too large to hold in
 * memory as a single string: chunks are consumed one at a time (e.g. from a
 * file read stream) and completed records are yielded as soon as the line
 * that starts the next record is seen.
 *
 * Because a record isn't known to be complete until the next timestamp (or
 * the end of input) shows up, at most one record's worth of lines is ever
 * buffered at a time regardless of total input size.
 */
export async function* streamRecords(
  chunks: AsyncIterable<string> | Iterable<string>,
  options: SplitOptions = {},
): AsyncGenerator<LogRecord> {
  const patterns = options.timestampPatterns ?? defaultPatterns(options.referenceYear);
  let buffer = "";
  let current: Accumulator | null = null;

  for await (const chunk of chunks) {
    buffer += chunk;
    const { lines, rest } = splitLines(buffer);
    buffer = rest;
    for (const line of lines) {
      const result = pushLine(current, line, patterns);
      current = result.current;
      if (result.completed) yield result.completed;
    }
  }

  if (buffer !== "") {
    const result = pushLine(current, buffer, patterns);
    current = result.current;
    if (result.completed) yield result.completed;
  }
  if (current) yield toRecord(current);
}

function toRecord(current: Accumulator): LogRecord {
  return { raw: current.lines.join("\n"), lines: current.lines, timestamp: current.timestamp };
}
