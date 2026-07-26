/**
 * Tests for @absolutejs/errors/ingest — coalescing buffer, Schema-validated
 * endpoint, and the drainer.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createMemoryIssueStore, type StoredEvent } from "../src/index";
import {
  createDrainer,
  createIngestEndpoint,
  createInMemoryEventBuffer,
  ingestPlugin,
  ingestRejectionStatus,
  type IngestRejection,
} from "../src/ingest";

const ev = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  at: 1000,
  fingerprint: "fp-1",
  level: "error",
  message: "boom",
  name: "Error",
  project: "acme",
  ...over,
});

const runIngest = <A>(
  eff: Effect.Effect<A, IngestRejection>,
): Promise<{ ok: true; value: A } | { ok: false; tag: string }> =>
  Effect.runPromise(
    eff.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catchAll((error) =>
        Effect.succeed({ ok: false as const, tag: error._tag }),
      ),
    ),
  );

// =============================================================================
// Coalescing buffer
// =============================================================================

describe("createInMemoryEventBuffer", () => {
  test("coalesces N occurrences of one fingerprint into a single group", () => {
    const buffer = createInMemoryEventBuffer({ maxSamplesPerGroup: 3 });
    for (let i = 0; i < 100; i += 1) {
      buffer.push(ev({ at: 1000 + i }));
    }
    expect(buffer.stats().groups).toBe(1);
    expect(buffer.stats().events).toBe(100);
    const groups = buffer.drain();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.occurrences).toBe(100);
    expect(groups[0]?.firstSeen).toBe(1000);
    expect(groups[0]?.lastSeen).toBe(1099);
    expect(groups[0]?.samples.length).toBe(3); // capped
    // drain empties the buffer
    expect(buffer.drain()).toHaveLength(0);
  });

  test("separate fingerprints stay separate groups", () => {
    const buffer = createInMemoryEventBuffer();
    buffer.push(ev({ fingerprint: "a" }));
    buffer.push(ev({ fingerprint: "b" }));
    buffer.push(ev({ fingerprint: "a" }));
    const groups = buffer.drain();
    expect(groups).toHaveLength(2);
  });

  test("escalates the group level to the max severity seen", () => {
    const buffer = createInMemoryEventBuffer();
    buffer.push(ev({ level: "warning" }));
    buffer.push(ev({ level: "fatal" }));
    buffer.push(ev({ level: "info" }));
    expect(buffer.drain()[0]?.representative.level).toBe("fatal");
  });

  test("backpressure: drops new groups past maxGroups, counts them", () => {
    const buffer = createInMemoryEventBuffer({ maxGroups: 2 });
    buffer.push(ev({ fingerprint: "a" }));
    buffer.push(ev({ fingerprint: "b" }));
    buffer.push(ev({ fingerprint: "c" })); // dropped — buffer full
    buffer.push(ev({ fingerprint: "a" })); // existing group still accepted
    expect(buffer.stats().groups).toBe(2);
    expect(buffer.stats().droppedGroups).toBe(1);
  });
});

// =============================================================================
// Endpoint — validation + fingerprinting
// =============================================================================

const envelope = (over: Record<string, unknown> = {}) => ({
  events: [{ message: "kaboom", name: "TypeError" }],
  project: "acme",
  v: 1,
  ...over,
});

describe("createIngestEndpoint — validation", () => {
  test("accepts a valid envelope + buffers the events", async () => {
    const buffer = createInMemoryEventBuffer();
    const { ingest } = createIngestEndpoint({ buffer });
    const result = await runIngest(ingest({ body: envelope() }));
    expect(result).toEqual({
      ok: true,
      value: { accepted: 1, project: "acme" },
    });
    expect(buffer.stats().events).toBe(1);
  });

  test("redacts browser context before fingerprinting and buffering", async () => {
    const buffer = createInMemoryEventBuffer();
    const { ingest } = createIngestEndpoint({ buffer });
    const result = await runIngest(
      ingest({
        body: envelope({
          events: [
            {
              extra: {
                breadcrumbs: [
                  {
                    message: "Authorization: Bearer header.payload.signature",
                  },
                ],
                credentials: {
                  apiKey: "key-live",
                  nested: { password: "hunter2" },
                },
              },
              message: "request failed token=raw-token",
              name: "Error",
              tags: {
                url: "/callback?code=oauth-code&next=%2Fportal#done",
              },
            },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(true);

    const event = buffer.drain()[0]?.representative;
    expect(event?.message).toBe("request failed token=[REDACTED]");
    expect(event?.tags?.url).toBe("/callback");
    expect(event?.extra?.credentials).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
    expect(event?.extra?.breadcrumbs).toEqual([
      {
        message: "Authorization: Bearer [REDACTED]",
      },
    ]);
  });

  test("supports replacing the default ingest redaction policy", async () => {
    const buffer = createInMemoryEventBuffer();
    const { ingest } = createIngestEndpoint({
      buffer,
      redact: (event) => ({ ...event, message: "host-redacted" }),
    });
    await runIngest(ingest({ body: envelope() }));

    expect(buffer.drain()[0]?.representative.message).toBe("host-redacted");
  });

  test("parses a raw JSON string body", async () => {
    const buffer = createInMemoryEventBuffer();
    const { ingest } = createIngestEndpoint({ buffer });
    const result = await runIngest(
      ingest({ body: JSON.stringify(envelope()) }),
    );
    expect(result.ok).toBe(true);
  });

  test("MalformedJson for invalid JSON string", async () => {
    const { ingest } = createIngestEndpoint({
      buffer: createInMemoryEventBuffer(),
    });
    const result = await runIngest(ingest({ body: "{not json" }));
    expect(result).toEqual({ ok: false, tag: "MalformedJson" });
  });

  test("SchemaInvalid for a bad shape (wrong version, missing fields)", async () => {
    const { ingest } = createIngestEndpoint({
      buffer: createInMemoryEventBuffer(),
    });
    const bad = await runIngest(
      ingest({ body: { events: [], project: "x", v: 2 } }),
    );
    expect(bad).toEqual({ ok: false, tag: "SchemaInvalid" });
    const missing = await runIngest(
      ingest({ body: { v: 1, events: [{ name: "E" }] } }),
    );
    expect(missing).toEqual({ ok: false, tag: "SchemaInvalid" });
  });

  test("PayloadTooLarge when bytes exceed the limit", async () => {
    const { ingest } = createIngestEndpoint({
      buffer: createInMemoryEventBuffer(),
      maxBytes: 10,
    });
    const result = await runIngest(ingest({ body: envelope(), bytes: 5000 }));
    expect(result).toEqual({ ok: false, tag: "PayloadTooLarge" });
  });

  test("TooManyEvents when the envelope overflows maxEvents", async () => {
    const { ingest } = createIngestEndpoint({
      buffer: createInMemoryEventBuffer(),
      maxEvents: 1,
    });
    const result = await runIngest(
      ingest({
        body: envelope({
          events: [
            { name: "A", message: "a" },
            { name: "B", message: "b" },
          ],
        }),
      }),
    );
    expect(result).toEqual({ ok: false, tag: "TooManyEvents" });
  });

  test("authorize can reject (Unauthorized / UnknownProject)", async () => {
    const { ingest } = createIngestEndpoint({
      authorize: ({ key }) =>
        key === "secret"
          ? Effect.void
          : Effect.fail(
              new (require("../src/ingest").Unauthorized)({
                reason: "bad-key",
              }),
            ),
      buffer: createInMemoryEventBuffer(),
    });
    const denied = await runIngest(ingest({ body: envelope() }));
    expect(denied).toEqual({ ok: false, tag: "Unauthorized" });
    const ok = await runIngest(ingest({ body: envelope(), key: "secret" }));
    expect(ok.ok).toBe(true);
  });

  test("identical (name,message) events coalesce to one group via server fingerprint", async () => {
    const buffer = createInMemoryEventBuffer();
    const { ingest } = createIngestEndpoint({ buffer });
    await runIngest(
      ingest({
        body: envelope({
          events: [
            { name: "Error", message: "db timeout" },
            { name: "Error", message: "db timeout" },
            { name: "Error", message: "other" },
          ],
        }),
      }),
    );
    // 3 events, 2 distinct fingerprints
    expect(buffer.stats().events).toBe(3);
    expect(buffer.stats().groups).toBe(2);
  });
});

describe("ingestRejectionStatus", () => {
  test("maps each rejection tag to its HTTP status", () => {
    const cases: Array<[IngestRejection["_tag"], number]> = [
      ["PayloadTooLarge", 413],
      ["MalformedJson", 400],
      ["SchemaInvalid", 400],
      ["TooManyEvents", 422],
      ["Unauthorized", 401],
      ["UnknownProject", 404],
      ["RateLimited", 429],
    ];
    for (const [tag, status] of cases) {
      expect(ingestRejectionStatus({ _tag: tag } as IngestRejection)).toBe(
        status,
      );
    }
  });
});

// =============================================================================
// Drainer — end to end into a store
// =============================================================================

describe("createDrainer", () => {
  test("flushes one coalesced upsert per herd into the store", async () => {
    const store = createMemoryIssueStore();
    const buffer = createInMemoryEventBuffer();
    const drainer = createDrainer({ buffer, intervalMs: 1_000_000, store });
    for (let i = 0; i < 250; i += 1) buffer.push(ev({ at: 1000 + i }));
    const result = await Effect.runPromise(drainer.flush());
    expect(result.groups).toBe(1);
    expect(result.occurrences).toBe(250);
    const issues = await Effect.runPromise(
      store.listIssues!({ project: "acme" }),
    );
    expect(issues[0]?.timesSeen).toBe(250); // 250 events → ONE upsert, count 250
    await drainer.stop();
  });

  test("fires onIssue on a new issue", async () => {
    const store = createMemoryIssueStore();
    const buffer = createInMemoryEventBuffer();
    let fired = 0;
    const drainer = createDrainer({
      buffer,
      intervalMs: 1_000_000,
      onIssue: () => {
        fired += 1;
      },
      store,
    });
    buffer.push(ev());
    buffer.push(ev());
    await Effect.runPromise(drainer.flush());
    expect(fired).toBe(1); // one group → one new-issue alert
    await drainer.stop();
  });

  test("prepare() rewrites both stored samples and the issue representative", async () => {
    const store = createMemoryIssueStore();
    const buffer = createInMemoryEventBuffer();
    const drainer = createDrainer({
      buffer,
      intervalMs: 1_000_000,
      prepare: (event) =>
        Effect.succeed({
          ...event,
          message: "sanitized",
          stack: "SYMBOLICATED",
        }),
      store,
    });
    buffer.push(ev({ stack: "minified" }));
    await Effect.runPromise(drainer.flush());
    const issues = await Effect.runPromise(
      store.listIssues!({ project: "acme" }),
    );
    const events = await Effect.runPromise(
      store.listEvents!("acme", issues[0]!.fingerprint),
    );
    expect(events[0]?.stack).toBe("SYMBOLICATED");
    expect(events[0]?.message).toBe("sanitized");
    expect(issues[0]?.title).toContain("sanitized");
    await drainer.stop();
  });

  test("regroups release-specific raw fingerprints after symbolication", async () => {
    const store = createMemoryIssueStore();
    const buffer = createInMemoryEventBuffer();
    let alerts = 0;
    const drainer = createDrainer({
      buffer,
      intervalMs: 1_000_000,
      onIssue: () => {
        alerts += 1;
      },
      prepare: (event) =>
        Effect.succeed({
          ...event,
          stack:
            "WebMcpUnavailableError: unavailable\n    at createRegistry (../node_modules/@absolutejs/webmcp/src/index.ts:102:11)",
        }),
      store,
    });
    buffer.push(
      ev({
        at: 1000,
        fingerprint: "raw-release-a",
        message: "WebMCP is unavailable",
        name: "WebMcpUnavailableError",
        release: "release-a",
        stack:
          "WebMcpUnavailableError: unavailable\n    at C (chunk-a1b2.js:2:3385)",
      }),
    );
    buffer.push(
      ev({
        at: 2000,
        fingerprint: "raw-release-b",
        message: "WebMCP is unavailable",
        name: "WebMcpUnavailableError",
        release: "release-b",
        stack:
          "WebMcpUnavailableError: unavailable\n    at C (chunk-c3d4.js:2:3385)",
      }),
    );

    const result = await Effect.runPromise(drainer.flush());
    const issues = await Effect.runPromise(
      store.listIssues!({ project: "acme" }),
    );
    expect(result.groups).toBe(1);
    expect(result.occurrences).toBe(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.timesSeen).toBe(2);
    expect(issues[0]?.lastRelease).toBe("release-b");
    expect(alerts).toBe(1);
    const events = await Effect.runPromise(
      store.listEvents!("acme", issues[0]!.fingerprint),
    );
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.fingerprint)).size).toBe(1);
    expect(events[0]?.stack).toContain("@absolutejs/webmcp/src/index.ts");
    await drainer.stop();
  });

  test("onError fires when the store rejects a group", async () => {
    const buffer = createInMemoryEventBuffer();
    const errors: string[] = [];
    const drainer = createDrainer({
      buffer,
      intervalMs: 1_000_000,
      onError: (e) => errors.push(e._tag),
      store: {
        record: () => Effect.die("unused"),
        recordCoalesced: () =>
          Effect.fail(
            new (require("../src/index").IssueStoreQueryError)({
              cause: new Error("down"),
              op: "record",
            }),
          ),
      },
    });
    buffer.push(ev());
    const result = await Effect.runPromise(drainer.flush());
    expect(result.failures).toBe(1);
    expect(errors).toEqual(["IssueStoreQueryError"]);
    await drainer.stop();
  });
});

describe("ingestPlugin lifecycle", () => {
  test("flushes the pending buffer when Elysia stops", async () => {
    const store = createMemoryIssueStore();
    const buffer = createInMemoryEventBuffer();
    let stop: (() => unknown) | undefined;
    await ingestPlugin({
      buffer,
      intervalMs: 1_000_000,
      makeElysia: () => ({
        onStop(handler) {
          stop = handler;
          return this;
        },
        post() {
          return this;
        },
      }),
      store,
    });
    buffer.push(ev());

    expect(stop).toBeFunction();
    await stop?.();
    const issues = await Effect.runPromise(
      store.listIssues!({ project: "acme" }),
    );
    expect(issues[0]?.timesSeen).toBe(1);
  });
});
