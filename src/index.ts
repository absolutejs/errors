/**
 * @absolutejs/errors — Effect-native, Sentry-equivalent exception capture
 * for the AbsoluteJS substrate.
 *
 * `createErrorTracker({ audit?, tracer?, store?, … })` returns a tracker whose
 * `capture(error, context?)` is an `Effect<CaptureOutcome, never>` — capturing
 * an error can never itself fail. Every fan-out (audit / tracer / store /
 * onIssue) is a trust boundary, so each is wrapped and its failure becomes a
 * **typed, tagged value** (`Data.TaggedError`) collected into the outcome —
 * never swallowed into an anonymous counter. The outcome reports a per-sink
 * delivery state (`'ok' | 'failed' | 'skipped'`) so a caller knows exactly
 * what landed and what didn't, and why.
 *
 * Errors-as-values, the discipline:
 *   - Our own logic (fingerprinting fallback, issue grouping) is total.
 *   - Store adapters return a typed `IssueStoreError` in the E channel.
 *   - User-supplied sinks (audit append, custom onIssue) can throw `unknown`
 *     at the boundary; we wrap that `unknown` in a tagged failure that records
 *     WHICH sink and WHICH op produced it — the leaf cause is preserved, the
 *     provenance is never lost.
 *
 * A Promise edge (`captureException`) runs the effect for Promise-world
 * consumers; the Effect API (`capture`) is primary.
 */
import { Data, Effect, Either, Option } from "effect";
import {
  computeFingerprint,
  FALLBACK_FINGERPRINT,
  issueCulprit,
  issueTitle,
} from "./fingerprint";

export {
  computeFingerprint,
  issueCulprit,
  issueTitle,
  fingerprintSeed,
} from "./fingerprint";

// =============================================================================
// Narrow sink interfaces — satisfied by @absolutejs/audit + @absolutejs/telemetry
// =============================================================================

