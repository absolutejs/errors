/**
 * Server-only Elysia integration for `@absolutejs/errors`.
 *
 * This entry point is isolated from the package root and every browser entry.
 * It is the single public Elysia plugin for request errors and browser ingest.
 */
import { Elysia } from "elysia";
import { Effect, Either } from "effect";
import type {
  ErrorTracker,
  IssueStore,
  IssueStoreError,
  IssueUpsertResult,
  StoredEvent,
} from "./index";
import {
  createDrainer,
  createInMemoryEventBuffer,
  createIngestEndpoint,
  ingestRejectionStatus,
  type EventBuffer,
  type IngestAuthorizer,
  type InMemoryEventBufferOptions,
} from "./ingest";
import {
  browserReportsEnvelope,
  type BrowserReportingOptions,
} from "./reporting";
import {
  handledError,
  mountServerErrorBoundary,
  type ErrorsCapture,
  type ErrorsCaptureContext,
  type ErrorsServerContext,
  type ServerBoundaryOptions,
} from "./elysia-server";

export { handledError };
export type { ErrorsCapture, ErrorsCaptureContext, ErrorsServerContext };

export type ErrorsPluginTracker = Pick<
  ErrorTracker,
  "captureException" | "store"
>;

export type ErrorsPluginServerOptions = Omit<
  ServerBoundaryOptions,
  "capture"
> & {
  /** Defaults to `tracker.captureException`. */
  capture?: ErrorsCapture;
};

export type ErrorsPluginIngestOptions = InMemoryEventBufferOptions & {
  /** Defaults to the store configured on `tracker`. */
  store?: IssueStore;
  buffer?: EventBuffer;
  /** Route path. Default `/ingest`. */
  path?: string;
  authorize?: IngestAuthorizer;
  maxBytes?: number;
  maxEvents?: number;
  intervalMs?: number;
  prepare?: (event: StoredEvent) => Effect.Effect<StoredEvent>;
  onIssue?: (result: IssueUpsertResult) => void | Promise<void>;
  onError?: (error: IssueStoreError) => void;
  /** Browser Reporting API receiver. This is the only path that can receive
   * crash reports because page JavaScript is gone when a browser crashes. */
  reporting?:
    | false
    | (BrowserReportingOptions & {
        /** Route path. Default `/ingest/reports`. */
        path?: string;
        /** Optional dedicated authorization for browser-generated reports. */
        authorize?: IngestAuthorizer;
      });
};

export type ErrorsPluginOptions = {
  /**
   * Supplies the default server capture edge and ingest store. Optional when
   * the enabled sections provide those values directly.
   */
  tracker?: ErrorsPluginTracker;
  /**
   * Request-error settings. Enabled by default; set `false` to install no
   * request boundary.
   */
  server?: false | ErrorsPluginServerOptions;
  /**
   * Browser-event ingest settings. Omitted/false means no route is opened.
   */
  ingest?: false | ErrorsPluginIngestOptions;
};

type IngestContext = {
  body: unknown;
  headers: Record<string, string | undefined>;
  set: { status?: number };
};

const mountBrowserIngest = (
  app: Elysia,
  options: ErrorsPluginIngestOptions,
  store: IssueStore,
) => {
  const buffer = options.buffer ?? createInMemoryEventBuffer(options);
  const endpoint = createIngestEndpoint({
    buffer,
    ...(options.authorize !== undefined
      ? { authorize: options.authorize }
      : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxEvents !== undefined
      ? { maxEvents: options.maxEvents }
      : {}),
  });
  const reporting = options.reporting;
  const reportingEndpoint =
    reporting === undefined || reporting === false
      ? undefined
      : createIngestEndpoint({
          buffer,
          ...(reporting.authorize === undefined
            ? {}
            : { authorize: reporting.authorize }),
          ...(options.maxBytes !== undefined
            ? { maxBytes: options.maxBytes }
            : {}),
          ...(options.maxEvents !== undefined
            ? { maxEvents: options.maxEvents }
            : {}),
        });
  const drainer = createDrainer({
    buffer,
    store,
    ...(options.intervalMs !== undefined
      ? { intervalMs: options.intervalMs }
      : {}),
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
    ...(options.maxSamplesPerGroup !== undefined
      ? { maxSamplesPerGroup: options.maxSamplesPerGroup }
      : {}),
    ...(options.onIssue !== undefined ? { onIssue: options.onIssue } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  let mounted = app.post(options.path ?? "/ingest", async (rawContext) => {
    const context = rawContext as unknown as IngestContext;
    const lengthHeader = context.headers["content-length"];
    const bytes = lengthHeader !== undefined ? Number(lengthHeader) : undefined;
    const key = context.headers["x-beacon-key"];
    const outcome = await Effect.runPromise(
      Effect.either(
        endpoint.ingest({
          body: context.body,
          ...(bytes !== undefined && !Number.isNaN(bytes) ? { bytes } : {}),
          ...(key !== undefined ? { key } : {}),
        }),
      ),
    );
    if (Either.isRight(outcome)) {
      context.set.status = 202;
      return outcome.right;
    }
    context.set.status = ingestRejectionStatus(outcome.left);
    return { error: outcome.left._tag };
  });

  if (
    reporting !== undefined &&
    reporting !== false &&
    reportingEndpoint !== undefined
  ) {
    mounted = mounted.post(
      reporting.path ?? "/ingest/reports",
      { parse: "text" },
      async (rawContext) => {
        const context = rawContext as unknown as IngestContext;
        const envelope = browserReportsEnvelope(context.body, reporting);
        if (envelope === null) {
          context.set.status = 400;
          return { error: "InvalidBrowserReport" };
        }
        const lengthHeader = context.headers["content-length"];
        const bytes =
          lengthHeader === undefined ? undefined : Number(lengthHeader);
        const key = context.headers["x-beacon-key"];
        const outcome = await Effect.runPromise(
          Effect.either(
            reportingEndpoint.ingest({
              body: envelope,
              ...(bytes !== undefined && !Number.isNaN(bytes) ? { bytes } : {}),
              ...(key === undefined ? {} : { key }),
            }),
          ),
        );
        if (Either.isRight(outcome)) {
          context.set.status = 202;
          return outcome.right;
        }
        context.set.status = ingestRejectionStatus(outcome.left);
        return { error: outcome.left._tag };
      },
    );
  }

  return mounted.cleanup(async () => {
    await drainer.stop();
  });
};

/**
 * The only Elysia plugin exported by `@absolutejs/errors`.
 *
 * It can capture server request failures, receive browser events, or do both.
 * Each section is configured independently through one plugin invocation.
 */
export const errorsPlugin = (options: ErrorsPluginOptions) => {
  let app = new Elysia({ name: "@absolutejs/errors" });

  if (options.server !== false) {
    const server = options.server ?? {};
    const capture = server.capture ?? options.tracker?.captureException;
    if (capture === undefined) {
      throw new Error(
        "@absolutejs/errors errorsPlugin requires server.capture or tracker when server capture is enabled",
      );
    }
    app = mountServerErrorBoundary(app, { ...server, capture });
  }

  if (options.ingest !== undefined && options.ingest !== false) {
    const store = options.ingest.store ?? options.tracker?.store;
    if (store === undefined) {
      throw new Error(
        "@absolutejs/errors errorsPlugin requires ingest.store or a store configured on tracker when ingest is enabled",
      );
    }
    app = mountBrowserIngest(app, options.ingest, store);
  }

  return app;
};
