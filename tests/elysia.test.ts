import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Elysia, status } from "elysia";
import { createErrorTracker, createMemoryIssueStore } from "../src";
import {
  errorsPlugin,
  handledError,
  type ErrorsCaptureContext,
} from "../src/elysia";

type Capture = {
  context: ErrorsCaptureContext | undefined;
  error: unknown;
};

const recorder = () => {
  const captures: Capture[] = [];

  return {
    capture: (error: unknown, context?: ErrorsCaptureContext) => {
      captures.push({ context, error });
    },
    captures,
  };
};

describe("errorsPlugin", () => {
  test("captures server failures through the configured tracker", async () => {
    const tracker = createErrorTracker();
    let captureSettled: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      captureSettled = resolve;
    });
    const app = new Elysia()
      .use(
        errorsPlugin({
          server: {
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
      errorsPlugin({
        server: false,
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

  test("captures a thrown server exception exactly once", async () => {
    const { capture, captures } = recorder();
    const original = new Error("database unavailable");
    const app = new Elysia()
      .use(errorsPlugin({ server: { capture } }))
      .get("/boom", () => {
        throw original;
      });

    const response = await app.handle(new Request("http://localhost/boom"));
    await Bun.sleep(10);

    expect(response.status).toBe(500);
    expect(response.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.error).toBe(original);
    expect(captures[0]?.context?.tags).toMatchObject({
      captureKind: "thrown_http_5xx",
      method: "GET",
      path: "/boom",
      status: "500",
    });
  });

  test("filters intentional returned 5xx responses without hiding exceptions", async () => {
    const { capture, captures } = recorder();
    const app = new Elysia()
      .use(
        errorsPlugin({
          server: {
            capture,
            captureReturned5xx: ({ context, responseType, status }) =>
              !(
                new URL(context.request.url).pathname === "/readyz" &&
                responseType === "object" &&
                status === 503
              ),
          },
        }),
      )
      .get("/readyz", () => status(503, { status: "fail" }))
      .get("/failed", () => status(503, "unavailable"))
      .get("/readyz-threw", () => {
        throw new Error("readiness implementation crashed");
      });

    const readiness = await app.handle(new Request("http://localhost/readyz"));
    const failed = await app.handle(new Request("http://localhost/failed"));
    const threw = await app.handle(
      new Request("http://localhost/readyz-threw"),
    );
    await Bun.sleep(10);

    expect(readiness.status).toBe(503);
    expect(failed.status).toBe(503);
    expect(threw.status).toBe(500);
    expect(captures).toHaveLength(2);
    const captureKinds = captures.map(
      ({ context }) => context?.tags?.captureKind,
    );
    expect(captureKinds).toContain("returned_http_5xx");
    expect(captureKinds).toContain("thrown_http_5xx");
  });

  test("captures handled exceptions without exposing them", async () => {
    const { capture, captures } = recorder();
    const original = new Error("password=secret database unavailable");
    const app = new Elysia()
      .use(errorsPlugin({ server: { capture } }))
      .get("/handled", () =>
        handledError(
          status("Internal Server Error", "Unable to start the response."),
          original,
        ),
      );

    const response = await app.handle(new Request("http://localhost/handled"));
    const body = await response.text();
    await Bun.sleep(10);

    expect(response.status).toBe(500);
    expect(body).not.toContain(original.message);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.error).toBe(original);
    expect(captures[0]?.context?.tags?.captureKind).toBe("handled_http_5xx");
  });

  test("does not capture expected client errors", async () => {
    const { capture, captures } = recorder();
    const app = new Elysia()
      .use(errorsPlugin({ server: { capture } }))
      .get("/missing", () => status("Not Found", "missing"));

    const response = await app.handle(new Request("http://localhost/missing"));
    await Bun.sleep(10);

    expect(response.status).toBe(404);
    expect(captures).toHaveLength(0);
  });

  test("allows forwarded capture without a local tracker", async () => {
    const { capture, captures } = recorder();
    const app = new Elysia()
      .use(
        errorsPlugin({
          server: {
            capture,
            context: ({ request }) => ({
              tenant: request.headers.get("x-user-id") ?? undefined,
            }),
            traceHeader: "x-error-trace",
            traceId: () => "trace-fixed",
          },
        }),
      )
      .get("/forwarded", () => status(500, "failed"));

    const response = await app.handle(
      new Request("http://localhost/forwarded", {
        headers: { "x-user-id": "user-1" },
      }),
    );
    await Bun.sleep(10);

    expect(response.headers.get("x-error-trace")).toBe("trace-fixed");
    expect(captures[0]?.context).toMatchObject({
      tenant: "user-1",
      traceId: "trace-fixed",
    });
  });

  test("rejects ingest without a configured store", () => {
    const tracker = createErrorTracker();

    expect(() => errorsPlugin({ ingest: {}, tracker })).toThrow(
      "requires ingest.store or a store configured on tracker",
    );
  });

  test("requires one of tracker or server.capture for server capture", () => {
    expect(() => errorsPlugin({})).toThrow(
      "requires server.capture or tracker when server capture is enabled",
    );
  });
});
