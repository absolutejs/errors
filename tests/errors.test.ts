/**
 * Tests for @absolutejs/errors.
 */
import { describe, expect, test } from 'bun:test';
import {
	createErrorTracker,
	type ErrorAuditLike,
	type ErrorTracerLike
} from '../src/index';

// =============================================================================
// Mocks
// =============================================================================

type AuditRecord = {
	kind: string;
	actor?: string;
	target?: string;
	metadata?: Record<string, unknown>;
};

const makeAudit = (): {
	audit: ErrorAuditLike;
	events: AuditRecord[];
} => {
	const events: AuditRecord[] = [];
	return {
		audit: {
			append: async (e) => {
				events.push(e);
			}
		},
		events
	};
};

const makeTracer = (): {
	tracer: ErrorTracerLike;
	spans: Array<{ name: string; attributes: Record<string, unknown>; exception?: unknown }>;
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
					}
				};
			}
		}
	};
};

// =============================================================================
// captureException — basic shape
// =============================================================================

describe('captureException — basics', () => {
	test('returns a stable fingerprint string', async () => {
		const tracker = createErrorTracker();
		const fp = await tracker.captureException(new Error('something broke'));
		expect(typeof fp).toBe('string');
		expect(fp.length).toBeGreaterThan(0);
	});

	test('same error → same fingerprint across captures', async () => {
		const tracker = createErrorTracker();
		const makeErr = () => {
			const e = new Error('repeatable');
			e.stack = 'Error: repeatable\n    at f (file.ts:10:5)';
			return e;
		};
		const a = await tracker.captureException(makeErr());
		const b = await tracker.captureException(makeErr());
		expect(a).toBe(b);
	});

	test('different errors → different fingerprints', async () => {
		const tracker = createErrorTracker();
		const a = await tracker.captureException(new TypeError('a is undefined'));
		const b = await tracker.captureException(
			new RangeError('out of bounds')
		);
		expect(a).not.toBe(b);
	});

	test('coerces non-Error inputs', async () => {
		const tracker = createErrorTracker();
		const fp1 = await tracker.captureException('a string error');
		const fp2 = await tracker.captureException({ message: 'an object' });
		const fp3 = await tracker.captureException(42);
		expect([fp1, fp2, fp3].every((f) => typeof f === 'string')).toBe(true);
		expect(tracker.metrics().captured).toBe(3);
	});

	test('digits + quoted strings normalized out of the message for fingerprinting', async () => {
		const tracker = createErrorTracker();
		const a = await tracker.captureException(
			new Error("user 'u_42' not found")
		);
		const b = await tracker.captureException(
			new Error("user 'u_99' not found")
		);
		expect(a).toBe(b);
	});

	test('custom fingerprint function is respected', async () => {
		const tracker = createErrorTracker({
			fingerprint: () => 'always-this'
		});
		const fp1 = await tracker.captureException(new Error('a'));
		const fp2 = await tracker.captureException(new Error('b'));
		expect(fp1).toBe('always-this');
		expect(fp2).toBe('always-this');
	});
});

// =============================================================================
// Audit integration
// =============================================================================

describe('audit integration', () => {
	test('emits errors.captured with fingerprint + metadata', async () => {
		const { audit, events } = makeAudit();
		const tracker = createErrorTracker({ audit });
		await tracker.captureException(new Error('boom'), {
			extra: { route: '/api/x' },
			tags: { component: 'http' },
			target: 'order_42',
			tenant: 'acme'
		});
		expect(events).toHaveLength(1);
		const event = events[0]!;
		expect(event.kind).toBe('errors.captured');
		expect(event.actor).toBe('acme');
		expect(event.target).toBe('order_42');
		expect(event.metadata?.name).toBe('Error');
		expect(event.metadata?.message).toBe('boom');
		expect(event.metadata?.tags).toEqual({ component: 'http' });
		expect(event.metadata?.extra).toEqual({ route: '/api/x' });
		expect(typeof event.metadata?.fingerprint).toBe('string');
	});

	test('release + environment tags propagate to metadata', async () => {
		const { audit, events } = makeAudit();
		const tracker = createErrorTracker({
			audit,
			environment: 'production',
			release: 'v1.2.3'
		});
		await tracker.captureException(new Error('boom'));
		expect(events[0]?.metadata?.release).toBe('v1.2.3');
		expect(events[0]?.metadata?.environment).toBe('production');
	});

	test('traceId + spanId propagate when context carries them', async () => {
		const { audit, events } = makeAudit();
		const tracker = createErrorTracker({ audit });
		await tracker.captureException(new Error('boom'), {
			spanId: 'span-x',
			traceId: 'trace-abc'
		});
		expect(events[0]?.metadata?.traceId).toBe('trace-abc');
		expect(events[0]?.metadata?.spanId).toBe('span-x');
	});

	test('audit throwing increments captureErrors + fires onError', async () => {
		const errors: unknown[] = [];
		const tracker = createErrorTracker({
			audit: {
				append: () => {
					throw new Error('audit down');
				}
			},
			onError: (e) => errors.push(e)
		});
		await tracker.captureException(new Error('user error'));
		expect(tracker.metrics().captureErrors).toBe(1);
		expect((errors[0] as Error).message).toBe('audit down');
	});
});

