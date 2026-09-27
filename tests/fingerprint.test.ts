import { expect, test } from "bun:test";
import {
  computeFingerprint,
  fingerprintSeed,
  issueCulprit,
} from "../src/fingerprint";

const input = (
  root: string,
  file = "node_modules/@absolutejs/queue/dist/index.js",
  fn = "assertValidPayload",
) => ({
  name: "QueuePayloadValidationError",
  message: 'Invalid payload for job "gmail.delta": /historyId must be string',
  stack: `QueuePayloadValidationError: invalid payload\n    at ${fn} (${root}/${file}:8722:15)`,
});

test("the two observed Gmail deployment stacks share a fingerprint", async () => {
  const first = input("/tmp/tmp.3okh3cAhtP");
  const second = input("/tmp/tmp.wQoNqeJ1hv");
  expect(fingerprintSeed(first)).toBe(fingerprintSeed(second));
  expect(await computeFingerprint(first)).toBe(
    await computeFingerprint(second),
  );
  expect(issueCulprit(first.stack)).toContain("/tmp/tmp.3okh3cAhtP/");
});

test("distinct files and functions remain distinct under temporary roots", async () => {
  const first = await computeFingerprint(input("/tmp/tmp.abcXYZ"));
  expect(
    await computeFingerprint(input("/tmp/tmp.otherXYZ", "src/other.js")),
  ).not.toBe(first);
  expect(
    await computeFingerprint(
      input("/tmp/tmp.otherXYZ", undefined, "otherFunction"),
    ),
  ).not.toBe(first);
});

test("ordinary paths retain their existing seed", () => {
  expect(fingerprintSeed(input("/srv/dealroom"))).toBe(
    'QueuePayloadValidationError|Invalid payload for job "?": /historyId must be string|at assertValidPayload (/srv/dealroom/node_modules/@absolutejs/queue/dist/index.js:0:0)',
  );
  expect(fingerprintSeed(input("/tmp/stable-app"))).toContain(
    "/tmp/stable-app/",
  );
  expect(fingerprintSeed(input("/srv/tmp.abcXYZ"))).toContain(
    "/srv/tmp.abcXYZ/",
  );
});

test("temporary-looking segments under ordinary roots remain distinct", () => {
  expect(fingerprintSeed(input("/srv/tmp/tmp.abcXYZ"))).not.toBe(
    fingerprintSeed(input("/srv/tmp/tmp.otherXYZ")),
  );
});

test("file URL frames normalize temporary roots too", () => {
  const first = {
    ...input("/srv/app"),
    stack: "assertValidPayload@file:///tmp/tmp.abcXYZ/src/index.js:12:3",
  };
  const second = {
    ...first,
    stack: "assertValidPayload@file:///tmp/tmp.otherXYZ/src/index.js:12:3",
  };
  expect(fingerprintSeed(first)).toBe(fingerprintSeed(second));
});

test("explicit grouping keys and missing stacks retain existing behavior", () => {
  expect(
    fingerprintSeed({
      ...input("/tmp/tmp.abcXYZ"),
      groupingKey: "gmail-validation",
    }),
  ).toBe("grouping-key|gmail-validation");
  expect(fingerprintSeed({ name: "Error", message: "failed" })).toBe(
    "Error|failed|",
  );
});
