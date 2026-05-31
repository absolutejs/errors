# `@absolutejs/errors`

> Sentry-equivalent exception capture for the AbsoluteJS substrate.

`createErrorTracker` is a thin decorator over
[`@absolutejs/audit`](https://www.npmjs.com/package/@absolutejs/audit) +
[`@absolutejs/telemetry`](https://www.npmjs.com/package/@absolutejs/telemetry).
`captureException(error, context?)` does five things in one shot:

1. Computes a stable **fingerprint** so the same error grouped from
   different call sites collapses into one "issue."
2. Records the exception on the **active OTel span**, when a tracer
   is supplied.
3. Emits an **audit event** (`kind: 'errors.captured'`) with the
   fingerprint + structured context.
4. Pushes the event onto an in-process **recent-errors LRU buffer**
   so an admin endpoint or sandboxed REPL can inspect without going
   through audit storage.
5. Bumps per-fingerprint **metrics counters** for
   `@absolutejs/metrics`.

The package doesn't replace audit or telemetry — it composes onto
them via narrow interfaces. No SDK lock-in, no third-party vendor.

```ts
import { createErrorTracker } from '@absolutejs/errors';
import { broker } from '@absolutejs/audit/pg'; // your audit broker
import { tracerOrNoop } from '@absolutejs/telemetry';

const errors = createErrorTracker({
  audit: broker,
  tracer: tracerOrNoop(otelProvider, 'app'),
  release: process.env.RELEASE,
  environment: 'production'
});

try {
  await chargeCustomer(orderId);
} catch (e) {
  const id = await errors.captureException(e, {
    tenant: tenantId,
    target: `order_${orderId}`,
    tags: { component: 'billing' }
  });
  return new Response(`error ${id}`, { status: 500 });
}
```

## API

```ts
createErrorTracker(options?: {
  audit?: { append: (event) => Promise<void> | void };
  tracer?: { startSpan?: (name: string) => Span };
  release?: string;
  environment?: string;
  fingerprint?: (error: Error, context: ErrorContext) => string | Promise<string>;
  maxRecent?: number;          // default 100
  maxFingerprints?: number;    // default 1000
  clock?: () => number;
  onError?: (e: unknown) => void;
}) => ErrorTracker
```

```ts
captureException(error: unknown, context?: ErrorContext) => Promise<fingerprint>
recentErrors() => ReadonlyArray<CapturedError>
clearRecent() => void
metrics() => { captured, captureErrors, byFingerprint }
```

`ErrorContext` carries the standard Sentry-style triage envelope:
`tenant`, `target`, `traceId`, `spanId`, `tags`, `extra`, `level`.

## Fingerprinting

The default fingerprint is a 16-hex-char prefix of SHA-1 over

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