// =============================================================================
// Tracer integration
// =============================================================================

describe('tracer integration', () => {
	test('records the exception on a fresh span', async () => {
		const { tracer, spans } = makeTracer();
		const tracker = createErrorTracker({ tracer });
		const err = new Error('boom');
		await tracker.captureException(err, { tenant: 'acme' });
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('errors.captured');
		expect(spans[0]?.exception).toBe(err);
		expect(spans[0]?.attributes['abs.tenant']).toBe('acme');
	});

	test('tags propagate to span attributes', async () => {
		const { tracer, spans } = makeTracer();
		const tracker = createErrorTracker({ tracer });
		await tracker.captureException(new Error('x'), {
			tags: { component: 'http', method: 'GET' }
		});
		expect(spans[0]?.attributes['error.tag.component']).toBe('http');
		expect(spans[0]?.attributes['error.tag.method']).toBe('GET');
	});

	test('tracer throwing increments captureErrors + fires onError', async () => {
		const errors: unknown[] = [];
		const tracker = createErrorTracker({
			onError: (e) => errors.push(e),
			tracer: {
				startSpan: () => {
					throw new Error('tracer down');
				}
			}
		});
		await tracker.captureException(new Error('user error'));
		expect(tracker.metrics().captureErrors).toBe(1);
		expect((errors[0] as Error).message).toBe('tracer down');
	});

	test('tracer.startSpan undefined is fine (just no-op trace path)', async () => {
		const tracker = createErrorTracker({ tracer: {} });
		await expect(
			tracker.captureException(new Error('x'))
		).resolves.toBeDefined();
		expect(tracker.metrics().captureErrors).toBe(0);
	});
});

// =============================================================================
// Recent buffer + metrics
// =============================================================================

describe('recent buffer', () => {
	test('captures newest-first', async () => {
		const tracker = createErrorTracker();
		await tracker.captureException(new Error('a'));
		await tracker.captureException(new Error('b'));
		await tracker.captureException(new Error('c'));
		const recent = tracker.recentErrors();
		expect(recent.map((e) => e.message)).toEqual(['c', 'b', 'a']);
	});

	test('LRU caps at maxRecent', async () => {
		const tracker = createErrorTracker({ maxRecent: 2 });
		await tracker.captureException(new Error('a'));
		await tracker.captureException(new Error('b'));
		await tracker.captureException(new Error('c'));
		const recent = tracker.recentErrors();
		expect(recent).toHaveLength(2);
		expect(recent.map((e) => e.message)).toEqual(['c', 'b']);
	});

	test('clearRecent empties the buffer but keeps counters', async () => {
		const tracker = createErrorTracker();
		await tracker.captureException(new Error('a'));
		expect(tracker.recentErrors()).toHaveLength(1);
		tracker.clearRecent();
		expect(tracker.recentErrors()).toHaveLength(0);
		expect(tracker.metrics().captured).toBe(1);
	});
});

describe('metrics', () => {
	test('byFingerprint counts per-fingerprint occurrences', async () => {
		const tracker = createErrorTracker({
			fingerprint: (err) => (err.message === 'a' ? 'fp-a' : 'fp-b')
		});
		await tracker.captureException(new Error('a'));
		await tracker.captureException(new Error('a'));
		await tracker.captureException(new Error('b'));
		const m = tracker.metrics();
		expect(m.captured).toBe(3);
		expect(m.byFingerprint['fp-a']).toBe(2);
		expect(m.byFingerprint['fp-b']).toBe(1);
	});

	test('byFingerprint caps at maxFingerprints to bound memory', async () => {
		let counter = 0;
		const tracker = createErrorTracker({
			fingerprint: () => `unique-${counter++}`,
			maxFingerprints: 3
		});
		for (let i = 0; i < 10; i += 1) {
			await tracker.captureException(new Error('x'));
		}
		const m = tracker.metrics();
		expect(Object.keys(m.byFingerprint).length).toBeLessThanOrEqual(3);
		expect(m.captured).toBe(10);
	});

	test('clock override is used for `at`', async () => {
		const tracker = createErrorTracker({ clock: () => 12345 });
		await tracker.captureException(new Error('a'));
		expect(tracker.recentErrors()[0]?.at).toBe(12345);
	});
});

// =============================================================================
// Composition: audit + tracer together
// =============================================================================

describe('composition', () => {
	test('audit + tracer both fire on capture', async () => {
		const { audit, events } = makeAudit();
		const { tracer, spans } = makeTracer();
		const tracker = createErrorTracker({
			audit,
			environment: 'production',
			release: 'v1.0.0',
			tracer
		});
		const fp = await tracker.captureException(new Error('boom'), {
			tenant: 'acme'
		});
		expect(events).toHaveLength(1);
		expect(spans).toHaveLength(1);
		expect(events[0]?.metadata?.fingerprint).toBe(fp);
		expect(spans[0]?.exception).toBeInstanceOf(Error);
	});
});
