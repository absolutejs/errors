/**
 * Tests for @absolutejs/errors (Effect-native).
 */
import { describe, expect, test } from "bun:test";
import { Effect, Either, Option } from "effect";
import {
  AuditSinkFailure,
  createErrorTracker,
  createMemoryIssueStore,
  handoffErrorContext,
  issueCulprit,
  issueTitle,
  IssueStoreQueryError,
  StoreFailure,
  TracerFailure,
  type ErrorAuditLike,
  type ErrorTracerLike,
  type IssueStore,
  type IssueStoreError,
  type IssueUpsertResult,
  type StoredEvent,
} from "../src/index";

test("handoffErrorContext links Issues without copying evidence payloads", () => {
  const context = handoffErrorContext(
    {
      authoritativeOutcome: "succeeded",
      contradiction: true,
      correlationId: "handoff-1",
      latest: {
        at: 1,
        correlationId: "handoff-1",
        externalId: "private-external-id",
        message: "customer-visible error",
        operation: "invoice_payment",
        outcome: "failed",
        reference: "private-reference",
        service: "gateway",
        source: "external_surface_report",
      },
      operation: "invoice_payment",
      reportedOutcome: "failed",
      service: "gateway",
      status: "succeeded",
    },
    { tags: { component: "billing" } },
  );

  expect(context).toMatchObject({
    target: "handoff-1",
    tags: {
      component: "billing",
      "handoff.contradiction": "true",
      "handoff.operation": "invoice_payment",
      "handoff.service": "gateway",
      "handoff.status": "succeeded",
    },
  });
  expect(JSON.stringify(context)).not.toContain("private-external-id");
  expect(JSON.stringify(context)).not.toContain("private-reference");
  expect(JSON.stringify(context)).not.toContain("customer-visible error");
});

// =============================================================================
// Mocks
// =============================================================================

type AuditRecord = {
  kind: string;
  actor?: string;
  target?: string;
  metadata?: Record<string, unknown>;
};

const makeAudit = (): { audit: ErrorAuditLike; events: AuditRecord[] } => {
  const events: AuditRecord[] = [];
  return {
    audit: {
      append: async (e) => {
        events.push(e);
      },
    },
    events,
  };
};

const makeTracer = (): {
  tracer: ErrorTracerLike;
  spans: Array<{
    name: string;
    attributes: Record<string, unknown>;
    exception?: unknown;
  }>;
} => {
  const spans: Array<{
    name: string;
    attributes: Record<string, unknown>;
    exception?: unknown;
  }> = [];
  return {
    spans,
    tracer: {
      startSpan: (name) => {
        const record: {
          name: string;
          attributes: Record<string, unknown>;
          exception?: unknown;
        } = { attributes: {}, name };
        spans.push(record);
        return {
          end: () => {},
          recordException: (ex) => {
            record.exception = ex;
          },
          setAttribute: (key, value) => {
            record.attributes[key] = value;
          },
        };
      },
    },
  };
};

// =============================================================================
// capture — basic shape
// =============================================================================

