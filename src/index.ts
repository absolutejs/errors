/**
 * @absolutejs/errors — Sentry-equivalent exception capture for the
 * AbsoluteJS substrate.
 *
 * `createErrorTracker({ audit?, tracer?, … })` returns a tracker
 * whose `captureException(error, context?)` does five things:
 *
 *   1. Computes a stable **fingerprint** so the same error caught in
 *      different places groups into one bucket (Sentry's "issue").
 *   2. Records the exception on the **active OTel span** via the
 *      passed tracer, if one is supplied.
 *   3. Emits an **audit event** (`kind: 'errors.captured'`) with the
 *      fingerprint + context, so the audit log carries the full
 *      forensic trail.
 *   4. Pushes the event onto an **in-process LRU buffer** so a
 *      sandboxed REPL / admin endpoint can `recentErrors()` for
 *      triage without going through audit.
 *   5. Bumps **metrics** counters (`captured`, `captureErrors`,
 *      `byFingerprint`) for `@absolutejs/metrics`.
 *
 * The package is a **decorator**, not a replacement: it never
 * replaces audit / telemetry, it composes onto them via narrow
 * interfaces. No vendor lock-in.
 */

// =============================================================================
// Narrow interfaces — audit + tracer satisfied by @absolutejs/audit + telemetry
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
// Public shape
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
	/** Free-form structured fields. */
	tags?: Record<string, string>;
	/** Free-form arbitrary data. */
	extra?: Record<string, unknown>;
	/** Severity. Default `'error'`. */
	level?: 'fatal' | 'error' | 'warning' | 'info';
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
	/** Context passed to `captureException`. */
	context: ErrorContext;
	/** Release tag at capture time, when set on the tracker. */
	release?: string;
	/** Environment tag at capture time, when set on the tracker. */
	environment?: string;
};

export type ErrorTrackerMetrics = {
	/** Successful `captureException` calls. */
	captured: number;
	/** `captureException` calls where audit or tracer threw. */
	captureErrors: number;
	/** Per-fingerprint occurrence counts (capped at `maxFingerprints`). */
	byFingerprint: Record<string, number>;
};

export type ErrorTrackerOptions = {
	/** Optional audit writer. Pass `@absolutejs/audit`'s broker `append`. */
	audit?: ErrorAuditLike;
	/**
	 * Optional tracer — used to call `startSpan` + `recordException` so
	 * the error lands on the active trace. Pass any OTel-compatible
	 * tracer (e.g. from `@absolutejs/telemetry`).
	 */
	tracer?: ErrorTracerLike;
	/**
	 * Build a stable fingerprint from `(name, message, stack)`. Default:
	 * SHA-1-hex of `name + first-meaningful-stack-frame + normalized
	 * message`. Inject a custom hasher for deterministic tests.
	 */
	fingerprint?: (error: Error, context: ErrorContext) => string | Promise<string>;
	/** Tag every event with a release id (deploy version). */
	release?: string;
	/** Tag every event with an environment (`'production'`, etc.). */
	environment?: string;
	/** LRU cap on recent-errors buffer. Default 100. */
	maxRecent?: number;
	/**
	 * LRU cap on `byFingerprint` map. Default 1000. Prevents an attacker
	 * who can synthesize unique errors from blowing memory.
	 */
	maxFingerprints?: number;
	/** Override `Date.now()` for tests. */
	clock?: () => number;
	/** Hook for unrecoverable internal failures (audit threw, etc.). */
	onError?: (error: unknown) => void;
};

export type ErrorTracker = {
	/**
	 * Capture an exception. Returns the resolved fingerprint so the
	 * caller can include it in HTTP error responses, dashboards, etc.
	 */
	captureException: (
		error: unknown,
		context?: ErrorContext
	) => Promise<string>;
	/**
	 * In-process LRU of recent captures. Newest first. Inspect from an
	 * admin endpoint or sandboxed REPL.
	 */
	recentErrors: () => ReadonlyArray<CapturedError>;
	/** Drop the in-process buffer. Counters survive. */
	clearRecent: () => void;
	/** Operator-shaped counters. */
	metrics: () => ErrorTrackerMetrics;
};

// =============================================================================
// Fingerprinting — stable hash from (name, message-pattern, top-frame)
// =============================================================================

const stripDigits = (s: string): string => s.replace(/\d+/g, '0');
const stripQuoted = (s: string): string => s.replace(/'[^']*'/g, "'?'").replace(/"[^"]*"/g, '"?"');

/** First "user" stack frame — skip the `Error:` header line. */
const firstStackFrame = (stack: string | undefined): string => {
	if (stack === undefined) return '';
	const lines = stack.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('at ')) return trimmed;
	}
	return '';
};

