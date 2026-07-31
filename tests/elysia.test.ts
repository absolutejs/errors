import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Elysia, status } from "elysia";
import { createErrorTracker, createMemoryIssueStore } from "../src";
import { errorBoundaryPlugin, errorsPlugin, errorsElysia } from "../src/elysia";

describe("errorsPlugin", () => {
  test("captures server failures through the configured tracker", async () => {
    const tracker = createErrorTracker();
    let captureSettled: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      captureSettled = resolve;
    });
    const app = new Elysia()
      .use(
        await errorsPlugin({
          boundary: {
            capture: async (error, context) => {
              await tracker.captureException(error, context);
              captureSettled?.();
            },
          },
          tracker,
        }),
      )
      .get("/failed", () => status(503, "unavailable"));

    const response = await app.handle(new Request("http://localhost/failed"));
    await captured;

    expect(response.status).toBe(503);
    expect(tracker.recentErrors()).toHaveLength(1);
    expect(tracker.recentErrors()[0]?.context.tags).toMatchObject({
      captureKind: "returned_http_5xx",
      path: "/failed",
      status: "503",
    });
  });

  test("mounts browser ingest from the same plugin settings", async () => {
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({ store });
    const app = new Elysia().use(
      await errorsPlugin({
        boundary: false,
        ingest: { intervalMs: 5 },
        tracker,
      }),
    );

    const response = await app.handle(
      new Request("http://localhost/ingest", {
        body: JSON.stringify({
          events: [{ message: "browser failed", name: "TypeError" }],
          project: "web",
          v: 1,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    await Bun.sleep(20);
    const issues = await Effect.runPromise(
      store.listIssues!({ project: "web" }),
    );

    expect(response.status).toBe(202);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toContain("browser failed");
  });

  test("rejects ingest without a configured store", async () => {
    const tracker = createErrorTracker();

    expect(errorsPlugin({ ingest: {}, tracker })).rejects.toThrow(
      "requires ingest.store or a store configured on tracker",
    );
  });

  test("exposes a clear primitive name while retaining compatibility", () => {
    expect(errorBoundaryPlugin).toBe(errorsElysia);
  });
});
