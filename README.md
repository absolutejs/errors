# `@absolutejs/errors`

> Effect-native, Sentry-equivalent exception capture for the AbsoluteJS
> substrate.

`createErrorTracker` is a thin decorator over
[`@absolutejs/audit`](https://www.npmjs.com/package/@absolutejs/audit),
[`@absolutejs/telemetry`](https://www.npmjs.com/package/@absolutejs/telemetry),
and a durable issue store. `capture(error, context?)` is an
`Effect<CaptureOutcome, never>` — **capturing an error can never itself
fail** — that does six things in one shot:

1. Computes a stable **fingerprint** so the same error from different
   call sites collapses into one "issue."
2. Records the exception on the **active OTel span**, when a tracer is
   supplied.
3. Emits an **audit event** (`kind: 'errors.captured'`).
4. Upserts a grouped **issue** + appends the event to a durable
   `store`, and fires `onIssue` on a new/regressed issue.
5. Pushes onto an in-process **recent-errors LRU buffer**.
6. Bumps per-fingerprint **metrics counters**.

Nested `Error.cause` chains are appended to the stored stack and preserved as
structured `extra.errorCauses` entries, including driver fields such as database
error codes, severity, detail, and routine. The outer error continues to drive
fingerprinting so causes add diagnosis without collapsing distinct operations.

Browser ingest recomputes its canonical fingerprint after the optional
`prepare()` step. Source-mapped copies of the same failure therefore group
together across releases even when their raw content-hashed chunk names differ.
The ingest boundary also redacts credential-bearing fields, bearer/JWT values,
breadcrumb text, and URL query/hash values after schema validation but before
fingerprinting or buffering. This defense-in-depth pass is enabled by default;
`createIngestEndpoint({ redact: false })` is available only for hosts that
replace it with an equivalent trusted-boundary policy, while a custom
`redact(event)` function can extend the built-in policy.

### Errors-as-values

Every fan-out (audit / tracer / store / `onIssue`) is a trust boundary.
Each is wrapped so its failure becomes a **typed, tagged value**
(`Data.TaggedError`) collected into the outcome — never swallowed into an
anonymous counter or an `onError(unknown)`. The outcome reports a per-sink
delivery state (`'ok' | 'failed' | 'skipped'`), so a caller can react
specifically — retry the store, page on audit loss, ignore a flaky
`onIssue` — via an exhaustive `switch (failure._tag)`.

```ts
import { Effect } from "effect";
import { status } from "elysia";
import { createErrorTracker, createMemoryIssueStore } from "@absolutejs/errors";
import { tracerOrNoop } from "@absolutejs/telemetry";

const errors = createErrorTracker({
  audit: broker, // @absolutejs/audit
  tracer: tracerOrNoop(otelProvider, "app"),
  store: createMemoryIssueStore(), // or @absolutejs/errors-postgres
  project: "acme",
  release: process.env.RELEASE,
  environment: "production",
  onIssue: (r) => alert(r.issue), // only on new / regression
});

// Effect API (primary):
const outcome = await Effect.runPromise(
  errors.capture(e, {
    tenant,
    target: `order_${orderId}`,
    tags: { component: "billing" },
  }),
);

// Promise edge (for Promise-world consumers) — identical outcome:
const out = await errors.captureException(e);

if (out.failures.length > 0) {
  for (const f of out.failures) {
    switch (f._tag) {
      case "StoreFailure":
        retryLater(f.cause);
        break; // f.cause: IssueStoreError
      case "AuditSinkFailure":
        page("audit lost", f.cause);
        break;
      case "TracerFailure":
      case "OnIssueFailure":
      case "FingerprintFailure":
        /* tolerate */ break;
    }
  }
}
return status(
  "Internal Server Error",
  `Request failed. Reference: ${out.fingerprint}`,
);
```

## API

```ts
createErrorTracker(options?: {
  audit?: { append: (event) => Promise<void> | void };
  tracer?: { startSpan?: (name) => Span };
  store?: IssueStore;          // durable "Issues" surface
  project?: string;            // default 'default'
  onIssue?: (r: IssueUpsertResult) => void | Promise<void>;  // new/regression only
  release?: string;
  environment?: string;
  fingerprint?: (error: Error, context: ErrorContext) => string | Promise<string>;
  maxRecent?: number;          // default 100
  maxFingerprints?: number;    // default 1000
  clock?: () => number;
}) => ErrorTracker
```

```ts
capture(error, context?)          => Effect<CaptureOutcome, never>   // primary
captureException(error, context?) => Promise<CaptureOutcome>         // Promise edge
recentErrors()                    => ReadonlyArray<CapturedError>
clearRecent()                     => void
metrics()                         => { captured, captureErrors, byFingerprint }
store?                            => IssueStore

type CaptureOutcome = {
  fingerprint: string;
  delivered: Record<'fingerprint'|'audit'|'tracer'|'store'|'onIssue', 'ok'|'failed'|'skipped'>;
  issue?: IssueUpsertResult;          // present iff the store delivered
  failures: CaptureFailure[];         // typed, tagged; empty ⇒ fully delivered
};
```

`ErrorContext` carries the standard Sentry-style triage envelope:
`tenant`, `target`, `traceId`, `spanId`, `replayId`, `tags`, `extra`,
`level`, and an optional semantic `groupingKey`. Use a grouping key for
synthetic or integration failures whose message or source frame may change
between releases:

```ts
await errors.captureException(providerError, {
  groupingKey: "google-ads-tag-load",
  tags: { provider: "google" },
});
```

The key is validated and hashed at the trusted errors boundary. Clients never
choose the stored fingerprint directly, and project scoping still isolates
otherwise-identical keys.

## Elysia server integration

`@absolutejs/errors/elysia` provides one server plugin with separate settings
for the two error paths:

```ts
import { createErrorTracker, createMemoryIssueStore } from "@absolutejs/errors";
import { errorsPlugin, handledError } from "@absolutejs/errors/elysia";
import { Elysia, status } from "elysia";

const tracker = createErrorTracker({
  store: createMemoryIssueStore(), // use the Postgres adapter in production
});

const app = new Elysia()
  .use(
    errorsPlugin({
      tracker,
      server: {
        context: ({ request }) => ({
          tenant: request.headers.get("x-user-id") ?? undefined,
        }),
      },
      ingest: {
        path: "/ingest",
        reporting: {
          path: "/ingest/reports",
          project: "web",
          environment: "production",
          release: process.env.RELEASE_SHA,
        },
        // authorize, limits, buffer, symbolication, and drain settings
      },
    }),
  )
  .get("/report", async () => {
    try {
      return await buildReport();
    } catch (error) {
      return handledError(
        status(500, { message: "Unable to build the report." }),
        error,
      );
    }
  });
```

`server` captures thrown, handled, and unexplained returned 5xx responses.
Set `captureReturned5xx` to a predicate when an intentional control-plane
response such as readiness `503` should remain observable through health
monitoring without becoming an exception issue. The predicate receives the
request context, response type, and status; thrown and explicitly handled
exceptions are unaffected.
It is enabled by default and can be disabled with `server: false`. `ingest`
mounts the browser-event endpoint and is opt-in; pass `{}` to use the tracker's
store and defaults, or `false`/omit it to expose no route.

`ingest.reporting` mounts a browser Reporting API receiver and converts crash,
deprecation, intervention, and policy deliveries into the same validated issue
pipeline. Send the response header
`Reporting-Endpoints: default="/ingest/reports"` on documents to enable browser
delivery. Crash reports cannot be collected with `ReportingObserver`: the page
JavaScript is no longer running after a browser-process crash.

This subpath is server-only and contains the Effect-backed tracker/ingest
runtime. Browser code should use `@absolutejs/beacon` (or
`@absolutejs/observability`) and never import `@absolutejs/errors/elysia`.
Forwarding-only servers can omit `tracker` and provide `server.capture`
directly; this is still the same `errorsPlugin`.

## Durable issues (the "Issues" surface)

The in-process buffer is for triage; for a persistent, queryable
**Issues** product (first-seen / last-seen / occurrence count / state /
assignee / regression detection) pass a `store`:

```ts
import { createErrorTracker, createMemoryIssueStore } from "@absolutejs/errors";
// or, for durability:
// import { createPostgresIssueStore } from '@absolutejs/errors-postgres';

const errors = createErrorTracker({
  project: "acme",
  release: process.env.RELEASE,
  store: createMemoryIssueStore(), // swap for the Postgres adapter
  onIssue: (r) => {
    // fires ONLY on new / regression
    if (r.isNew || r.isRegression) alert(r.issue); // → @absolutejs/dispatch
  },
});
```

Every capture upserts a grouped issue (keyed by `(project, fingerprint)`)
and appends the event. `onIssue` fires only on the transitions worth
paging someone for — a **new** issue or a **regression** (a `resolved`
issue seen again, which flips back to `unresolved`). A `resolved` issue's
severity escalates but never de-escalates; `ignored` issues stay muted.

Store writes are best-effort: a store outage surfaces as a typed
`StoreFailure` in `outcome.failures` (wrapping the adapter's
`IssueStoreError`), increments `captureErrors`, and never breaks capture.

Adapters are **Effect-native** — every method returns an `Effect` with a
typed `IssueStoreError` channel (`IssueStoreSchemaError` /
`IssueStoreQueryError` / `IssueStoreSerializationError`):

```ts
type IssueStore = {
  record: (event: StoredEvent) => Effect<IssueUpsertResult, IssueStoreError>;  // required
  listIssues?: (filter?) => Effect<IssueRecord[], IssueStoreError>;            // dashboard
  getIssue?:  (project, fingerprint) => Effect<Option<IssueRecord>, IssueStoreError>;
  setState?:  (project, fingerprint, 'unresolved'|'resolved'|'ignored') => Effect<void, IssueStoreError>;
  assign?:    (project, fingerprint, assignee | null) => Effect<void, IssueStoreError>;
  listEvents?:(project, fingerprint, limit?) => Effect<StoredEvent[], IssueStoreError>;
};
```

`createMemoryIssueStore()` is the zero-failure reference implementation
(use for dev / tests / single-process); `@absolutejs/errors-postgres`
is the durable adapter — both honor identical semantics.

`StoredEvent` carries `traceId` / `spanId` (→ `@absolutejs/telemetry`)
and `replayId` (→ `@absolutejs/replay`) so the dashboard can cross-link
an issue to its exact trace and DOM replay. `issueTitle()` / `issueCulprit()`
are exported so store adapters derive the issue row without reaching into
internals.

`handoffErrorContext(summary)` links an Issue to an
`@absolutejs/handoff` summary through bounded tags and a privacy-safe
projection. It excludes the latest evidence payload, messages, references, and
external ids.

## Fingerprinting

Without a `groupingKey`, the default fingerprint is a 16-hex-char prefix of SHA-1 over

```
error.name | normalized(message) | first-user-stack-frame
```

`normalized()` strips digits and quoted string literals so
`user 'u_42' not found` and `user 'u_99' not found` group together.
Inject a custom `fingerprint` function for deterministic tests or
domain-specific grouping rules.

## Memory bounds

- `maxRecent` (default **100**) caps the in-process recent buffer.
- `maxFingerprints` (default **1000**) caps the `byFingerprint`
  counter map so an attacker who can synthesize unique errors can't
  blow process memory. Beyond the cap, older entries are evicted
  arbitrarily — the counters are approximate-by-design.

## License

BSL-1.1 with a named carveout against hosted error-tracking SaaS
(Sentry, Bugsnag, Rollbar, Honeybadger, Airbrake, Datadog Error
Tracking). See `LICENSE`. Change date: **2030-05-31** → Apache 2.0.
