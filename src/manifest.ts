import {
  defineImplementation,
  defineManifest,
  toolFactory,
} from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import type {
  ErrorTracker,
  ErrorTrackerOptions,
  MemoryIssueStoreOptions,
} from "./index";

const tool = toolFactory<ErrorTracker>();

/* Serializable subset of ErrorTrackerOptions: tags + buffer caps. `store` is
 * instance-valued → the `store` slot; `audit` / `tracer` / `fingerprint` /
 * `onIssue` / `clock` are function-or-instance-valued → wiring concerns,
 * never settings. */
const settings = Type.Object({
  environment: Type.Optional(
    Type.String({
      description:
        "Tag every error with the environment it happened in, so production issues are never mixed up with staging noise.",
      examples: ["production"],
      title: "Environment",
    }),
  ),
  maxFingerprints: Type.Optional(
    Type.Integer({
      description:
        "Cap on distinct error groups counted in memory — bounds memory if an attacker synthesizes unique errors. Default 1000.",
      minimum: 1,
      title: "Distinct error groups tracked",
      "x-group": "advanced",
    }),
  ),
  maxRecent: Type.Optional(
    Type.Integer({
      description:
        "How many recent captures are kept in the in-process buffer for quick inspection. Default 100.",
      minimum: 1,
      title: "Recent errors kept in memory",
      "x-group": "advanced",
    }),
  ),
  project: Type.Optional(
    Type.String({
      description:
        "Scopes issues when several apps share one issue store. Default 'default'.",
      title: "Project name",
    }),
  ),
  release: Type.Optional(
    Type.String({
      description:
        "Deploy version tag — lets you see exactly which release introduced an error.",
      examples: ["2026.07.12"],
      title: "Release version",
    }),
  ),
});