describe("capture — basics", () => {
  test("outcome carries a stable fingerprint + fully-delivered (no sinks)", async () => {
    const tracker = createErrorTracker();
    const out = await tracker.captureException(new Error("something broke"));
    expect(typeof out.fingerprint).toBe("string");
    expect(out.fingerprint.length).toBeGreaterThan(0);
    expect(out.failures).toHaveLength(0);
    expect(out.delivered.fingerprint).toBe("ok");
    expect(out.delivered.audit).toBe("skipped");
    expect(out.delivered.store).toBe("skipped");
  });

  test("the Effect API never fails (E = never) and yields the same outcome", async () => {
    const tracker = createErrorTracker();
    const out = await Effect.runPromise(tracker.capture(new Error("boom")));
    expect(out.fingerprint.length).toBeGreaterThan(0);
    expect(out.failures).toHaveLength(0);
  });

  test("same error → same fingerprint across captures", async () => {
    const tracker = createErrorTracker();
    const makeErr = () => {
      const e = new Error("repeatable");
      e.stack = "Error: repeatable\n    at f (file.ts:10:5)";
      return e;
    };
    const a = await tracker.captureException(makeErr());
    const b = await tracker.captureException(makeErr());
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("different errors → different fingerprints", async () => {
    const tracker = createErrorTracker();
    const a = await tracker.captureException(new TypeError("a is undefined"));
    const b = await tracker.captureException(new RangeError("out of bounds"));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test("coerces non-Error inputs", async () => {
    const tracker = createErrorTracker();
    const outs = await Promise.all([
      tracker.captureException("a string error"),
      tracker.captureException({ message: "an object" }),
      tracker.captureException(42),
    ]);
    expect(outs.every((o) => typeof o.fingerprint === "string")).toBe(true);
    expect(tracker.metrics().captured).toBe(3);
  });

  test("preserves nested causes and driver diagnostics without changing wrapper grouping", async () => {
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({ project: "dealroom", store });
    const postgresError = Object.assign(new Error("write CONNECTION_CLOSED"), {
      code: "57P01",
      detail: "server closed the connection unexpectedly",
      routine: "ProcessInterrupts",
      severity: "FATAL",
    });
    const queryError = new Error("Failed query: update queue_jobs", {
      cause: postgresError,
    });
    queryError.name = "DrizzleQueryError";
    queryError.stack =
      "DrizzleQueryError: Failed query: update queue_jobs\n    at reapStuck (store.ts:10:2)";

    const first = await tracker.captureException(queryError, {
      extra: { operation: "reapStuck" },
    });
    const sameWrapperDifferentCause = new Error(
      "Failed query: update queue_jobs",
      { cause: new Error("timeout") },
    );
    sameWrapperDifferentCause.name = "DrizzleQueryError";
    sameWrapperDifferentCause.stack = queryError.stack;
    const second = await tracker.captureException(sameWrapperDifferentCause);

    expect(second.fingerprint).toBe(first.fingerprint);
    const events = await Effect.runPromise(
      store.listEvents!("dealroom", first.fingerprint),
    );
    const reaperEvent = events.find(
      (event) => event.extra?.operation === "reapStuck",
    );
    expect(reaperEvent?.stack).toContain(
      "Caused by: Error: write CONNECTION_CLOSED",
    );
    expect(reaperEvent?.extra?.errorCauses).toEqual([
      expect.objectContaining({
        message: "write CONNECTION_CLOSED",
        name: "Error",
        properties: expect.objectContaining({
          code: "57P01",
          detail: "server closed the connection unexpectedly",
          routine: "ProcessInterrupts",
          severity: "FATAL",
        }),
        stack: expect.stringContaining("Error: write CONNECTION_CLOSED"),
      }),
    ]);
  });

  test("preserves cross-realm causes and safely terminates circular chains", async () => {
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({ store });
    const cause: {
      cause?: unknown;
      message: string;
      name: string;
      stack: string;
    } = {
      message: "driver failed",
      name: "DriverError",
      stack: "DriverError: driver failed\n    at driver.js:2:1",
    };
    cause.cause = cause;
    await tracker.captureException({
      cause,
      message: "query failed",
      name: "QueryError",
      stack: "QueryError: query failed\n    at query.js:1:1",
    });

    const issues = await Effect.runPromise(store.listIssues!());
    const events = await Effect.runPromise(
      store.listEvents!("default", issues[0]!.fingerprint),
    );
    expect(events[0]?.stack).toStartWith(
      "QueryError: query failed\n    at query.js:1:1",
    );
    expect(events[0]?.extra?.errorCauses).toEqual([
      expect.objectContaining({
        message: "driver failed",
        name: "DriverError",
      }),
      {
        message: "Cause chain references an earlier error",
        name: "CircularErrorCause",
      },
    ]);
  });

  test("digits + quoted strings normalized out of the message for fingerprinting", async () => {
    const tracker = createErrorTracker();
    const a = await tracker.captureException(
      new Error("user 'u_42' not found"),
    );
    const b = await tracker.captureException(
      new Error("user 'u_99' not found"),
    );
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("Safari frames prevent unrelated normalized messages from colliding", async () => {
    const tracker = createErrorTracker();
    const jsonLd = await tracker.captureException({
      message: `undefined is not an object (evaluating 'r["@context"].toLowerCase')`,
      name: "TypeError",
      stack:
        `TypeError: undefined is not an object\n` +
        "@https://onspark.com/:3:185\n" +
        "global code@https://onspark.com/:3:362",
    });
    const injected = await tracker.captureException({
      message:
        "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      name: "TypeError",
      stack:
        `TypeError: undefined is not an object\n` +
        "f@https://onspark.com/:1:681\n" +
        "w@https://onspark.com/:1:1849",
    });

    expect(jsonLd.fingerprint).not.toBe(injected.fingerprint);
  });

  test("Safari frame line changes preserve one logical fingerprint", async () => {
    const tracker = createErrorTracker();
    const first = await tracker.captureException({
      message:
        "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      name: "TypeError",
      stack: "TypeError: failed\nsendDataToNative@https://onspark.com/:1:1142",
    });
    const moved = await tracker.captureException({
      message:
        "undefined is not an object (evaluating 'window.webkit.messageHandlers')",
      name: "TypeError",
      stack: "TypeError: failed\nsendDataToNative@https://onspark.com/:8:9912",
    });

    expect(first.fingerprint).toBe(moved.fingerprint);
    expect(
      issueCulprit(
        "TypeError: failed\nsendDataToNative@https://onspark.com/:8:9912",
      ),
    ).toBe("sendDataToNative@https://onspark.com/:8:9912");
  });

  test("custom fingerprint function is respected", async () => {
    const tracker = createErrorTracker({ fingerprint: () => "always-this" });
    const a = await tracker.captureException(new Error("a"));
    const b = await tracker.captureException(new Error("b"));
    expect(a.fingerprint).toBe("always-this");
    expect(b.fingerprint).toBe("always-this");
  });

  test("fingerprint throwing → typed FingerprintFailure + degenerate fallback, capture still succeeds", async () => {
    const tracker = createErrorTracker({
      fingerprint: () => {
        throw new Error("hasher down");
      },
    });
    const out = await tracker.captureException(new Error("x"));
    expect(out.fingerprint).toBe("0".repeat(16));
    expect(out.delivered.fingerprint).toBe("failed");
    expect(out.failures[0]?._tag).toBe("FingerprintFailure");
    expect(tracker.metrics().captureErrors).toBe(1);
  });
});

// =============================================================================
// Audit integration
// =============================================================================

describe("audit integration", () => {
  test("emits errors.captured with fingerprint + metadata + delivered ok", async () => {
    const { audit, events } = makeAudit();
    const tracker = createErrorTracker({ audit });
    const out = await tracker.captureException(new Error("boom"), {
      extra: { route: "/api/x" },
      tags: { component: "http" },
      target: "order_42",
      tenant: "acme",
    });
    expect(out.delivered.audit).toBe("ok");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("errors.captured");
    expect(event.actor).toBe("acme");
    expect(event.target).toBe("order_42");
    expect(event.metadata?.name).toBe("Error");
    expect(event.metadata?.message).toBe("boom");
    expect(event.metadata?.tags).toEqual({ component: "http" });
    expect(event.metadata?.extra).toEqual({ route: "/api/x" });
    expect(typeof event.metadata?.fingerprint).toBe("string");
  });

  test("release + environment + replayId propagate to metadata", async () => {
    const { audit, events } = makeAudit();
    const tracker = createErrorTracker({
      audit,
      environment: "production",
      release: "v1.2.3",
    });
    await tracker.captureException(new Error("boom"), { replayId: "rep-1" });
    expect(events[0]?.metadata?.release).toBe("v1.2.3");
    expect(events[0]?.metadata?.environment).toBe("production");
    expect(events[0]?.metadata?.replayId).toBe("rep-1");
  });

  test("audit throwing → typed AuditSinkFailure, delivered failed, capture survives", async () => {
    const tracker = createErrorTracker({
      audit: {
        append: () => {
          throw new Error("audit down");
        },
      },
    });
    const out = await tracker.captureException(new Error("user error"));
    expect(out.delivered.audit).toBe("failed");
    expect(out.failures).toHaveLength(1);
    const failure = out.failures[0]!;
    expect(failure._tag).toBe("AuditSinkFailure");
    expect(failure instanceof AuditSinkFailure).toBe(true);
    expect(((failure as AuditSinkFailure).cause as Error).message).toBe(
      "audit down",
    );
    expect(tracker.metrics().captureErrors).toBe(1);
  });
});

// =============================================================================
// Tracer integration
// =============================================================================

describe("tracer integration", () => {
  test("records the exception on a fresh span + delivered ok", async () => {
    const { tracer, spans } = makeTracer();
    const tracker = createErrorTracker({ tracer });
    const err = new Error("boom");
    const out = await tracker.captureException(err, { tenant: "acme" });
    expect(out.delivered.tracer).toBe("ok");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("errors.captured");
    expect(spans[0]?.exception).toBe(err);
    expect(spans[0]?.attributes["abs.tenant"]).toBe("acme");
  });

  test("tags propagate to span attributes", async () => {
    const { tracer, spans } = makeTracer();
    const tracker = createErrorTracker({ tracer });
    await tracker.captureException(new Error("x"), {
      tags: { component: "http", method: "GET" },
    });
    expect(spans[0]?.attributes["error.tag.component"]).toBe("http");
    expect(spans[0]?.attributes["error.tag.method"]).toBe("GET");
  });

  test("tracer throwing → typed TracerFailure, delivered failed", async () => {
    const tracker = createErrorTracker({
      tracer: {
        startSpan: () => {
          throw new Error("tracer down");
        },
      },
    });
    const out = await tracker.captureException(new Error("user error"));
    expect(out.delivered.tracer).toBe("failed");
    expect(out.failures[0]?._tag).toBe("TracerFailure");
    expect(out.failures[0] instanceof TracerFailure).toBe(true);
    expect(tracker.metrics().captureErrors).toBe(1);
  });

  test("tracer.startSpan undefined → tracer skipped, no failure", async () => {
    const tracker = createErrorTracker({ tracer: {} });
    const out = await tracker.captureException(new Error("x"));
    expect(out.delivered.tracer).toBe("skipped");
    expect(out.failures).toHaveLength(0);
  });
});

// =============================================================================
// Recent buffer + metrics
// =============================================================================

describe("recent buffer", () => {
  test("captures newest-first", async () => {
    const tracker = createErrorTracker();
    await tracker.captureException(new Error("a"));
    await tracker.captureException(new Error("b"));
    await tracker.captureException(new Error("c"));
    expect(tracker.recentErrors().map((e) => e.message)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  test("LRU caps at maxRecent", async () => {
    const tracker = createErrorTracker({ maxRecent: 2 });
    await tracker.captureException(new Error("a"));
    await tracker.captureException(new Error("b"));
    await tracker.captureException(new Error("c"));
    const recent = tracker.recentErrors();
    expect(recent).toHaveLength(2);
    expect(recent.map((e) => e.message)).toEqual(["c", "b"]);
  });

  test("clearRecent empties the buffer but keeps counters", async () => {
    const tracker = createErrorTracker();
    await tracker.captureException(new Error("a"));
    expect(tracker.recentErrors()).toHaveLength(1);
    tracker.clearRecent();
    expect(tracker.recentErrors()).toHaveLength(0);
    expect(tracker.metrics().captured).toBe(1);
  });
});

describe("metrics", () => {
  test("byFingerprint counts per-fingerprint occurrences", async () => {
    const tracker = createErrorTracker({
      fingerprint: (err) => (err.message === "a" ? "fp-a" : "fp-b"),
    });
    await tracker.captureException(new Error("a"));
    await tracker.captureException(new Error("a"));
    await tracker.captureException(new Error("b"));
    const m = tracker.metrics();
    expect(m.captured).toBe(3);
    expect(m.byFingerprint["fp-a"]).toBe(2);
    expect(m.byFingerprint["fp-b"]).toBe(1);
  });

  test("byFingerprint caps at maxFingerprints to bound memory", async () => {
    let counter = 0;
    const tracker = createErrorTracker({
      fingerprint: () => `unique-${counter++}`,
      maxFingerprints: 3,
    });
    for (let i = 0; i < 10; i += 1) {
      await tracker.captureException(new Error("x"));
    }
    const m = tracker.metrics();
    expect(Object.keys(m.byFingerprint).length).toBeLessThanOrEqual(3);
    expect(m.captured).toBe(10);
  });

  test("clock override is used for `at`", async () => {
    const tracker = createErrorTracker({ clock: () => 12345 });
    await tracker.captureException(new Error("a"));
    expect(tracker.recentErrors()[0]?.at).toBe(12345);
  });
});

// =============================================================================
// Issue-title / culprit helpers
// =============================================================================

describe("issueTitle / issueCulprit", () => {
  test("title removes quoted values without stripping meaningful digits", () => {
    expect(issueTitle("TypeError", "user 'u_42' not found")).toBe(
      "TypeError: user '?' not found",
    );
    expect(issueTitle("Error", "Server error response (5xx)")).toBe(
      "Error: Server error response (5xx)",
    );
  });

  test("empty message → bare name", () => {
    expect(issueTitle("Error", "")).toBe("Error");
  });

  test("culprit is the first `at` frame", () => {
    const stack =
      "Error: boom\n    at f (file.ts:10:5)\n    at g (file.ts:20:1)";
    expect(issueCulprit(stack)).toBe("at f (file.ts:10:5)");
  });

  test("culprit empty when no stack", () => {
    expect(issueCulprit(undefined)).toBe("");
  });
});

// =============================================================================
// Durable issue store — memory reference (Effect-native)
// =============================================================================

const run = <A>(eff: Effect.Effect<A, IssueStoreError>): Promise<A> =>
  Effect.runPromise(eff);

describe("createMemoryIssueStore", () => {
  test("first capture → isNew, unresolved, timesSeen 1", async () => {
    const store = createMemoryIssueStore();
    const result = await run(
      store.record({
        at: 1000,
        fingerprint: "fp-1",
        level: "error",
        message: "boom",
        name: "Error",
        project: "acme",
      }),
    );
    expect(result.isNew).toBe(true);
    expect(result.isRegression).toBe(false);
    expect(result.issue.state).toBe("unresolved");
    expect(result.issue.timesSeen).toBe(1);
    expect(result.issue.firstSeen).toBe(1000);
    expect(result.issue.title).toBe("Error: boom");
  });

  test("repeat capture → not new, timesSeen increments, lastSeen advances", async () => {
    const store = createMemoryIssueStore();
    const base = {
      fingerprint: "fp-1",
      level: "error" as const,
      message: "boom",
      name: "Error",
      project: "acme",
    };
    await run(store.record({ ...base, at: 1000 }));
    const second = await run(store.record({ ...base, at: 2000 }));
    expect(second.isNew).toBe(false);
    expect(second.issue.timesSeen).toBe(2);
    expect(second.issue.firstSeen).toBe(1000);
    expect(second.issue.lastSeen).toBe(2000);
  });

  test("resolved issue seen again → regression, flips to unresolved", async () => {
    const store = createMemoryIssueStore();
    const base = {
      fingerprint: "fp-1",
      level: "error" as const,
      message: "boom",
      name: "Error",
      project: "acme",
    };
    await run(store.record({ ...base, at: 1000 }));
    await run(store.setState!("acme", "fp-1", "resolved"));
    const regressed = await run(store.record({ ...base, at: 3000 }));
    expect(regressed.isRegression).toBe(true);
    expect(regressed.isNew).toBe(false);
    expect(regressed.issue.state).toBe("unresolved");
  });

  test("ignored issue seen again stays ignored (no regression)", async () => {
    const store = createMemoryIssueStore();
    const base = {
      fingerprint: "fp-1",
      level: "error" as const,
      message: "boom",
      name: "Error",
      project: "acme",
    };
    await run(store.record({ ...base, at: 1000 }));
    await run(store.setState!("acme", "fp-1", "ignored"));
    const again = await run(store.record({ ...base, at: 2000 }));
    expect(again.isRegression).toBe(false);
    expect(again.issue.state).toBe("ignored");
  });

  test("severity escalates but never de-escalates", async () => {
    const store = createMemoryIssueStore();
    const base = {
      fingerprint: "fp-1",
      message: "boom",
      name: "Error",
      project: "acme",
    };
    await run(store.record({ ...base, at: 1, level: "warning" }));
    const up = await run(store.record({ ...base, at: 2, level: "fatal" }));
    expect(up.issue.level).toBe("fatal");
    const down = await run(store.record({ ...base, at: 3, level: "info" }));
    expect(down.issue.level).toBe("fatal");
  });

  test("first/last release tracked across captures", async () => {
    const store = createMemoryIssueStore();
    const base = {
      fingerprint: "fp-1",
      level: "error" as const,
      message: "boom",
      name: "Error",
      project: "acme",
    };
    await run(store.record({ ...base, at: 1, release: "v1.0.0" }));
    const later = await run(
      store.record({ ...base, at: 2, release: "v1.1.0" }),
    );
    expect(later.issue.firstRelease).toBe("v1.0.0");
    expect(later.issue.lastRelease).toBe("v1.1.0");
  });

  test("project scoping isolates same fingerprint across projects", async () => {
    const store = createMemoryIssueStore();
    const base = {
      fingerprint: "fp-1",
      level: "error" as const,
      message: "boom",
      name: "Error",
    };
    await run(store.record({ ...base, at: 1, project: "acme" }));
    await run(store.record({ ...base, at: 2, project: "globex" }));
    const acme = await run(store.getIssue!("acme", "fp-1"));
    const globex = await run(store.getIssue!("globex", "fp-1"));
    expect(Option.getOrThrow(acme).timesSeen).toBe(1);
    expect(Option.getOrThrow(globex).timesSeen).toBe(1);
  });

  test("getIssue returns Option.none for an unknown fingerprint", async () => {
    const store = createMemoryIssueStore();
    const missing = await run(store.getIssue!("acme", "nope"));
    expect(Option.isNone(missing)).toBe(true);
  });

  test("listIssues filters by state + query, newest-first", async () => {
    const store = createMemoryIssueStore();
    await run(
      store.record({
        at: 1,
        fingerprint: "a",
        level: "error",
        message: "database timeout",
        name: "Error",
        project: "acme",
      }),
    );
    await run(
      store.record({
        at: 2,
        fingerprint: "b",
        level: "error",
        message: "null pointer",
        name: "TypeError",
        project: "acme",
      }),
    );
    await run(store.setState!("acme", "a", "resolved"));
    const unresolved = await run(
      store.listIssues!({ project: "acme", state: "unresolved" }),
    );
    expect(unresolved.map((i) => i.fingerprint)).toEqual(["b"]);
    const dbHits = await run(store.listIssues!({ query: "database" }));
    expect(dbHits.map((i) => i.fingerprint)).toEqual(["a"]);
  });

  test("listEvents returns newest-first, capped", async () => {
    const store = createMemoryIssueStore({ maxEventsPerIssue: 2 });
    const base = {
      fingerprint: "fp-1",
      level: "error" as const,
      name: "Error",
      project: "acme",
    };
    await run(store.record({ ...base, at: 1, message: "a" }));
    await run(store.record({ ...base, at: 2, message: "b" }));
    await run(store.record({ ...base, at: 3, message: "c" }));
    const evts = await run(store.listEvents!("acme", "fp-1"));
    expect(evts.map((e) => e.message)).toEqual(["c", "b"]);
  });

  test("assign + unassign", async () => {
    const store = createMemoryIssueStore();
    await run(
      store.record({
        at: 1,
        fingerprint: "fp-1",
        level: "error",
        message: "boom",
        name: "Error",
        project: "acme",
      }),
    );
    await run(store.assign!("acme", "fp-1", "alice"));
    expect(
      Option.getOrThrow(await run(store.getIssue!("acme", "fp-1"))).assignee,
    ).toBe("alice");
    await run(store.assign!("acme", "fp-1", null));
    expect(
      Option.getOrThrow(await run(store.getIssue!("acme", "fp-1"))).assignee,
    ).toBeUndefined();
  });
});

// =============================================================================
// Tracker ↔ store integration
// =============================================================================

describe("tracker ↔ store integration", () => {
  test("capture upserts an issue carrying release + replayId", async () => {
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({
      environment: "production",
      project: "acme",
      release: "v2.0.0",
      store,
    });
    const out = await tracker.captureException(new Error("boom"), {
      replayId: "rep-123",
      traceId: "trace-abc",
    });
    expect(out.delivered.store).toBe("ok");
    expect(out.issue?.isNew).toBe(true);
    const issues = await run(store.listIssues!({ project: "acme" }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.lastRelease).toBe("v2.0.0");
    expect(issues[0]?.environment).toBe("production");
    const evts = await run(store.listEvents!("acme", issues[0]!.fingerprint));
    expect(evts[0]?.replayId).toBe("rep-123");
    expect(evts[0]?.traceId).toBe("trace-abc");
  });

  test("onIssue fires on new + regression, not on routine repeats", async () => {
    const store = createMemoryIssueStore();
    const fired: IssueUpsertResult[] = [];
    const tracker = createErrorTracker({
      fingerprint: () => "fp-stable",
      onIssue: (r) => {
        fired.push(r);
      },
      project: "acme",
      store,
    });
    await tracker.captureException(new Error("boom")); // new
    await tracker.captureException(new Error("boom")); // repeat — no fire
    expect(fired).toHaveLength(1);
    expect(fired[0]?.isNew).toBe(true);

    await run(store.setState!("acme", "fp-stable", "resolved"));
    const out = await tracker.captureException(new Error("boom")); // regression
    expect(fired).toHaveLength(2);
    expect(fired[1]?.isRegression).toBe(true);
    expect(out.delivered.onIssue).toBe("ok");
  });

  test("onIssue does NOT run on a routine repeat (delivered skipped)", async () => {
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({
      fingerprint: () => "fp-stable",
      onIssue: () => {},
      project: "acme",
      store,
    });
    await tracker.captureException(new Error("boom")); // new → onIssue ok
    const repeat = await tracker.captureException(new Error("boom"));
    expect(repeat.delivered.onIssue).toBe("skipped");
  });

  test('default project is "default" when unset', async () => {
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({ store });
    await tracker.captureException(new Error("boom"));
    const issues = await run(store.listIssues!());
    expect(issues[0]?.project).toBe("default");
  });

  test("store failing → typed StoreFailure wrapping IssueStoreError, capture survives", async () => {
    const failingStore: IssueStore = {
      record: (event: StoredEvent) =>
        Effect.fail(
          new IssueStoreQueryError({
            cause: new Error("connection refused"),
            op: `record:${event.fingerprint}`,
          }),
        ),
    };
    const tracker = createErrorTracker({ store: failingStore });
    const out = await tracker.captureException(new Error("boom"));
    expect(typeof out.fingerprint).toBe("string");
    expect(out.delivered.store).toBe("failed");
    expect(out.issue).toBeUndefined();
    const failure = out.failures[0]!;
    expect(failure._tag).toBe("StoreFailure");
    expect(failure instanceof StoreFailure).toBe(true);
    const inner = (failure as StoreFailure).cause;
    expect(inner._tag).toBe("IssueStoreQueryError");
    expect(tracker.metrics().captureErrors).toBe(1);
  });

  test("onIssue throwing → typed OnIssueFailure, store still delivered", async () => {
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({
      onIssue: () => {
        throw new Error("pager down");
      },
      store,
    });
    const out = await tracker.captureException(new Error("boom"));
    expect(out.delivered.store).toBe("ok");
    expect(out.delivered.onIssue).toBe("failed");
    expect(out.failures[0]?._tag).toBe("OnIssueFailure");
  });
});

// =============================================================================
// Composition + exhaustive failure handling
// =============================================================================

describe("composition", () => {
  test("audit + tracer + store all fire on one capture", async () => {
    const { audit, events } = makeAudit();
    const { tracer, spans } = makeTracer();
    const store = createMemoryIssueStore();
    const tracker = createErrorTracker({
      audit,
      environment: "production",
      release: "v1.0.0",
      store,
      tracer,
    });
    const out = await tracker.captureException(new Error("boom"), {
      tenant: "acme",
    });
    expect(out.delivered).toEqual({
      audit: "ok",
      fingerprint: "ok",
      onIssue: "skipped",
      store: "ok",
      tracer: "ok",
    });
    expect(events).toHaveLength(1);
    expect(spans).toHaveLength(1);
    expect(events[0]?.metadata?.fingerprint).toBe(out.fingerprint);
  });

  test("every CaptureFailure is exhaustively switchable by _tag", async () => {
    const tracker = createErrorTracker({
      audit: {
        append: () => {
          throw new Error("audit down");
        },
      },
    });
    const out = await tracker.captureException(new Error("boom"));
    const describe = (f: (typeof out.failures)[number]): string => {
      switch (f._tag) {
        case "FingerprintFailure":
          return "fingerprint";
        case "AuditSinkFailure":
          return "audit";
        case "TracerFailure":
          return "tracer";
        case "StoreFailure":
          return `store:${f.cause._tag}`;
        case "OnIssueFailure":
          return "onIssue";
      }
    };
    expect(out.failures.map(describe)).toEqual(["audit"]);
  });

  test("capture (Effect) composes in a wider program via Either", async () => {
    const tracker = createErrorTracker();
    const program = Effect.gen(function* () {
      const out = yield* tracker.capture(new Error("boom"));
      return out.failures.length === 0
        ? Either.right(out.fingerprint)
        : Either.left(out.failures);
    });
    const result = await Effect.runPromise(program);
    expect(Either.isRight(result)).toBe(true);
  });
});