export type ErrorAuditLike = {
  append: (event: {
    kind: string;
    actor?: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
};

export type ErrorTracerLike = {
  startSpan?: (name: string) => {
    setAttribute?: (key: string, value: string | number | boolean) => unknown;
    recordException?: (error: unknown) => void;
    end?: () => void;
  };
};

// =============================================================================
// Capture envelope
// =============================================================================

export type ErrorContext = {
  /** Tenant id — propagates to audit `actor` + span attributes. */
  tenant?: string;
  /** What the error was acting on — audit `target`. */
  target?: string;
  /** Active OTel trace id, if you've already resolved it. */
  traceId?: string;
  /** Active OTel span id, if relevant. */
  spanId?: string;
  /** Session-replay id, if a recording is active — joins into @absolutejs/replay. */
  replayId?: string;
  /** Free-form structured fields. */
  tags?: Record<string, string>;
  /** Free-form arbitrary data. */
  extra?: Record<string, unknown>;
  /** Severity. Default `'error'`. */
  level?: "fatal" | "error" | "warning" | "info";
};

export type CapturedError = {
  /** Stable id grouping the same logical error across captures. */
  fingerprint: string;
  /** `Date.now()` when capture happened. */
  at: number;
  /** `error.name`. */
  name: string;
  /** `error.message`. */
  message: string;
  /** Stack trace, when available. */
  stack?: string;
  /** Context passed to `capture`. */
  context: ErrorContext;
  /** Release tag at capture time, when set on the tracker. */
  release?: string;
  /** Environment tag at capture time, when set on the tracker. */
  environment?: string;
};

// =============================================================================
// Typed failures — errors-as-values. Each sink boundary has its own tag, so a
// caller can `switch (f._tag)` exhaustively and react specifically (retry the
// store, page on audit loss, ignore a flaky custom onIssue, …).
// =============================================================================

/** A store adapter could not durably create the schema. */
export class IssueStoreSchemaError extends Data.TaggedError(
  "IssueStoreSchemaError",
)<{ op: string; cause: unknown }> {}

/** A store adapter query (read/write) failed. */
export class IssueStoreQueryError extends Data.TaggedError(
  "IssueStoreQueryError",
)<{ op: string; cause: unknown }> {}

/** A store adapter could not (de)serialize an event/issue payload. */
export class IssueStoreSerializationError extends Data.TaggedError(
  "IssueStoreSerializationError",
)<{ fingerprint: string; cause: unknown }> {}

/** Everything a store adapter is allowed to fail with. */
export type IssueStoreError =
  | IssueStoreSchemaError
  | IssueStoreQueryError
  | IssueStoreSerializationError;

/** The configured `fingerprint` function threw — capture fell back. */
export class FingerprintFailure extends Data.TaggedError("FingerprintFailure")<{
  cause: unknown;
}> {}

/** The audit sink (`audit.append`) threw. */
export class AuditSinkFailure extends Data.TaggedError("AuditSinkFailure")<{
  cause: unknown;
}> {}

/** The tracer (`startSpan` / `recordException`) threw. */
export class TracerFailure extends Data.TaggedError("TracerFailure")<{
  cause: unknown;
}> {}

/** The durable store rejected the upsert — wraps the typed `IssueStoreError`. */
export class StoreFailure extends Data.TaggedError("StoreFailure")<{
  cause: IssueStoreError;
}> {}

/** The `onIssue` alert callback threw. */
export class OnIssueFailure extends Data.TaggedError("OnIssueFailure")<{
  cause: unknown;
}> {}

/** Any per-sink failure collected into a `CaptureOutcome`. */
export type CaptureFailure =
  | FingerprintFailure
  | AuditSinkFailure
  | TracerFailure
  | StoreFailure
  | OnIssueFailure;

// =============================================================================
// Capture outcome
// =============================================================================

/** The fan-out sinks a capture multiplexes to. */
export type SinkName = "fingerprint" | "audit" | "tracer" | "store" | "onIssue";

/**
 * Per-sink delivery state. `'skipped'` (sink not configured) is distinct from
 * `'failed'` (configured, threw) on purpose — they demand different reactions.
 */
export type Delivery = "ok" | "failed" | "skipped";

/**
 * The value of a capture. Capture never fails (E = never); partial sink
 * failure is normal and is reported as data here.
 */
export type CaptureOutcome = {
  /** Stable grouping id (fallback `'0'.repeat(16)` if fingerprinting threw). */
  fingerprint: string;
  /** What each sink did. */
  delivered: Record<SinkName, Delivery>;
  /** The grouped issue, present iff the store delivered. */
  issue?: IssueUpsertResult;
  /** Typed per-sink failures. Empty ⇒ fully delivered. */
  failures: CaptureFailure[];
};

// =============================================================================
// Durable issue store — the persistent "Issues" surface (Sentry's product
// core). `@absolutejs/errors` owns capture + grouping; a store adapter (e.g.
// `@absolutejs/errors-postgres`) owns durability + query. Adapters are
// Effect-native: methods return `Effect<_, IssueStoreError>`.
// =============================================================================

/** Lifecycle state of a grouped issue. */
export type IssueState = "unresolved" | "resolved" | "ignored";

/** Severity, non-optional form (events/issues always resolve a level). */
export type IssueLevel = NonNullable<ErrorContext["level"]>;

/** A single stored occurrence — denormalized for the events timeline. */
export type StoredEvent = {
  fingerprint: string;
  /** Project/tenant scope. */
  project: string;
  /** Occurrence time (ms). */
  at: number;
  level: IssueLevel;
  name: string;
  message: string;
  stack?: string;
  release?: string;
  environment?: string;
  /** Joins straight into @absolutejs/telemetry traces. */
  traceId?: string;
  spanId?: string;
  /** Joins into @absolutejs/replay. */
  replayId?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

/** One grouped issue — a fingerprint plus its aggregated occurrence stats. */
export type IssueRecord = {
  fingerprint: string;
  project: string;
  environment?: string;
  /** Human title — `name: normalized-message`. See `issueTitle`. */
  title: string;
  /** Top user stack frame, when available. See `issueCulprit`. */
  culprit?: string;
  level: IssueLevel;
  state: IssueState;
  /** First-ever capture (ms). */
  firstSeen: number;
  /** Most recent capture (ms). */
  lastSeen: number;
  /** Total occurrences across all captures. */
  timesSeen: number;
  /** Release id at first capture. */
  firstRelease?: string;
  /** Release id at most recent capture. */
  lastRelease?: string;
  /** Assigned operator, when triaged. */
  assignee?: string;
};

/** Result of recording a capture against the store. */
export type IssueUpsertResult = {
  issue: IssueRecord;
  /** First time this fingerprint has ever been seen. */
  isNew: boolean;
  /** Was `resolved`, now seen again — drives "regression" alerts. */
  isRegression: boolean;
};

/** Filter for the dashboard issue list. */
export type IssueFilter = {
  project?: string;
  environment?: string;
  state?: IssueState;
  /** Substring match on title. */
  query?: string;
  /** Max rows. Default adapter-defined (e.g. 100). */
  limit?: number;
};

/**
 * A coalesced batch of occurrences of ONE `(project, fingerprint)` — the unit
 * the in-process ingest buffer flushes. A thundering herd of N identical errors
 * collapses into a single `recordCoalesced` instead of N `record` calls, so the
 * hot issue row is touched once (`times_seen += occurrences`) and only a capped
 * `samples` set of raw events is persisted to the timeline.
 */
export type CoalescedGroup = {
  /**
   * Representative event — drives title/culprit/release/environment. Its
   * `level` should already be the escalated (max-severity) level for the group.
   */
  representative: StoredEvent;
  /** Total occurrences in the window (>= 1). `times_seen` increments by this. */
  occurrences: number;
  /** Earliest occurrence time (ms) in the group. */
  firstSeen: number;
  /** Latest occurrence time (ms) in the group. */
  lastSeen: number;
  /** Sampled raw events to persist (capped; never empty — includes one rep). */
  samples: StoredEvent[];
};

/**
 * Durable issue store. `record` is the only required method — capture works
 * with a write-only store. Query/mutation methods are optional, so a minimal
 * ship-only adapter is valid; a dashboard-backing adapter implements them all.
 * Every method returns an `Effect` with a typed `IssueStoreError` channel.
 */
export type IssueStore = {
  /** Upsert the issue + append the event. */
  record: (
    event: StoredEvent,
  ) => Effect.Effect<IssueUpsertResult, IssueStoreError>;
  /**
   * Upsert a coalesced batch (one fingerprint, N occurrences) in a single
   * round-trip — the efficient path for the ingest buffer. Optional: the
   * buffer falls back to `record` per sample when an adapter omits it.
   */
  recordCoalesced?: (
    group: CoalescedGroup,
  ) => Effect.Effect<IssueUpsertResult, IssueStoreError>;
  listIssues?: (
    filter?: IssueFilter,
  ) => Effect.Effect<IssueRecord[], IssueStoreError>;
  getIssue?: (
    project: string,
    fingerprint: string,
  ) => Effect.Effect<Option.Option<IssueRecord>, IssueStoreError>;
  setState?: (
    project: string,
    fingerprint: string,
    state: IssueState,
    by?: string,
  ) => Effect.Effect<void, IssueStoreError>;
  assign?: (
    project: string,
    fingerprint: string,
    assignee: string | null,
  ) => Effect.Effect<void, IssueStoreError>;
  listEvents?: (
    project: string,
    fingerprint: string,
    limit?: number,
  ) => Effect.Effect<StoredEvent[], IssueStoreError>;
};

// =============================================================================
// Tracker options + surface
// =============================================================================

export type ErrorTrackerMetrics = {
  /** Successful `capture` calls. */
  captured: number;
  /** Total per-sink failures across all captures. */
  captureErrors: number;
  /** Per-fingerprint occurrence counts (capped at `maxFingerprints`). */
  byFingerprint: Record<string, number>;
};

export type ErrorTrackerOptions = {
  /** Optional audit writer. Pass `@absolutejs/audit`'s broker `append`. */
  audit?: ErrorAuditLike;
  /**
   * Optional tracer — used to call `startSpan` + `recordException` so the
   * error lands on the active trace. Pass any OTel-compatible tracer (e.g.
   * from `@absolutejs/telemetry`).
   */
  tracer?: ErrorTracerLike;
  /**
   * Build a stable fingerprint from `(name, message, stack)`. Default:
   * SHA-1-hex of `name + first-meaningful-stack-frame + normalized message`.
   * Inject a custom hasher for deterministic tests. If it throws, capture
   * falls back to a degenerate fingerprint and records a `FingerprintFailure`.
   */
  fingerprint?: (
    error: Error,
    context: ErrorContext,
  ) => string | Promise<string>;
  /** Tag every event with a release id (deploy version). */
  release?: string;
  /** Tag every event with an environment (`'production'`, etc.). */
  environment?: string;
  /** LRU cap on recent-errors buffer. Default 100. */
  maxRecent?: number;
  /**
   * LRU cap on `byFingerprint` map. Default 1000. Prevents an attacker who
   * can synthesize unique errors from blowing memory.
   */
  maxFingerprints?: number;
  /** Override `Date.now()` for tests. */
  clock?: () => number;
  /**
   * Durable issue store (e.g. `@absolutejs/errors-postgres`). When set, every
   * capture upserts a grouped issue + appends the event.
   */
  store?: IssueStore;
  /** Project/tenant scope written onto every issue + event. Default `'default'`. */
  project?: string;
  /**
   * Fired after a capture resolves to a NEW or REGRESSED issue (never on
   * routine repeats). The natural hook for alerting via `@absolutejs/dispatch`.
   */
  onIssue?: (result: IssueUpsertResult) => void | Promise<void>;
};

export type ErrorTracker = {
  /** Primary Effect API — `Effect<CaptureOutcome, never>`; never throws. */
  capture: (
    error: unknown,
    context?: ErrorContext,
  ) => Effect.Effect<CaptureOutcome>;
  /** Promise edge — runs `capture` for Promise-world consumers. */
  captureException: (
    error: unknown,
    context?: ErrorContext,
  ) => Promise<CaptureOutcome>;
  /** In-process LRU of recent captures, newest first. */
  recentErrors: () => ReadonlyArray<CapturedError>;
  /** Drop the in-process buffer. Counters survive. */
  clearRecent: () => void;
  /** Operator-shaped counters. */
  metrics: () => ErrorTrackerMetrics;
};

// =============================================================================
// Fingerprinting — shared with the ingest path (see ./fingerprint).
// =============================================================================

const defaultFingerprint = (
  error: Error,
  _context: ErrorContext,
): Promise<string> => {
  void _context;
  return computeFingerprint({
    message: error.message ?? "",
    name: error.name,
    ...(error.stack !== undefined ? { stack: error.stack } : {}),
  });
};

// =============================================================================
// Coerce arbitrary `unknown` into an Error
// =============================================================================

const toError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (typeof value === "object" && value !== null) {
    const obj = value as { message?: unknown; name?: unknown };
    const message =
      typeof obj.message === "string" ? obj.message : JSON.stringify(value);
    const wrapped = new Error(message);
    if (typeof obj.name === "string") wrapped.name = obj.name;
    return wrapped;
  }
  return new Error(String(value));
};

// =============================================================================
// createErrorTracker
// =============================================================================

const incrementCapped = (
  map: Record<string, number>,
  key: string,
  cap: number,
): void => {
  if (map[key] !== undefined) {
    map[key] += 1;
    return;
  }
  if (Object.keys(map).length >= cap) {
    // Drop one arbitrary entry to make room — fingerprint maps are
    // approximate by design; we cap to bound memory under attack.
    for (const k of Object.keys(map)) {
      delete map[k];
      break;
    }
  }
  map[key] = 1;
};

export const createErrorTracker = (
  options: ErrorTrackerOptions = {},
): ErrorTracker => {
  const fingerprintFn = options.fingerprint ?? defaultFingerprint;
  const clock = options.clock ?? Date.now;
  const project = options.project ?? "default";
  const maxRecent = options.maxRecent ?? 100;
  const maxFingerprints = options.maxFingerprints ?? 1000;
  const recent: CapturedError[] = [];
  const counters: ErrorTrackerMetrics = {
    byFingerprint: {},
    captureErrors: 0,
    captured: 0,
  };

  const buildAuditEvent = (
    event: CapturedError,
  ): Parameters<ErrorAuditLike["append"]>[0] => {
    const metadata: Record<string, unknown> = {
      environment: event.environment,
      fingerprint: event.fingerprint,
      level: event.context.level ?? "error",
      message: event.message,
      name: event.name,
      release: event.release,
    };
    if (event.context.traceId !== undefined) {
      metadata.traceId = event.context.traceId;
    }
    if (event.context.spanId !== undefined) {
      metadata.spanId = event.context.spanId;
    }
    if (event.context.replayId !== undefined) {
      metadata.replayId = event.context.replayId;
    }
    if (event.context.tags !== undefined) metadata.tags = event.context.tags;
    if (event.context.extra !== undefined) metadata.extra = event.context.extra;
    if (event.stack !== undefined) metadata.stack = event.stack;
    const auditEvent: Parameters<ErrorAuditLike["append"]>[0] = {
      kind: "errors.captured",
      metadata,
    };
    if (event.context.tenant !== undefined) {
      auditEvent.actor = event.context.tenant;
    }
    if (event.context.target !== undefined) {
      auditEvent.target = event.context.target;
    }
    return auditEvent;
  };

  const doTrace = (error: Error, context: ErrorContext): void => {
    const span = options.tracer?.startSpan?.("errors.captured");
    if (span === undefined) return;
    span.recordException?.(error);
    if (context.tenant !== undefined) {
      span.setAttribute?.("abs.tenant", context.tenant);
    }
    if (context.tags !== undefined) {
      for (const [key, value] of Object.entries(context.tags)) {
        span.setAttribute?.(`error.tag.${key}`, value);
      }
    }
    span.end?.();
  };

  const buildStored = (event: CapturedError): StoredEvent => {
    const stored: StoredEvent = {
      at: event.at,
      fingerprint: event.fingerprint,
      level: event.context.level ?? "error",
      message: event.message,
      name: event.name,
      project,
    };
    if (event.stack !== undefined) stored.stack = event.stack;
    if (event.release !== undefined) stored.release = event.release;
    if (event.environment !== undefined) stored.environment = event.environment;
    if (event.context.traceId !== undefined) {
      stored.traceId = event.context.traceId;
    }
    if (event.context.spanId !== undefined)
      stored.spanId = event.context.spanId;
    if (event.context.replayId !== undefined) {
      stored.replayId = event.context.replayId;
    }
    if (event.context.tags !== undefined) stored.tags = event.context.tags;
    if (event.context.extra !== undefined) stored.extra = event.context.extra;
    return stored;
  };

  const capture = (
    raw: unknown,
    context: ErrorContext = {},
  ): Effect.Effect<CaptureOutcome> =>
    Effect.gen(function* () {
      const error = toError(raw);
      const delivered: Record<SinkName, Delivery> = {
        audit: "skipped",
        fingerprint: "ok",
        onIssue: "skipped",
        store: "skipped",
        tracer: "skipped",
      };
      const failures: CaptureFailure[] = [];

      const note = (failure: CaptureFailure, sink: SinkName): void => {
        failures.push(failure);
        delivered[sink] = "failed";
        counters.captureErrors += 1;
      };

      // --- fingerprint (total: a failure falls back, never aborts) ---
      const fpResult = yield* Effect.either(
        Effect.tryPromise({
          catch: (cause) => new FingerprintFailure({ cause }),
          try: () => Promise.resolve(fingerprintFn(error, context)),
        }),
      );
      let fingerprint: string;
      if (Either.isRight(fpResult)) {
        fingerprint = fpResult.right;
      } else {
        fingerprint = FALLBACK_FINGERPRINT;
        note(fpResult.left, "fingerprint");
      }

      const event: CapturedError = {
        at: clock(),
        context,
        fingerprint,
        message: error.message,
        name: error.name,
      };
      if (error.stack !== undefined) event.stack = error.stack;
      if (options.release !== undefined) event.release = options.release;
      if (options.environment !== undefined) {
        event.environment = options.environment;
      }

      counters.captured += 1;
      incrementCapped(counters.byFingerprint, fingerprint, maxFingerprints);
      recent.unshift(event);
      while (recent.length > maxRecent) recent.pop();

      // --- tracer (sync boundary) ---
      if (options.tracer?.startSpan !== undefined) {
        const traced = yield* Effect.either(
          Effect.try({
            catch: (cause) => new TracerFailure({ cause }),
            try: () => doTrace(error, context),
          }),
        );
        if (Either.isRight(traced)) delivered.tracer = "ok";
        else note(traced.left, "tracer");
      }

      // --- audit (async/sync boundary) ---
      if (options.audit !== undefined) {
        const audited = yield* Effect.either(
          Effect.tryPromise({
            catch: (cause) => new AuditSinkFailure({ cause }),
            try: () =>
              Promise.resolve(options.audit!.append(buildAuditEvent(event))),
          }),
        );
        if (Either.isRight(audited)) delivered.audit = "ok";
        else note(audited.left, "audit");
      }

      // --- durable store (typed E channel) + onIssue alert ---
      let issue: IssueUpsertResult | undefined;
      if (options.store !== undefined) {
        const recorded = yield* Effect.either(
          options
            .store!.record(buildStored(event))
            .pipe(Effect.mapError((cause) => new StoreFailure({ cause }))),
        );
        if (Either.isLeft(recorded)) {
          note(recorded.left, "store");
        } else {
          delivered.store = "ok";
          issue = recorded.right;
          if (
            (issue.isNew || issue.isRegression) &&
            options.onIssue !== undefined
          ) {
            const alerted = yield* Effect.either(
              Effect.tryPromise({
                catch: (cause) => new OnIssueFailure({ cause }),
                try: () => Promise.resolve(options.onIssue!(issue!)),
              }),
            );
            if (Either.isRight(alerted)) delivered.onIssue = "ok";
            else note(alerted.left, "onIssue");
          }
        }
      }

      const outcome: CaptureOutcome = { delivered, failures, fingerprint };
      if (issue !== undefined) outcome.issue = issue;
      return outcome;
    });

  return {
    capture,
    captureException: (raw, context) =>
      Effect.runPromise(capture(raw, context)),
    clearRecent: () => {
      recent.length = 0;
    },
    metrics: () => ({
      byFingerprint: { ...counters.byFingerprint },
      captureErrors: counters.captureErrors,
      captured: counters.captured,
    }),
    recentErrors: () => [...recent],
  };
};

// =============================================================================
// In-memory issue store — zero-failure reference implementation. Use for dev /
// tests / single-process apps; swap in `@absolutejs/errors-postgres` for
// durability. The Postgres adapter mirrors these exact semantics (new vs.
// regression, severity escalation, first/last release tracking). All methods
// are `Effect.sync` — the memory store never fails (E = never, assignable to
// the interface's `IssueStoreError`).
// =============================================================================

export type MemoryIssueStoreOptions = {
  /** Max issues retained, evicting least-recently-seen. Default 10_000. */
  maxIssues?: number;
  /** Max events retained per issue, newest-first. Default 50. */
  maxEventsPerIssue?: number;
};

const SEVERITY_RANK: Record<IssueLevel, number> = {
  error: 2,
  fatal: 3,
  info: 0,
  warning: 1,
};

/** Higher-severity-wins between an issue's current level and a new event. */
const escalate = (current: IssueLevel, incoming: IssueLevel): IssueLevel =>
  SEVERITY_RANK[incoming] > SEVERITY_RANK[current] ? incoming : current;

const issueKey = (project: string, fingerprint: string): string =>
  `${project} ${fingerprint}`;

export const createMemoryIssueStore = (
  options: MemoryIssueStoreOptions = {},
): IssueStore => {
  const maxIssues = options.maxIssues ?? 10_000;
  const maxEventsPerIssue = options.maxEventsPerIssue ?? 50;
  const issues = new Map<string, IssueRecord>();
  const events = new Map<string, StoredEvent[]>();

  const evictIfNeeded = (): void => {
    if (issues.size <= maxIssues) return;
    let oldestKey: string | undefined;
    let oldestSeen = Infinity;
    for (const [key, issue] of issues) {
      if (issue.lastSeen < oldestSeen) {
        oldestSeen = issue.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      issues.delete(oldestKey);
      events.delete(oldestKey);
    }
  };

  // Shared upsert for both `record` (one event) and `recordCoalesced`
  // (N occurrences) — identical semantics, parameterized by occurrence count
  // and the sample set persisted to the timeline.
  const applyGroup = (group: CoalescedGroup): IssueUpsertResult => {
    const rep = group.representative;
    const key = issueKey(rep.project, rep.fingerprint);
    const existing = issues.get(key);

    let issue: IssueRecord;
    let isNew = false;
    let isRegression = false;

    if (existing === undefined) {
      isNew = true;
      issue = {
        fingerprint: rep.fingerprint,
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
        level: rep.level,
        project: rep.project,
        state: "unresolved",
        timesSeen: group.occurrences,
        title: issueTitle(rep.name, rep.message),
      };
      const culprit = issueCulprit(rep.stack);
      if (culprit !== "") issue.culprit = culprit;
      if (rep.environment !== undefined) issue.environment = rep.environment;
      if (rep.release !== undefined) {
        issue.firstRelease = rep.release;
        issue.lastRelease = rep.release;
      }
    } else {
      // A `resolved` issue seen again is a regression; `ignored` stays
      // muted. Only `resolved` flips back to `unresolved`.
      isRegression = existing.state === "resolved";
      issue = {
        ...existing,
        lastSeen: Math.max(existing.lastSeen, group.lastSeen),
        level: escalate(existing.level, rep.level),
        state: isRegression ? "unresolved" : existing.state,
        timesSeen: existing.timesSeen + group.occurrences,
      };
      if (rep.release !== undefined) issue.lastRelease = rep.release;
      if (existing.firstRelease === undefined && rep.release !== undefined) {
        issue.firstRelease = rep.release;
      }
    }

    issues.set(key, issue);

    const bucket = events.get(key) ?? [];
    for (const sample of group.samples) bucket.unshift(sample);
    while (bucket.length > maxEventsPerIssue) bucket.pop();
    events.set(key, bucket);

    evictIfNeeded();

    return { isNew, isRegression, issue: { ...issue } };
  };

  const record = (
    event: StoredEvent,
  ): Effect.Effect<IssueUpsertResult, IssueStoreError> =>
    Effect.sync(() =>
      applyGroup({
        firstSeen: event.at,
        lastSeen: event.at,
        occurrences: 1,
        representative: event,
        samples: [event],
      }),
    );

  const recordCoalesced = (
    group: CoalescedGroup,
  ): Effect.Effect<IssueUpsertResult, IssueStoreError> =>
    Effect.sync(() => applyGroup(group));

  const listIssues = (
    filter: IssueFilter = {},
  ): Effect.Effect<IssueRecord[], IssueStoreError> =>
    Effect.sync(() => {
      const limit = filter.limit ?? 100;
      const queryLower = filter.query?.toLowerCase();
      const matched = [...issues.values()].filter((issue) => {
        if (filter.project !== undefined && issue.project !== filter.project) {
          return false;
        }
        if (
          filter.environment !== undefined &&
          issue.environment !== filter.environment
        ) {
          return false;
        }
        if (filter.state !== undefined && issue.state !== filter.state) {
          return false;
        }
        if (
          queryLower !== undefined &&
          !issue.title.toLowerCase().includes(queryLower)
        ) {
          return false;
        }
        return true;
      });
      matched.sort((a, b) => b.lastSeen - a.lastSeen);
      return matched.slice(0, limit).map((issue) => ({ ...issue }));
    });

  const getIssue = (
    project: string,
    fingerprint: string,
  ): Effect.Effect<Option.Option<IssueRecord>, IssueStoreError> =>
    Effect.sync(() => {
      const issue = issues.get(issueKey(project, fingerprint));
      return issue === undefined ? Option.none() : Option.some({ ...issue });
    });

  const setState = (
    project: string,
    fingerprint: string,
    state: IssueState,
  ): Effect.Effect<void, IssueStoreError> =>
    Effect.sync(() => {
      const key = issueKey(project, fingerprint);
      const issue = issues.get(key);
      if (issue !== undefined) issues.set(key, { ...issue, state });
    });

  const assign = (
    project: string,
    fingerprint: string,
    assignee: string | null,
  ): Effect.Effect<void, IssueStoreError> =>
    Effect.sync(() => {
      const key = issueKey(project, fingerprint);
      const issue = issues.get(key);
      if (issue === undefined) return;
      const next = { ...issue };
      if (assignee === null) delete next.assignee;
      else next.assignee = assignee;
      issues.set(key, next);
    });

  const listEvents = (
    project: string,
    fingerprint: string,
    limit = maxEventsPerIssue,
  ): Effect.Effect<StoredEvent[], IssueStoreError> =>
    Effect.sync(() => {
      const bucket = events.get(issueKey(project, fingerprint)) ?? [];
      return bucket.slice(0, limit).map((event) => ({ ...event }));
    });

  return {
    assign,
    getIssue,
    listEvents,
    listIssues,
    record,
    recordCoalesced,
    setState,
  };
};
