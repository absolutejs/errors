import { describe, expect, test } from "bun:test";
import { browserReportsEnvelope } from "../src/reporting";

describe("browserReportsEnvelope", () => {
  test("maps crash deliveries into stable error events", () => {
    const envelope = browserReportsEnvelope(
      [
        {
          age: 250,
          body: { crash_report_api: { releaseChannel: "dev" } },
          type: "crash",
          url: "https://app.test/portal/deals?token=secret",
          user_agent: "intentionally not retained",
        },
      ],
      { environment: "dev", project: "dealroom", release: "abc123" },
      10_000,
    );

    expect(envelope).toMatchObject({
      environment: "dev",
      project: "dealroom",
      release: "abc123",
      v: 1,
    });
    expect(envelope?.events[0]).toMatchObject({
      at: 9750,
      groupingKey: "browser-report:crash:/portal/deals",
      level: "error",
      message: "Browser process crashed — /portal/deals",
      name: "BrowserCrash",
      tags: {
        reportType: "crash",
        signal: "browser_crash",
        sourcePath: "/portal/deals",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("user_agent");
  });

  test("groups policy reports by their browser-provided identity", () => {
    const envelope = browserReportsEnvelope(
      [
        {
          body: { id: "DocumentWrite" },
          type: "deprecation",
          url: "https://app.test/admin",
        },
      ],
      { project: "dealroom" },
    );
    expect(envelope?.events[0]).toMatchObject({
      groupingKey: "browser-report:deprecation:DocumentWrite",
      level: "warning",
      name: "BrowserReport",
      tags: { signal: "browser_report" },
    });
  });

  test("rejects non-array deliveries and skips malformed entries", () => {
    expect(browserReportsEnvelope({}, { project: "dealroom" })).toBeNull();
    expect(
      browserReportsEnvelope([null, { type: 12 }], { project: "dealroom" })
        ?.events,
    ).toEqual([]);
  });
});

test("excludes extension-owned policy reports without hiding first-party paths or crashes", () => {
  const sources = [
    "chrome-extension://abc/hooks.js",
    "moz-extension://abc/hooks.js",
    "safari-web-extension://abc/hooks.js",
    "https://app.test/moz-extension/hooks.js",
    "/moz-extension/hooks.js",
    "https://app.test/main.js",
  ];
  const envelope = browserReportsEnvelope(
    sources.map((sourceFile) => ({
      type: "deprecation",
      url: "https://app.test/",
      body: { id: "DocumentWrite", sourceFile },
    })),
    { project: "app" },
  );
  expect(envelope?.events).toHaveLength(3);
  expect(envelope?.events.map((event) => event.extra?.reportBody)).toEqual(
    sources.slice(3).map((sourceFile) => ({ id: "DocumentWrite", sourceFile })),
  );
  expect(
    browserReportsEnvelope(
      [
        {
          type: "crash",
          url: "https://app.test/",
          body: { sourceFile: sources[0] },
        },
      ],
      { project: "app" },
    )?.events,
  ).toHaveLength(1);
});
