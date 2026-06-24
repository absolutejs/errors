/**
 * @absolutejs/errors/symbolicate — turn a minified browser stack into an
 * original-source stack, against uploaded source maps.
 *
 * Effect-native and **partial-success-as-data**: symbolicating a whole stack
 * never fails (E = never) — some frames map, some don't, and the ones that
 * don't are reported as typed `SymbolicationFailure` values alongside the
 * frames that did. Source-map fetching is delegated to a caller-supplied
 * `SourceMapResolver` (the trust boundary); wrap it in
 * `cachedSourceMapResolver` so the same release's map is fetched once, not
 * once per event.
 *
 * Optional peer: `@jridgewell/trace-mapping` (only needed for this subpath).
 */
import {
  AnyMap,
  originalPositionFor,
  type SourceMapInput,
  type TraceMap,
} from "@jridgewell/trace-mapping";
import { Data, Effect, Either, Option } from "effect";

// =============================================================================
// Shapes
// =============================================================================

/** A frame parsed out of a raw minified stack. Lines/columns are 1-based. */
export type RawFrame = {
  /** Function name as it appears in the minified stack, if any. */
  function?: string;
  /** Generated file URL/path. */
  file: string;
  /** 1-based line in generated code. */
  line: number;
  /** 1-based column in generated code. */
  column: number;
};

/** A resolved original position. `column` is 0-based (as source maps store it). */
export type OriginalPosition = {
  source: string;
  line: number;
  column: number;
  name?: string;
};

/** A frame plus its original position, when one was found. */
export type SymbolicatedFrame = RawFrame & { original?: OriginalPosition };

export type SymbolicationResult = {
  /** Every parsed frame, in order; `original` set where mapping succeeded. */
  frames: SymbolicatedFrame[];
  /** Typed per-frame / per-file failures. Empty ⇒ fully symbolicated. */
  failures: SymbolicationFailure[];
  /** How many frames resolved to an original position. */
  mapped: number;
};

// =============================================================================
// Typed failures
// =============================================================================

/** No source map is available for the generated file. */
export class NoSourceMap extends Data.TaggedError("NoSourceMap")<{
  file: string;
}> {}

/** The resolver threw fetching the source map (network / IO boundary). */
export class SourceMapFetchFailed extends Data.TaggedError(
  "SourceMapFetchFailed",
)<{ file: string; cause: unknown }> {}

/** The fetched source map could not be parsed. */
export class SourceMapParseFailed extends Data.TaggedError(
  "SourceMapParseFailed",
)<{ file: string; cause: unknown }> {}

/** The map loaded, but had no entry for this generated position. */
export class FrameUnmapped extends Data.TaggedError("FrameUnmapped")<{
  file: string;
  line: number;
  column: number;
}> {}

export type SymbolicationFailure =
  | NoSourceMap
  | SourceMapFetchFailed
  | SourceMapParseFailed
  | FrameUnmapped;

/**
 * Resolve the raw source map for a generated file. Returns `Option.none()` when
 * no map exists (a non-error: many files legitimately have none). The error
 * channel is `unknown` — it's a trust boundary (a fetch, a disk read, an S3
 * GET); `symbolicate` wraps any failure into a typed `SourceMapFetchFailed`.
 */
export type SourceMapResolver = (
  file: string,
) => Effect.Effect<Option.Option<SourceMapInput>, unknown>;

// =============================================================================
// Stack parsing — Chrome/Node ("at fn (url:line:col)") + Firefox/Safari
// ("fn@url:line:col"). Non-matching lines (the "Error: msg" header, native
// frames) are skipped.
// =============================================================================

const CHROME = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
const FIREFOX = /^(.*?)@(.+?):(\d+):(\d+)$/;

export const parseStack = (stack: string): RawFrame[] => {
  const frames: RawFrame[] = [];
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    const match = CHROME.exec(trimmed) ?? FIREFOX.exec(trimmed);
    if (match === null) continue;
    const [, fn, file, lineStr, colStr] = match;
    if (file === undefined || lineStr === undefined || colStr === undefined) {
      continue;
    }
    const frame: RawFrame = {
      column: Number(colStr),
      file,
      line: Number(lineStr),
    };
    if (fn !== undefined && fn !== "") frame.function = fn;
    frames.push(frame);
  }
  return frames;
};

// =============================================================================
// Symbolication
// =============================================================================