export const manifest = defineManifest<ErrorTrackerOptions, ErrorTracker>()({
  contract: 2,
  identity: {
    accent: "#ef4444",
    category: "observability",
    description:
      "Effect-native, Sentry-equivalent exception capture. `createErrorTracker()` groups errors into issues (new/regression detection, severity escalation) and fans out to audit + tracing + a durable issue store; `/ingest` receives batched browser envelopes from `@absolutejs/beacon` (coalescing buffer, schema-validated); `/symbolicate` rewrites minified stacks against source maps. No vendor lock-in.",
    docsUrl: "https://github.com/absolutejs/errors",
    name: "@absolutejs/errors",
    tagline: "See every error on your site, with the exact line of code.",
  },
  implements: [
    defineImplementation<MemoryIssueStoreOptions>()({
      contract: "errors/issue-store",
      factory: "createMemoryIssueStore",
      from: "@absolutejs/errors",
      settings: Type.Object({
        maxEventsPerIssue: Type.Optional(
          Type.Integer({
            default: 50,
            description:
              "How many raw occurrences are kept per issue, newest first.",
            minimum: 1,
            title: "Occurrences kept per issue",
          }),
        ),
        maxIssues: Type.Optional(
          Type.Integer({
            default: 10000,
            description:
              "Cap on grouped issues held in memory; the least-recently-seen issue is evicted past it.",
            minimum: 1,
            title: "Issues kept in memory",
          }),
        ),
      }),
      title: "In memory (development only — issues reset on restart)",
      wiring: {
        code: "createMemoryIssueStore(${settings})",
        imports: [
          { from: "@absolutejs/errors", names: ["createMemoryIssueStore"] },
        ],
      },
    }),
  ],
  requires: {
    peers: [
      {
        name: "effect",
        range: ">=3.22.0 <4",
        reason: "Effect runtime — capture() returns typed Effect values",
      },
      {
        name: "elysia",
        range: ">=1.4.29 <2",
        reason: "only needed for the combined server and browser error plugin",
      },
    ],
  },
  settings,
  slots: {
    store: {
      configPath: "store",
      contract: "errors/issue-store",
      description: "Where grouped issues and their occurrences are stored",
      known: ["@absolutejs/errors#memory", "@absolutejs/errors-postgres"],
      required: true,
    },
  },
  tools: {
    error_detail: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "admin",
        effects: ["read"],
        requiredScopes: ["errors:read"],
        resource: { idField: "fingerprint", type: "error-issue" },
      },
      description:
        "Full detail (stack trace, tags, context) for the most recent capture of one fingerprint, from the in-process buffer.",
      handler: ({ fingerprint }, tracker) => {
        const match = tracker
          .recentErrors()
          .find((event) => event.fingerprint === fingerprint);

        return match === undefined
          ? `no recent capture with fingerprint "${fingerprint}" — it may have aged out of the in-process buffer`
          : JSON.stringify(match);
      },
      input: Type.Object({ fingerprint: Type.String({ minLength: 1 }) }),
    }),
    error_stats: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "admin",
        effects: ["read"],
        requiredScopes: ["errors:read"],
      },
      description:
        "Capture counters since the server started: total captures, per-sink failures, and occurrence counts per error fingerprint.",
      handler: (_input, tracker) => JSON.stringify(tracker.metrics()),
      input: Type.Object({}),
    }),
    issue_events: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "admin",
        effects: ["read"],
        requiredScopes: ["errors:read"],
        resource: {
          idField: "fingerprint",
          tenantIdField: "project",
          type: "error-issue",
        },
      },
      description:
        "Read a bounded durable event timeline for one project-scoped issue, including its already-redacted stack, tags, trace, and replay correlation.",
      handler: async ({ fingerprint, limit, project }, tracker) => {
        if (!tracker.store?.listEvents)
          return "durable issue event storage is unavailable";
        const events = await Effect.runPromise(
          tracker.store.listEvents(project, fingerprint, limit ?? 20),
        );

        return JSON.stringify(events);
      },
      input: Type.Object(
        {
          fingerprint: Type.String({ maxLength: 128, minLength: 1 }),
          limit: Type.Optional(
            Type.Integer({ default: 20, maximum: 100, minimum: 1 }),
          ),
          project: Type.String({ maxLength: 255, minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    }),
    list_issues: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "admin",
        effects: ["read"],
        requiredScopes: ["errors:read"],
      },
      description:
        "List bounded durable grouped issues across every project or one exact project. Results contain issue metadata, not raw event context.",
      handler: async (
        { environment, limit, project, query, state },
        tracker,
      ) => {
        if (!tracker.store?.listIssues)
          return "durable issue list storage is unavailable";
        const issues = await Effect.runPromise(
          tracker.store.listIssues({
            ...(environment ? { environment } : {}),
            limit: limit ?? 20,
            ...(project ? { project } : {}),
            ...(query ? { query } : {}),
            ...(state ? { state } : {}),
          }),
        );

        return JSON.stringify(issues);
      },
      input: Type.Object(
        {
          environment: Type.Optional(
            Type.String({ maxLength: 64, minLength: 1 }),
          ),
          limit: Type.Optional(
            Type.Integer({ default: 20, maximum: 100, minimum: 1 }),
          ),
          project: Type.Optional(Type.String({ maxLength: 255, minLength: 1 })),
          query: Type.Optional(Type.String({ maxLength: 255, minLength: 1 })),
          state: Type.Optional(
            Type.Union([
              Type.Literal("ignored"),
              Type.Literal("resolved"),
              Type.Literal("unresolved"),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
    }),
    list_recent_errors: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "admin",
        effects: ["read"],
        requiredScopes: ["errors:read"],
      },
      description:
        "List the most recently captured errors (newest first): fingerprint, name, message, level, and when. Use error_detail for the stack trace.",
      handler: ({ limit }, tracker) => {
        const recent = tracker.recentErrors().slice(0, limit ?? 20);
        if (recent.length === 0) {
          return "no errors captured since the server started";
        }

        return JSON.stringify(
          recent.map((event) => ({
            at: new Date(event.at).toISOString(),
            fingerprint: event.fingerprint,
            level: event.context.level ?? "error",
            message: event.message,
            name: event.name,
          })),
        );
      },
      input: Type.Object({
        limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
      }),
    }),
    set_issue_state: tool.runtime({
      annotations: { idempotentHint: true },
      authorization: {
        approval: "policy",
        audience: "admin",
        effects: ["write"],
        idempotency: { mode: "host" },
        requiredScopes: ["errors:write"],
        resource: {
          idField: "fingerprint",
          tenantIdField: "project",
          type: "error-issue",
        },
        reversible: false,
      },
      description:
        "Resolve, ignore, or reopen one exact durable issue after policy approval. Evidence remains immutable and a recurrence can still reopen a resolved issue.",
      handler: async ({ fingerprint, project, state }, tracker) => {
        if (!tracker.store?.setState)
          return "durable issue state storage is unavailable";
        await Effect.runPromise(
          tracker.store.setState(project, fingerprint, state),
        );

        return JSON.stringify({ fingerprint, project, state });
      },
      input: Type.Object(
        {
          fingerprint: Type.String({ maxLength: 128, minLength: 1 }),
          project: Type.String({ maxLength: 255, minLength: 1 }),
          reason: Type.String({ maxLength: 500, minLength: 8 }),
          state: Type.Union([
            Type.Literal("ignored"),
            Type.Literal("resolved"),
            Type.Literal("unresolved"),
          ]),
        },
        { additionalProperties: false },
      ),
    }),
  },
  wiring: [
    {
      id: "default",
      server: {
        code: "const errorTracker = createErrorTracker({ store: ${slot.store}, ...${settings} });",
        imports: [
          { from: "@absolutejs/errors", names: ["createErrorTracker"] },
        ],
        placement: "module-scope",
      },
      title: "Create the error tracker",
    },
    {
      description:
        "Captures Elysia request failures and accepts batched error envelopes from @absolutejs/beacon through one server plugin.",
      id: "elysia",
      server: {
        code: ".use(errorsPlugin({ tracker: errorTracker, ingest: { store: ${slot.store} } }))",
        imports: [
          { from: "@absolutejs/errors/elysia", names: ["errorsPlugin"] },
        ],
        placement: "server-plugin",
      },
      title: "Capture server and browser errors",
    },
  ],
});
