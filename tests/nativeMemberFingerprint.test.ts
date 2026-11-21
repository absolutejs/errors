import { expect, test } from "bun:test";
import { fingerprintSeed, issueTitle } from "../src/fingerprint";
const reader =
  "undefined is not an object (evaluating 'window.__firefox__.reader')";
const wallet =
  "undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')";
const seed = (message: string, column = 19) =>
  fingerprintSeed({
    name: "TypeError",
    message,
    stack: `global code@https://example.com/page:1:${column}`,
  });
test("WebKit reader and wallet failures retain distinct useful signatures", () => {
  expect(seed(reader)).not.toBe(seed(wallet, 16));
  expect(issueTitle("TypeError", reader)).toContain(
    "window.__firefox__.reader",
  );
  expect(issueTitle("TypeError", wallet)).toContain(
    "window.ethereum.selectedAddress = undefined",
  );
  expect(seed(reader)).toBe(seed(reader, 120));
  expect(
    seed("undefined is not an object (evaluating 'app.field1.value')"),
  ).not.toBe(
    seed("undefined is not an object (evaluating 'app.field2.value')"),
  );
});
test("quoted data, computed keys, calls and arbitrary evaluated text stay redacted", () => {
  for (const expression of [
    'app["private@example.com"]',
    'app.secret("private")',
    'app.value = "private"',
    "https://private.example.com",
    "private",
    "app." + "private".repeat(50),
  ]) {
    const message = `undefined is not an object (evaluating '${expression}')`;
    expect(issueTitle("TypeError", message)).not.toContain("private");
    expect(seed(message)).not.toContain("private");
  }
  expect(issueTitle("Error", reader)).toBe(
    "Error: undefined is not an object (evaluating '?')",
  );
});
