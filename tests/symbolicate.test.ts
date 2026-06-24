/**
 * Tests for @absolutejs/errors/symbolicate.
 */
import { describe, expect, test } from "bun:test";
import type { SourceMapInput } from "@jridgewell/trace-mapping";
import { Effect, Option } from "effect";
import {
  cachedSourceMapResolver,
  parseStack,
  symbolicate,
  symbolicateStack,
  type SourceMapResolver,
} from "../src/symbolicate";

// A minimal valid source map. "AAAAA" decodes to one segment
// [genCol=0, sourceIdx=0, origLine=0, origCol=0, nameIdx=0] on generated line 1,
// so generated (line 1, col 0) → src/original.ts (line 1, col 0), name "greet".
const MAP: SourceMapInput = {
  mappings: "AAAAA",
  names: ["greet"],
  sources: ["src/original.ts"],
  version: 3,
};

const resolverFor =
  (file: string, map: SourceMapInput): SourceMapResolver =>
  (requested) =>
    Effect.succeed(requested === file ? Option.some(map) : Option.none());

const run = <A>(eff: Effect.Effect<A>): Promise<A> => Effect.runPromise(eff);

describe("parseStack", () => {
  test("parses Chrome frames (with + without function)", () => {
    const stack = [
      "Error: boom",
      "    at doThing (https://app.com/app.min.js:1:200)",
      "    at https://app.com/app.min.js:2:5",
    ].join("\n");
    expect(parseStack(stack)).toEqual([
      {
        column: 200,
        file: "https://app.com/app.min.js",
        function: "doThing",
        line: 1,
      },
      { column: 5, file: "https://app.com/app.min.js", line: 2 },
    ]);
  });

  test("parses Firefox/Safari frames", () => {
    const stack = [
      "doThing@https://app.com/app.min.js:1:200",
      "@https://app.com/app.min.js:2:5",
    ].join("\n");
    const frames = parseStack(stack);
    expect(frames[0]).toEqual({
      column: 200,
      file: "https://app.com/app.min.js",
      function: "doThing",
      line: 1,
    });
    expect(frames[1]).toEqual({
      column: 5,
      file: "https://app.com/app.min.js",
      line: 2,
    });
  });

  test("skips the header + non-frame lines", () => {
    expect(parseStack("Error: nope\n   some noise\n")).toEqual([]);
  });
});

describe("symbolicateStack", () => {
  test("maps a frame to its original position + name", async () => {
    const stack = "Error: boom\n    at m (app.min.js:1:1)";
    const result = await run(
      symbolicateStack(stack, resolverFor("app.min.js", MAP)),
    );
    expect(result.mapped).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(result.frames[0]?.original).toEqual({
      column: 0,
      line: 1,
      name: "greet",
      source: "src/original.ts",
    });
  });

  test("NoSourceMap when the resolver returns none", async () => {
    const stack = "Error: boom\n    at m (unknown.js:1:1)";
    const result = await run(
      symbolicateStack(stack, resolverFor("app.min.js", MAP)),
    );
    expect(result.mapped).toBe(0);
    expect(result.failures[0]?._tag).toBe("NoSourceMap");
    // frame is still present, just without `original`
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.original).toBeUndefined();
  });

  test("SourceMapFetchFailed when the resolver throws", async () => {
    const failing: SourceMapResolver = () => Effect.fail(new Error("S3 down"));
    const result = await run(
      symbolicateStack("Error: x\n    at m (a.js:1:1)", failing),
    );
    expect(result.failures[0]?._tag).toBe("SourceMapFetchFailed");
  });

  test("FrameUnmapped when the position has no mapping", async () => {
    const stack = "Error: boom\n    at m (app.min.js:9:9)"; // line 9 has no segments
    const result = await run(
      symbolicateStack(stack, resolverFor("app.min.js", MAP)),
    );
    expect(result.failures[0]?._tag).toBe("FrameUnmapped");
  });

  test("reports a file-level failure once across many frames of that file", async () => {
    const stack = [
      "Error: boom",
      "    at a (no.js:1:1)",
      "    at b (no.js:2:2)",
      "    at c (no.js:3:3)",
    ].join("\n");
    const result = await run(
      symbolicateStack(stack, resolverFor("app.min.js", MAP)),
    );
    const noMap = result.failures.filter((f) => f._tag === "NoSourceMap");
    expect(noMap).toHaveLength(1); // deduped per file
    expect(result.frames).toHaveLength(3);
  });
});

describe("symbolicate (stack rewrite)", () => {
  test("rewrites the stack with original positions, keeps the header", async () => {
    const stack = "TypeError: boom\n    at m (app.min.js:1:1)";
    const out = await run(symbolicate(stack, resolverFor("app.min.js", MAP)));
    expect(out.mapped).toBe(1);
    expect(out.stack).toBe(
      "TypeError: boom\n    at greet (src/original.ts:1:1)",
    );
  });
});

describe("cachedSourceMapResolver", () => {
  test("fetches each file at most once (incl. negative cache)", async () => {
    let calls = 0;
    const base: SourceMapResolver = (file) => {
      calls += 1;
      return Effect.succeed(
        file === "app.min.js" ? Option.some(MAP) : Option.none(),
      );
    };
    const cached = cachedSourceMapResolver(base);
    const stack = [
      "Error: boom",
      "    at a (app.min.js:1:1)",
      "    at b (app.min.js:1:1)",
      "    at c (missing.js:1:1)",
      "    at d (missing.js:1:1)",
    ].join("\n");
    // two distinct files referenced twice each → exactly 2 base calls
    await run(symbolicateStack(stack, cached));
    await run(symbolicateStack(stack, cached));
    expect(calls).toBe(2);
  });
});