const normalizeMessage = (message: string): string =>
	stripQuoted(stripDigits(message)).slice(0, 200);

const defaultFingerprint = async (
	error: Error,
	_context: ErrorContext
): Promise<string> => {
	void _context;
	const seed = [
		error.name,
		normalizeMessage(error.message ?? ''),
		stripDigits(firstStackFrame(error.stack))
	].join('|');
	const hash = await crypto.subtle.digest(
		'SHA-1',
		new TextEncoder().encode(seed)
	);
	const bytes = new Uint8Array(hash);
	let hex = '';
	for (const b of bytes) hex += b.toString(16).padStart(2, '0');
	return hex.slice(0, 16); // 64 bits — plenty for grouping
};

// =============================================================================
// Coerce arbitrary `unknown` errors into an Error
// =============================================================================

const toError = (value: unknown): Error => {
	if (value instanceof Error) return value;
	if (typeof value === 'string') return new Error(value);
	if (typeof value === 'object' && value !== null) {
		const obj = value as { message?: unknown; name?: unknown };
		const message =
			typeof obj.message === 'string' ? obj.message : JSON.stringify(value);
		const wrapped = new Error(message);
		if (typeof obj.name === 'string') wrapped.name = obj.name;
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
	cap: number
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
	options: ErrorTrackerOptions = {}
): ErrorTracker => {
	const fingerprintFn = options.fingerprint ?? defaultFingerprint;
	const clock = options.clock ?? Date.now;
	const maxRecent = options.maxRecent ?? 100;
	const maxFingerprints = options.maxFingerprints ?? 1000;
	const onError = options.onError ?? ((e) => console.warn('[errors]', e));
	const recent: CapturedError[] = [];
	const counters: ErrorTrackerMetrics = {
		byFingerprint: {},
		captureErrors: 0,
		captured: 0
	};

	const tryAudit = async (event: CapturedError): Promise<void> => {
		if (options.audit === undefined) return;
		try {
			const metadata: Record<string, unknown> = {
				environment: event.environment,
				fingerprint: event.fingerprint,
				level: event.context.level ?? 'error',
				message: event.message,
				name: event.name,
				release: event.release
			};
			if (event.context.traceId !== undefined) {
				metadata.traceId = event.context.traceId;
			}
			if (event.context.spanId !== undefined) {
				metadata.spanId = event.context.spanId;
			}
			if (event.context.tags !== undefined) metadata.tags = event.context.tags;
			if (event.context.extra !== undefined) metadata.extra = event.context.extra;
			if (event.stack !== undefined) metadata.stack = event.stack;
			const auditEvent: {
				kind: string;
				actor?: string;
				target?: string;
				metadata?: Record<string, unknown>;
			} = {
				kind: 'errors.captured',
				metadata
			};
			if (event.context.tenant !== undefined) {
				auditEvent.actor = event.context.tenant;
			}
			if (event.context.target !== undefined) {
				auditEvent.target = event.context.target;
			}
			await options.audit.append(auditEvent);
		} catch (auditFailure) {
			counters.captureErrors += 1;
			onError(auditFailure);
		}
	};

	const tryTrace = (error: Error, context: ErrorContext): void => {
		if (options.tracer?.startSpan === undefined) return;
		try {
			const span = options.tracer.startSpan('errors.captured');
			span.recordException?.(error);
			if (context.tenant !== undefined) {
				span.setAttribute?.('abs.tenant', context.tenant);
			}
			if (context.tags !== undefined) {
				for (const [key, value] of Object.entries(context.tags)) {
					span.setAttribute?.(`error.tag.${key}`, value);
				}
			}
			span.end?.();
		} catch (traceFailure) {
			counters.captureErrors += 1;
			onError(traceFailure);
		}
	};

	const captureException = async (
		raw: unknown,
		context: ErrorContext = {}
	): Promise<string> => {
		const error = toError(raw);
		const fingerprint = await fingerprintFn(error, context);
		const event: CapturedError = {
			at: clock(),
			context,
			fingerprint,
			message: error.message,
			name: error.name
		};
		if (error.stack !== undefined) event.stack = error.stack;
		if (options.release !== undefined) event.release = options.release;
		if (options.environment !== undefined) event.environment = options.environment;

		counters.captured += 1;
		incrementCapped(counters.byFingerprint, fingerprint, maxFingerprints);

		recent.unshift(event);
		while (recent.length > maxRecent) recent.pop();

		tryTrace(error, context);
		await tryAudit(event);

		return fingerprint;
	};

	return {
		captureException,
		clearRecent: () => {
			recent.length = 0;
		},
		metrics: () => ({
			byFingerprint: { ...counters.byFingerprint },
			captureErrors: counters.captureErrors,
			captured: counters.captured
		}),
		recentErrors: () => [...recent]
	};
};
