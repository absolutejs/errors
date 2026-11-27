import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as redact from "../src/redaction";
import { redactTelemetryString, redactTelemetryValue } from "../src";

/* `@absolutejs/errors/redact` is for code that only needs to scrub what it
 * logs: it must stay free of imports, so loading it never pulls in Effect or
 * the tracker (about 1 s in a large app's test files). */
describe("@absolutejs/errors/redact", () => {
  test("has no imports", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/redaction.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\(/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  test("exports the same functions as the package root", () => {
    expect(redact.redactTelemetryString).toBe(redactTelemetryString);
    expect(redact.redactTelemetryValue).toBe(redactTelemetryValue);
  });
});
