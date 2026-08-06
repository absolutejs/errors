/**
 * @absolutejs/errors/ingest — the server-side ingest pipeline for browser
 * `beacon` payloads.
 *
 *   POST → validate (effect Schema, untrusted)        [createIngestEndpoint]
 *        → push into an in-process COALESCING buffer    [createInMemoryEventBuffer]
 *        → 202 immediately
 *   ⟳ drainer (every ~500ms): flush coalesced groups   [createDrainer]
 *        → optional prepare() (e.g. symbolication)
 *        → ONE recordCoalesced per fingerprint (collapses thundering herds)
 *        → onIssue() on new / regression
 *
 * The buffer coalesces by `(project, fingerprint)`: N identical errors in a
 * window become a single `times_seen += N` upsert + a capped sample of raw
 * events, so an incident's herd touches the hot issue row once. It's in-process
 * and bounded (`maxGroups` × `maxSamplesPerGroup`) — no Redis. A `RedisEventBuffer`
 * or durable-log buffer can implement `EventBuffer` later WITHOUT touching the
 * endpoint, for the enterprise triggers (zero-loss SLA, cross-instance quotas).
 *
 * Errors-as-values: every rejection is a typed `IngestRejection` (tagged), each
 * mapping to a specific HTTP status via the exhaustive `ingestRejectionStatus`.
 *
 * The endpoint, buffer, and drainer are framework-agnostic. Elysia mounting is
 * provided only by the combined `errorsPlugin` in `@absolutejs/errors/elysia`.
 */
import { Data, Effect, Either, ParseResult, Schema } from "effect";
import { computeFingerprint } from "./fingerprint";
import type {
  CoalescedGroup,
  IssueLevel,
  IssueStore,
  IssueStoreError,
  IssueUpsertResult,
  StoredEvent,
} from "./index";

const SEVERITY_RANK: Record<IssueLevel, number> = {
  error: 2,
  fatal: 3,
  info: 0,
  warning: 1,
};
const DEFAULT_MAX_SAMPLES_PER_GROUP = 10;

// =============================================================================
// In-process coalescing buffer
// =============================================================================

type Accumulator = {
  representative: StoredEvent;
  level: IssueLevel;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  samples: StoredEvent[];
};

export type BufferStats = {
  /** Distinct (project, fingerprint) groups currently pending. */
  groups: number;
  /** Events pending (not yet drained). */
  events: number;
  /** Lifetime count of events dropped because `maxGroups` was full. */
  droppedGroups: number;
};

/**
 * The pluggable buffer seam. v1 ships `createInMemoryEventBuffer`; a Redis- or
 * durable-log-backed implementation drops in here when an enterprise guarantee
 * (zero-loss, cross-instance quota) demands it.
 */
export type EventBuffer = {
  /** Add a validated event to the coalescer. Sub-ms, synchronous, never fails. */
  push: (event: StoredEvent) => void;
  /** Return all pending coalesced groups and clear the buffer. */
  drain: () => CoalescedGroup[];
  stats: () => BufferStats;
};

export type InMemoryEventBufferOptions = {
  /**
   * Max distinct `(project, fingerprint)` groups held between flushes. New
   * groups beyond this are dropped (counted in `droppedGroups`) — bounds memory
   * to `maxGroups × maxSamplesPerGroup` regardless of event volume. Occurrence
   * counts within an existing group are unbounded (just an integer). Default 10_000.
   */
  maxGroups?: number;
  /** Max sampled raw events persisted per group per flush. Default 10. */
  maxSamplesPerGroup?: number;
};

const groupKey = (event: StoredEvent): string =>
  `${event.project}\0${event.fingerprint}`;

