import { expect, test } from "bun:test";
import { computeFingerprint, issueTitle } from "../src/fingerprint";
const failure = (url: string, type = "link") => ({
  name: "ResourceLoadError",
  message: `Failed to load ${type} resource: ${url}`,
});
test("observed deployment chunks group without changing event messages", async () => {
  const errors = [
    "v672yfk8",
    "wm4hqt74",
    "zm9d6v5f",
    "49e3rwcw",
    "tmsnmnef",
  ].map((hash) => failure(`https://onspark.com/chunk-${hash}.js`));
  expect(new Set(await Promise.all(errors.map(computeFingerprint))).size).toBe(
    1,
  );
  const first = errors[0]!;
  expect(first.message).toContain("v672yfk8");
  expect(issueTitle(first.name, first.message)).toContain("chunk-<hash>.js");
});
test("keeps origins, paths, resource kinds, extensions and ordinary files distinct", async () => {
  const urls = [
    "https://one.test/chunk-abcdefgh.js",
    "https://two.test/chunk-abcdefgh.js",
    "https://one.test/admin/chunk-abcdefgh.js",
    "https://one.test/chunk-abcdefgh.css",
    "https://one.test/app.js",
    "https://one.test/other.js",
  ];
  const keys = await Promise.all(
    urls.map((url) => computeFingerprint(failure(url))),
  );
  expect(new Set(keys).size).toBe(urls.length);
  expect(await computeFingerprint(failure(urls[0]!, "script"))).not.toBe(
    keys[0]!,
  );
  expect(await computeFingerprint(failure(urls[0] + "?v=old#part"))).toBe(
    keys[0]!,
  );
  expect(
    await computeFingerprint({ ...failure(urls[0]!), name: "TypeError" }),
  ).not.toBe(keys[0]!);
});

test("versioned client graphs preserve legacy resource grouping and full evidence", async () => {
  const original = failure("https://onspark.com/chunk-abcdefgh.js");
  const keys = await Promise.all(
    ["a".repeat(64), "b".repeat(64)].map(async (graph) => {
      const event = failure(
        `https://onspark.com/_absolute/assets/${graph}/chunk-abcdefgh.js`,
      );
      const key = await computeFingerprint(event);
      expect(event.message).toContain(graph);
      return key;
    }),
  );
  expect(keys).toEqual([
    await computeFingerprint(original),
    await computeFingerprint(original),
  ]);
  expect(
    await computeFingerprint(
      failure(
        `https://onspark.com/_absolute/assets/${"c".repeat(64)}/other.js`,
      ),
    ),
  ).not.toBe(keys[0]);
  expect(
    await computeFingerprint(
      failure(
        `https://onspark.com/customer/${"c".repeat(64)}/chunk-abcdefgh.js`,
      ),
    ),
  ).not.toBe(keys[0]);
});

test("stack grouping ignores only the reserved graph identifier, leaving culprit evidence intact", async () => {
  const base = {
    name: "TypeError",
    message: "Cannot read properties of undefined",
  };
  const legacy = {
    ...base,
    stack: "at render (https://onspark.com/vue/indexes/Home.js:10:2)",
  };
  const versioned = {
    ...base,
    stack: `at render (https://onspark.com/_absolute/assets/${"a".repeat(64)}/vue/indexes/Home.js:10:2)`,
  };
  expect(await computeFingerprint(versioned)).toBe(
    await computeFingerprint(legacy),
  );
  expect(versioned.stack).toContain("a".repeat(64));
});

test("dynamic import failures keep their identity across graph namespaces", async () => {
  const event = {
    name: "TypeError",
    message:
      "Failed to fetch dynamically imported module: https://onspark.com/chunk-abcdefgh.js",
  };
  const versioned = {
    ...event,
    message: event.message.replace(
      "/chunk-",
      `/_absolute/assets/${"b".repeat(64)}/chunk-`,
    ),
  };
  expect(await computeFingerprint(versioned)).toBe(
    await computeFingerprint(event),
  );
  expect(versioned.message).toContain("b".repeat(64));
});
