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