export const createInMemoryEventBuffer = (
  options: InMemoryEventBufferOptions = {},
): EventBuffer => {
  const maxGroups = options.maxGroups ?? 10_000;
  const maxSamples =
    options.maxSamplesPerGroup ?? DEFAULT_MAX_SAMPLES_PER_GROUP;
  const groups = new Map<string, Accumulator>();
  let pendingEvents = 0;
  let droppedGroups = 0;

  const push = (event: StoredEvent): void => {
    const key = groupKey(event);
    const acc = groups.get(key);
    if (acc === undefined) {
      if (groups.size >= maxGroups) {
        droppedGroups += 1; // backpressure: bound memory, shed load
        return;
      }
      groups.set(key, {
        firstSeen: event.at,
        lastSeen: event.at,
        level: event.level,
        occurrences: 1,
        representative: event,
        samples: [event],
      });
      pendingEvents += 1;
      return;
    }
    acc.occurrences += 1;
    acc.representative = event; // latest wins for title/release/stack
    if (SEVERITY_RANK[event.level] > SEVERITY_RANK[acc.level]) {
      acc.level = event.level; // escalate, never de-escalate
    }
    if (event.at < acc.firstSeen) acc.firstSeen = event.at;
    if (event.at > acc.lastSeen) acc.lastSeen = event.at;
    acc.samples.push(event);
    if (acc.samples.length > maxSamples) acc.samples.shift();
    pendingEvents += 1;
  };

  const drain = (): CoalescedGroup[] => {
    const out: CoalescedGroup[] = [];
    for (const acc of groups.values()) {
      out.push({
        firstSeen: acc.firstSeen,
        lastSeen: acc.lastSeen,
        occurrences: acc.occurrences,
        representative: { ...acc.representative, level: acc.level },
        samples: acc.samples,
      });
    }
    groups.clear();
    pendingEvents = 0;
    return out;
  };

  return {
    drain,
    push,
    stats: () => ({
      droppedGroups,
      events: pendingEvents,
      groups: groups.size,
    }),
  };
};

// =============================================================================
// Payload schema (the beacon → ingest envelope)
// =============================================================================

const BeaconEventSchema = Schema.Struct({
  groupingKey: Schema.optional(Schema.String),
  name: Schema.String,
  message: Schema.String,
  level: Schema.optional(Schema.Literal("fatal", "error", "warning", "info")),
  stack: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  replayId: Schema.optional(Schema.String),
  tags: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  extra: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

const BeaconEnvelopeSchema = Schema.Struct({
  v: Schema.Literal(1),
  project: Schema.String,
  release: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  events: Schema.Array(BeaconEventSchema),
});

export type BeaconEvent = typeof BeaconEventSchema.Type;
export type BeaconEnvelope = typeof BeaconEnvelopeSchema.Type;

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "csrftoken",
  "idtoken",
  "password",
  "passwd",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
]);
const URL_KEY_NAMES = new Set([
  "endpoint",
  "errorfilename",
  "resourceurl",
  "sourcefile",
  "url",
]);
const normalizeFieldName = (key: string): string =>
  key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const isSensitiveField = (key: string): boolean =>
  SENSITIVE_KEY_NAMES.has(normalizeFieldName(key));
const isUrlField = (key: string): boolean =>
  URL_KEY_NAMES.has(normalizeFieldName(key));

