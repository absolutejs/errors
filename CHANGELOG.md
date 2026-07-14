# @absolutejs/errors changelog

## 0.3.2 — 2026-07-14

- `ingestPlugin()` now registers an Elysia `onStop` hook that stops its
  background drainer and performs the documented final buffer flush.
- Custom Elysia-like factories without an `onStop` surface remain supported.
- No caller API changes.

## 0.1.0 — 2026-05-31

Initial release. Closes the second half of G12 from the second-pass
PaaS audit — the substrate now has a first-party Sentry-equivalent
exception-capture surface.

### Added

- **`createErrorTracker({ audit?, tracer?, release?, environment?, fingerprint?, maxRecent?, maxFingerprints?, clock?, onError? })`**
  — decorator over `@absolutejs/audit` + `@absolutejs/telemetry`.
  Composes; doesn't replace.
- **`captureException(error, context?)`** — coerces non-Error inputs;
  computes fingerprint; records exception on the active OTel span
  (when a tracer is supplied); emits an `errors.captured` audit
  event; pushes onto an in-process LRU buffer; bumps per-fingerprint
  metrics. Returns the fingerprint id for inclusion in HTTP error
  responses.
- **Stable fingerprinting** — default = 16-hex prefix of SHA-1 over
  `(error.name | normalized-message | first-user-stack-frame)`.
  Message normalization strips digits + quoted string literals so
  `user 'u_42' not found` and `user 'u_99' not found` group as one
  issue. Injectable per `fingerprint` option.
- **Bounded memory** — `maxRecent` (default 100) caps the recent
  buffer; `maxFingerprints` (default 1000) caps the per-fingerprint
  counter map so an attacker forging unique errors can't blow
  process memory.
- **Per-sink failure isolation** — audit or tracer throwing bumps
  the `captureErrors` counter and fires `onError`; the capture call
  itself still returns the fingerprint to the caller.
- **`recentErrors()`** — admin / sandboxed-REPL inspection without
  going through audit storage.
- **`metrics()`** — `captured`, `captureErrors`, `byFingerprint` for
  the `@absolutejs/metrics` collector.

### Tests

23 covering: fingerprint stability + uniqueness; non-Error coercion;
digit + quoted-literal normalization; custom fingerprint injection;
audit metadata propagation (release, environment, traceId, spanId,
tags, extra); audit failure → captureErrors + onError; tracer
recordException + tag → attribute propagation; tracer failure
isolation; tracer-without-startSpan no-op; recent buffer newest-
first + LRU cap; clearRecent keeps counters; `byFingerprint`
counts + cap; clock override; audit + tracer composition.

### License

BSL-1.1 with named carveout against hosted error-tracking SaaS
(Sentry, Bugsnag, Rollbar, Honeybadger, Airbrake, Datadog Error
Tracking, New Relic Errors Inbox, etc.). Change date: 2030-05-31
(Apache 2.0).