const buildTraceMap = (
  file: string,
  resolve: SourceMapResolver,
): Effect.Effect<TraceMap, SymbolicationFailure> =>
  Effect.gen(function* () {
    const mapOpt = yield* resolve(file).pipe(
      Effect.mapError((cause) => new SourceMapFetchFailed({ cause, file })),
    );
    if (Option.isNone(mapOpt)) {
      return yield* Effect.fail(new NoSourceMap({ file }));
    }
    return yield* Effect.try({
      catch: (cause) => new SourceMapParseFailed({ cause, file }),
      try: () => new AnyMap(mapOpt.value),
    });
  });

/**
 * Symbolicate a raw stack string. Never fails: returns every frame (with
 * `original` set where it mapped) plus the typed failures for those that
 * didn't. A source map is built at most once per distinct file per call.
 */
export const symbolicateStack = (
  stack: string,
  resolve: SourceMapResolver,
): Effect.Effect<SymbolicationResult> =>
  Effect.gen(function* () {
    const frames: SymbolicatedFrame[] = [];
    const failures: SymbolicationFailure[] = [];
    const maps = new Map<
      string,
      Either.Either<TraceMap, SymbolicationFailure>
    >();
    const reportedFiles = new Set<string>();
    let mapped = 0;

    for (const raw of parseStack(stack)) {
      let entry = maps.get(raw.file);
      if (entry === undefined) {
        entry = yield* Effect.either(buildTraceMap(raw.file, resolve));
        maps.set(raw.file, entry);
      }

      if (Either.isLeft(entry)) {
        // File-level failure (no map / fetch / parse) — report once per file.
        frames.push(raw);
        if (!reportedFiles.has(raw.file)) {
          reportedFiles.add(raw.file);
          failures.push(entry.left);
        }
        continue;
      }

      const pos = originalPositionFor(entry.right, {
        column: raw.column - 1, // stacks are 1-based; source maps 0-based
        line: raw.line,
      });
      if (pos.source === null || pos.source === undefined) {
        frames.push(raw);
        failures.push(
          new FrameUnmapped({
            column: raw.column,
            file: raw.file,
            line: raw.line,
          }),
        );
        continue;
      }

      const original: OriginalPosition = {
        column: pos.column ?? 0,
        line: pos.line ?? raw.line,
        source: pos.source,
      };
      if (pos.name !== null && pos.name !== undefined) {
        original.name = pos.name;
      }
      frames.push({ ...raw, original });
      mapped += 1;
    }

    return { failures, frames, mapped };
  });

const formatFrame = (frame: SymbolicatedFrame): string => {
  if (frame.original !== undefined) {
    const fn = frame.original.name ?? frame.function ?? "<anonymous>";
    return `    at ${fn} (${frame.original.source}:${frame.original.line}:${frame.original.column + 1})`;
  }
  const fn = frame.function ?? "<anonymous>";
  return `    at ${fn} (${frame.file}:${frame.line}:${frame.column})`;
};

export type SymbolicatedStack = {
  /** Rewritten stack string (original positions where available). */
  stack: string;
  failures: SymbolicationFailure[];
  mapped: number;
};

/**
 * High-level entry for the ingest drainer: rewrite a minified stack into an
 * original-source stack string, preserving the `Error: message` header line.
 */
export const symbolicate = (
  stack: string,
  resolve: SourceMapResolver,
): Effect.Effect<SymbolicatedStack> =>
  Effect.gen(function* () {
    const result = yield* symbolicateStack(stack, resolve);
    const header = stack.split("\n")[0] ?? "";
    const rewritten = [header, ...result.frames.map(formatFrame)].join("\n");
    return {
      failures: result.failures,
      mapped: result.mapped,
      stack: rewritten,
    };
  });

/**
 * Wrap a resolver with an in-process LRU so a release's source map is fetched
 * once, not once per event. This is the "source-map cache" — read-mostly,
 * highly reused, in-process (no Redis needed). Caches the resolved value
 * including `Option.none()` (negative caching), so files with no map don't
 * re-hit the resolver on every occurrence.
 */
export const cachedSourceMapResolver = (
  resolve: SourceMapResolver,
  options: { max?: number } = {},
): SourceMapResolver => {
  const max = options.max ?? 128;
  const cache = new Map<string, Option.Option<SourceMapInput>>();
  return (file) =>
    Effect.gen(function* () {
      const hit = cache.get(file);
      if (hit !== undefined) {
        // LRU touch: re-insert to move to the end.
        cache.delete(file);
        cache.set(file, hit);
        return hit;
      }
      const resolved = yield* resolve(file);
      if (cache.size >= max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(file, resolved);
      return resolved;
    });
};