const redactUrl = (value: string): string => {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
    const url = new URL(value, "https://errors.invalid");
    url.search = "";
    url.hash = "";
    return absolute ? url.toString() : `${url.pathname}`;
  } catch {
    return value.replace(/[?#].*$/, "");
  }
};

const redactString = (value: string): string =>
  value
    .replace(
      /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      /([?&](?:access_token|api_?key|authorization|code|id_token|password|refresh_token|secret|token)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\b((?:access_?token|api_?key|authorization|client_?secret|cookie|id_?token|password|passwd|refresh_?token|secret|token)\s*[:=]\s*)(?!Bearer\b|\[REDACTED\])[^,\s;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      REDACTED,
    );

const redactValue = (
  value: unknown,
  key: string | undefined,
  seen: Set<object>,
  depth = 0,
): unknown => {
  if (key !== undefined && isSensitiveField(key)) return REDACTED;
  if (typeof value === "string") {
    return redactString(
      key !== undefined && isUrlField(key) ? redactUrl(value) : value,
    );
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 12) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const redacted = Array.isArray(value)
    ? value.map((entry) => redactValue(entry, undefined, seen, depth + 1))
    : Object.fromEntries(
        Object.entries(value).map(([field, entry]) => [
          field,
          redactValue(entry, field, seen, depth + 1),
        ]),
      );
  seen.delete(value);
  return redacted;
};

/**
 * Defense-in-depth redaction for an already schema-validated browser event.
 * The client performs the same pass, but the ingest boundary does not trust it.
 */
export const redactBeaconEvent = (event: BeaconEvent): BeaconEvent => ({
  ...event,
  ...(event.groupingKey !== undefined
    ? { groupingKey: redactString(event.groupingKey).slice(0, 200) }
    : {}),
  message: redactString(event.message),
  ...(event.stack !== undefined ? { stack: redactString(event.stack) } : {}),
  ...(event.tags !== undefined
    ? {
        tags: Object.fromEntries(
          Object.entries(event.tags).map(([key, value]) => [
            key,
            redactValue(value, key, new Set()),
          ]),
        ) as Record<string, string>,
      }
    : {}),
  ...(event.extra !== undefined
    ? {
        extra: redactValue(event.extra, undefined, new Set()) as Record<
          string,
          unknown
        >,
      }
    : {}),
});

// =============================================================================
// Typed rejections — each maps to ONE HTTP status (exhaustive switch)
// =============================================================================

export class PayloadTooLarge extends Data.TaggedError("PayloadTooLarge")<{
  limitBytes: number;
  actualBytes: number;
}> {}
export class MalformedJson extends Data.TaggedError("MalformedJson")<{
  cause: unknown;
}> {}
export class SchemaInvalid extends Data.TaggedError("SchemaInvalid")<{
  message: string;
}> {}
export class UnknownProject extends Data.TaggedError("UnknownProject")<{
  project: string;
}> {}
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  reason: "missing-key" | "bad-key";
}> {}
export class RateLimited extends Data.TaggedError("RateLimited")<{
  retryAfterMs: number;
}> {}
export class TooManyEvents extends Data.TaggedError("TooManyEvents")<{
  limit: number;
  actual: number;
}> {}

export type IngestRejection =
  | PayloadTooLarge
  | MalformedJson
  | SchemaInvalid
  | UnknownProject
  | Unauthorized
  | RateLimited
  | TooManyEvents;

/** Map a rejection to its HTTP status. Exhaustive — adding a tag is a compile error. */
export const ingestRejectionStatus = (rejection: IngestRejection): number => {
  switch (rejection._tag) {
    case "PayloadTooLarge":
      return 413;
    case "MalformedJson":
    case "SchemaInvalid":
      return 400;
    case "TooManyEvents":
      return 422;
    case "Unauthorized":
      return 401;
    case "UnknownProject":
      return 404;
    case "RateLimited":
      return 429;
  }
};

// =============================================================================
// Ingest endpoint (framework-agnostic)
// =============================================================================

export type IngestAuthorizer = (input: {
  project: string;
  key?: string;
}) => Effect.Effect<void, Unauthorized | UnknownProject>;

export type IngestOptions = {
  buffer: EventBuffer;
  /** Per-request authorization. Omit to accept any project (dev / trusted edge). */
  authorize?: IngestAuthorizer;
  /** Reject envelopes whose byte size exceeds this. Default 512_000 (512 KB). */
  maxBytes?: number;
  /** Reject envelopes carrying more than this many events. Default 1000. */
  maxEvents?: number;
  /** Override `Date.now()` for `at` defaults / tests. */
  clock?: () => number;
  /**
   * Defense-in-depth redaction after validation and before fingerprinting or
   * buffering. Default true. Pass a function to replace the built-in policy.
   */
  redact?: boolean | ((event: BeaconEvent) => BeaconEvent);
};

export type IngestAccepted = { project: string; accepted: number };

export type IngestRequest = {
  /** Parsed object, or a raw JSON string (which will be parsed). */
  body: unknown;
  /** Byte size, when known (e.g. Content-Length) — enforces `maxBytes`. */
  bytes?: number;
  /** Auth key, when present (e.g. `x-beacon-key` header). */
  key?: string;
};

export type IngestEndpoint = {
  ingest: (
    request: IngestRequest,
  ) => Effect.Effect<IngestAccepted, IngestRejection>;
};

export const createIngestEndpoint = (
  options: IngestOptions,
): IngestEndpoint => {
  const maxBytes = options.maxBytes ?? 512_000;
  const maxEvents = options.maxEvents ?? 1000;
  const clock = options.clock ?? Date.now;
  const decode = Schema.decodeUnknown(BeaconEnvelopeSchema);
  const redact =
    typeof options.redact === "function"
      ? options.redact
      : options.redact === false
        ? (event: BeaconEvent) => event
        : redactBeaconEvent;

  const toStored = (
    event: BeaconEvent,
    envelope: BeaconEnvelope,
    fingerprint: string,
    now: number,
  ): StoredEvent => {
    const stored: StoredEvent = {
      at: event.at ?? now,
      fingerprint,
      level: event.level ?? "error",
      message: event.message,
      name: event.name,
      project: envelope.project,
    };
    if (event.groupingKey !== undefined) stored.groupingKey = event.groupingKey;
    if (event.stack !== undefined) stored.stack = event.stack;
    if (envelope.release !== undefined) stored.release = envelope.release;
    if (envelope.environment !== undefined) {
      stored.environment = envelope.environment;
    }
    if (event.traceId !== undefined) stored.traceId = event.traceId;
    if (event.spanId !== undefined) stored.spanId = event.spanId;
    if (event.replayId !== undefined) stored.replayId = event.replayId;
    if (event.tags !== undefined) stored.tags = { ...event.tags };
    if (event.extra !== undefined) stored.extra = { ...event.extra };
    return stored;
  };

  const ingest = (
    request: IngestRequest,
  ): Effect.Effect<IngestAccepted, IngestRejection> =>
    Effect.gen(function* () {
      if (request.bytes !== undefined && request.bytes > maxBytes) {
        return yield* Effect.fail(
          new PayloadTooLarge({
            actualBytes: request.bytes,
            limitBytes: maxBytes,
          }),
        );
      }

      const parsed =
        typeof request.body === "string"
          ? yield* Effect.try({
              catch: (cause) => new MalformedJson({ cause }),
              try: () => JSON.parse(request.body as string) as unknown,
            })
          : request.body;

      const envelope = yield* decode(parsed).pipe(
        Effect.mapError(
          (error) =>
            new SchemaInvalid({
              message: ParseResult.TreeFormatter.formatErrorSync(error),
            }),
        ),
      );

      if (envelope.events.length > maxEvents) {
        return yield* Effect.fail(
          new TooManyEvents({
            actual: envelope.events.length,
            limit: maxEvents,
          }),
        );
      }

      if (options.authorize !== undefined) {
        yield* options.authorize({
          project: envelope.project,
          ...(request.key !== undefined ? { key: request.key } : {}),
        });
      }

      const now = clock();
      for (const rawEvent of envelope.events) {
        const event = redact(rawEvent);
        const fingerprint = yield* Effect.promise(() =>
          computeFingerprint({
            ...(event.groupingKey !== undefined
              ? { groupingKey: event.groupingKey }
              : {}),
            message: event.message,
            name: event.name,
            ...(event.stack !== undefined ? { stack: event.stack } : {}),
          }),
        );
        options.buffer.push(toStored(event, envelope, fingerprint, now));
      }

      return { accepted: envelope.events.length, project: envelope.project };
    });

  return { ingest };
};

// =============================================================================
// Drainer — flushes coalesced groups to the store on an interval
// =============================================================================

export type FlushResult = {
  /** Distinct groups flushed this cycle. */
  groups: number;
  /** Total occurrences represented (sum of coalesced counts). */
  occurrences: number;
  /** Groups that failed to persist (store error). */
  failures: number;
};

export type DrainerOptions = {
  buffer: EventBuffer;
  store: IssueStore;
  /** Flush interval (ms). Default 500. */
  intervalMs?: number;
  /**
   * Applied to each sampled event before persistence — the symbolication hook.
   * Wire `@absolutejs/errors/symbolicate` here to rewrite minified stacks. Off
   * the hot path (runs in the drainer, not the request).
   */
  prepare?: (event: StoredEvent) => Effect.Effect<StoredEvent>;
  /** Max prepared samples retained when raw groups merge canonically. Default 10. */
  maxSamplesPerGroup?: number;
  /** Fired per NEW or REGRESSED issue — the alerting hook (→ @absolutejs/dispatch). */
  onIssue?: (result: IssueUpsertResult) => void | Promise<void>;
  /** Fired when a group fails to persist (store degraded). */
  onError?: (error: IssueStoreError) => void;
};

export type Drainer = {
  /** Flush all pending groups once, now. Also what the interval invokes. */
  flush: () => Effect.Effect<FlushResult>;
  /** Stop the interval and do a final flush (call on graceful shutdown). */
  stop: () => Promise<FlushResult>;
};

export const createDrainer = (options: DrainerOptions): Drainer => {
  const intervalMs = options.intervalMs ?? 500;
  const maxSamples =
    options.maxSamplesPerGroup ?? DEFAULT_MAX_SAMPLES_PER_GROUP;
  const { buffer, store } = options;
  const recordCoalesced = store.recordCoalesced;

  const persist = (
    group: CoalescedGroup,
  ): Effect.Effect<IssueUpsertResult, IssueStoreError> => {
    if (recordCoalesced !== undefined) return recordCoalesced(group);
    // Degraded fallback (adapter has no coalesced path): record each sample
    // once. `times_seen` then reflects the sample count, not true occurrences.
    // Both bundled adapters implement recordCoalesced, so this is rare.
    return Effect.gen(function* () {
      let last = yield* store.record(group.representative);
      for (const sample of group.samples) last = yield* store.record(sample);
      return last;
    });
  };

  const canonicalize = (group: CoalescedGroup): Effect.Effect<CoalescedGroup> =>
    Effect.gen(function* () {
      const representative =
        options.prepare !== undefined
          ? yield* options.prepare(group.representative)
          : group.representative;
      const samples =
        options.prepare !== undefined
          ? yield* Effect.all(group.samples.map(options.prepare))
          : group.samples;
      // `prepare` may source-map a release-specific minified frame or redact a
      // message. Recompute from that canonical representation so two builds of
      // the same source failure persist under one durable issue fingerprint.
      const fingerprint = yield* Effect.promise(() =>
        computeFingerprint({
          ...(representative.groupingKey !== undefined
            ? { groupingKey: representative.groupingKey }
            : {}),
          message: representative.message,
          name: representative.name,
          ...(representative.stack !== undefined
            ? { stack: representative.stack }
            : {}),
        }),
      );
      return {
        ...group,
        representative: { ...representative, fingerprint },
        samples: samples.map((sample) => ({ ...sample, fingerprint })),
      };
    });

  const mergeCanonicalGroups = (groups: CoalescedGroup[]): CoalescedGroup[] => {
    const merged = new Map<string, CoalescedGroup>();
    for (const group of groups) {
      const key = groupKey(group.representative);
      const current = merged.get(key);
      if (current === undefined) {
        merged.set(key, group);
        continue;
      }
      const latest =
        group.lastSeen >= current.lastSeen
          ? group.representative
          : current.representative;
      const level =
        SEVERITY_RANK[group.representative.level] >
        SEVERITY_RANK[current.representative.level]
          ? group.representative.level
          : current.representative.level;
      const samples = [...current.samples, ...group.samples]
        .sort((a, b) => a.at - b.at)
        .slice(-maxSamples);
      merged.set(key, {
        firstSeen: Math.min(current.firstSeen, group.firstSeen),
        lastSeen: Math.max(current.lastSeen, group.lastSeen),
        occurrences: current.occurrences + group.occurrences,
        representative: { ...latest, level },
        samples,
      });
    }
    return [...merged.values()];
  };

  const flush = (): Effect.Effect<FlushResult> =>
    Effect.gen(function* () {
      const rawGroups = buffer.drain();
      const groups = mergeCanonicalGroups(
        yield* Effect.all(rawGroups.map(canonicalize)),
      );
      let occurrences = 0;
      let failures = 0;
      for (const group of groups) {
        const result = yield* Effect.either(persist(group));
        if (Either.isRight(result)) {
          occurrences += group.occurrences;
          const upsert = result.right;
          if (
            (upsert.isNew || upsert.isRegression) &&
            options.onIssue !== undefined
          ) {
            // A throwing onIssue must not break the flush.
            yield* Effect.either(
              Effect.tryPromise({
                catch: (cause) => cause,
                try: () => Promise.resolve(options.onIssue!(upsert)),
              }),
            );
          }
        } else {
          failures += 1;
          options.onError?.(result.left);
        }
      }
      return { failures, groups: groups.length, occurrences };
    });

  const timer = setInterval(() => {
    void Effect.runPromise(flush());
  }, intervalMs);
  // Don't keep the process alive solely for the drainer.
  (timer as { unref?: () => void }).unref?.();

  return {
    flush,
    stop: async () => {
      clearInterval(timer);
      return Effect.runPromise(flush());
    },
  };
};
